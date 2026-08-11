#!/usr/bin/env python3
"""Read-only ESPN draft poller and signed Worker ingestor.

Secrets are accepted only through environment variables and are never included
in logs, checkpoints, exceptions, or request URLs.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import hmac
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from espn_ingestor import (
    CollectorState,
    PHASE_ACTIVE,
    PHASE_COMPLETED,
    atomic_write_checkpoint,
    load_checkpoint,
    normalize_draft_detail,
    utc_now,
)


USER_AGENT = "FDS-ESPN-Draft-Helper/1.0"
TRANSIENT_HTTP = {408, 425, 429, 500, 502, 503, 504}
MAX_INIT_BYTES = 2 * 1024 * 1024


class TransportError(RuntimeError):
    """A sanitized transport failure safe to include in lifecycle logs."""

    def __init__(self, operation: str, status: int | None = None, transient: bool = False):
        super().__init__(f"{operation}_{status if status is not None else 'network_error'}")
        self.operation = operation
        self.status = status
        self.transient = transient


class HttpTransport(Protocol):
    def get_json(self, url: str, headers: Mapping[str, str], timeout: float) -> Mapping[str, Any]: ...

    def post_json(
        self, url: str, headers: Mapping[str, str], body: bytes, timeout: float
    ) -> Mapping[str, Any]: ...


class UrllibTransport:
    """Small stdlib transport that never exposes response bodies in errors."""

    @staticmethod
    def _request(request: urllib.request.Request, timeout: float, operation: str) -> Mapping[str, Any]:
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            raise TransportError(operation, error.code, error.code in TRANSIENT_HTTP) from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise TransportError(operation, transient=True) from None
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            raise TransportError(operation, transient=False) from None
        if not isinstance(payload, Mapping):
            raise TransportError(operation, transient=False)
        return payload

    def get_json(self, url: str, headers: Mapping[str, str], timeout: float) -> Mapping[str, Any]:
        request = urllib.request.Request(url, headers=dict(headers), method="GET")
        return self._request(request, timeout, "espn_read")

    def post_json(
        self, url: str, headers: Mapping[str, str], body: bytes, timeout: float
    ) -> Mapping[str, Any]:
        request = urllib.request.Request(url, data=body, headers=dict(headers), method="POST")
        return self._request(request, timeout, "worker_ingest")


def espn_url(season: int, league_id: str) -> str:
    league = urllib.parse.quote(str(league_id), safe="")
    return (
        "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/"
        f"seasons/{season}/segments/0/leagues/{league}?view=mDraftDetail"
    )


def worker_action_url(worker_base: str, draft_key: str, action: str) -> tuple[str, str]:
    if action not in {"ingest", "initialize"}:
        raise ValueError("unsupported Worker action")
    base = worker_base.rstrip("/")
    pathname = f"/api/v1/drafts/{urllib.parse.quote(draft_key, safe='')}/{action}"
    return f"{base}{pathname}", pathname


def worker_ingest_url(worker_base: str, draft_key: str) -> tuple[str, str]:
    return worker_action_url(worker_base, draft_key, "ingest")


def espn_headers(espn_s2: str | None, swid: str | None) -> dict[str, str]:
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    cookies = []
    if swid:
        cookies.append(f"SWID={swid}")
    if espn_s2:
        cookies.append(f"espn_s2={espn_s2}")
    if cookies:
        headers["Cookie"] = "; ".join(cookies)
    return headers


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def worker_event_id(draft_key: str, pick: Mapping[str, Any]) -> str:
    identity = {
        "draftKey": draft_key,
        "overallPick": int(pick["overallPick"]),
        "teamId": str(pick["teamId"]),
        "playerId": str(pick["playerId"]),
    }
    return hashlib.sha256(canonical_json(identity)).hexdigest()


def to_worker_event(draft_key: str, pick: Mapping[str, Any], captured_at: str) -> dict[str, Any]:
    required = ("overallPick", "round", "roundPick", "teamId", "playerId")
    if any(pick.get(key) is None for key in required):
        raise ValueError("filled ESPN pick is missing required fields")
    return {
        "schemaVersion": 1,
        "eventId": worker_event_id(draft_key, pick),
        "overallPick": int(pick["overallPick"]),
        "round": int(pick["round"]),
        "roundPick": int(pick["roundPick"]),
        "teamId": str(pick["teamId"]),
        "playerId": str(pick["playerId"]),
        "source": "espn",
        "providerObservedAt": None,
        "ingestorObservedAt": captured_at,
    }


def build_batch(
    snapshot: Mapping[str, Any], core_events: list[Mapping[str, Any]], instance_id: str
) -> dict[str, Any]:
    picks: list[Mapping[str, Any]] = []
    for event in core_events:
        if event.get("type") == "pick.inserted":
            picks.append(event["payload"]["pick"])
        elif event.get("type") == "pick.corrected":
            # The Worker intentionally treats a changed pick identity as a
            # conflict. Stop instead of silently rewriting draft history.
            raise RuntimeError("espn_pick_correction_requires_review")
    captured_at = str(snapshot["capturedAt"])
    worker_events = sorted(
        (to_worker_event(str(snapshot["draftKey"]), pick, captured_at) for pick in picks),
        key=lambda event: event["overallPick"],
    )
    filled = [int(pick["overallPick"]) for pick in snapshot.get("picks", []) if pick.get("filled")]
    cursor = max(filled, default=0)
    if snapshot.get("phase") == PHASE_COMPLETED:
        # A completion cursor covers trailing empty slots as well as internal
        # gaps, allowing the Worker health endpoint to report either case.
        cursor = int(snapshot.get("totalPicks", cursor))
    return {
        "schemaVersion": 1,
        "draftKey": snapshot["draftKey"],
        "ingestorInstanceId": instance_id,
        "capturedAt": captured_at,
        "cursor": {"lastOverallPick": cursor},
        "draftState": {
            "inProgress": snapshot.get("phase") == PHASE_ACTIVE,
            "drafted": snapshot.get("phase") == PHASE_COMPLETED,
            "totalPickSlots": int(snapshot["totalPicks"]),
        },
        "events": worker_events,
    }


def split_batch(batch: Mapping[str, Any], max_events: int = 100) -> list[dict[str, Any]]:
    """Split a recovered board into Worker-contract-sized ordered batches."""

    events = list(batch.get("events", []))
    if not events:
        return [dict(batch)]
    parts = []
    for index in range(0, len(events), max_events):
        part_events = events[index:index + max_events]
        part = {**batch, "events": part_events}
        # Do not advertise picks that a later part has not delivered yet. The
        # final part retains the full source cursor (including trailing gaps).
        if index + max_events < len(events):
            part["cursor"] = {"lastOverallPick": int(part_events[-1]["overallPick"])}
        parts.append(part)
    return parts


def snapshot_worker_events(snapshot: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Materialize the complete filled board for deterministic gap recovery."""

    captured_at = str(snapshot["capturedAt"])
    return [
        to_worker_event(str(snapshot["draftKey"]), pick, captured_at)
        for pick in snapshot.get("picks", [])
        if pick.get("filled")
    ]


def validate_ingest_ack(ack: Mapping[str, Any], batch: Mapping[str, Any]) -> dict[str, Any]:
    """Validate the complete Worker acknowledgement without exposing its body."""

    if not isinstance(ack, Mapping):
        raise RuntimeError("worker_ingest_invalid_ack")

    def integer(name: str, minimum: int = 0) -> int:
        value = ack.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
            raise RuntimeError("worker_ingest_invalid_ack")
        return value

    revision = integer("revision")
    accepted = integer("accepted")
    deduped = integer("deduped")
    last_overall = integer("lastOverallPick")
    missing = ack.get("missingOverallPicks")
    server_time = ack.get("serverTime")
    if not isinstance(missing, list) or any(
        isinstance(value, bool) or not isinstance(value, int) for value in missing
    ):
        raise RuntimeError("worker_ingest_invalid_ack")
    if missing != sorted(set(missing)) or any(value < 1 or value > last_overall for value in missing):
        raise RuntimeError("worker_ingest_invalid_ack")
    if not isinstance(server_time, str):
        raise RuntimeError("worker_ingest_invalid_ack")
    try:
        parsed_time = datetime.fromisoformat(server_time.replace("Z", "+00:00"))
    except ValueError:
        raise RuntimeError("worker_ingest_invalid_ack") from None
    if parsed_time.tzinfo is None:
        raise RuntimeError("worker_ingest_invalid_ack")

    event_count = len(batch.get("events", []))
    if accepted + deduped != event_count:
        raise RuntimeError("worker_ingest_partial_ack")
    cursor = batch.get("cursor", {}).get("lastOverallPick")
    if isinstance(cursor, bool) or not isinstance(cursor, int) or last_overall < cursor:
        raise RuntimeError("worker_ingest_invalid_ack")
    return {
        "revision": revision,
        "accepted": accepted,
        "deduped": deduped,
        "lastOverallPick": last_overall,
        "missingOverallPicks": missing,
        "serverTime": server_time,
    }


def load_init_payload(path: Path, draft_key: str) -> dict[str, Any]:
    path = Path(path)
    if path.stat().st_size > MAX_INIT_BYTES:
        raise ValueError("initialization file exceeds 2 MiB")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schemaVersion") != 1:
        raise ValueError("initialization file must contain a DraftInitV1 object")
    if payload.get("draftKey") != draft_key:
        raise ValueError("initialization draftKey mismatch")
    return payload


def signed_headers(secret: str, pathname: str, body: bytes, timestamp: int, nonce: str) -> dict[str, str]:
    body_hash = hashlib.sha256(body).hexdigest()
    material = f"{timestamp}\n{nonce}\nPOST\n{pathname}\n{body_hash}".encode("utf-8")
    signature = hmac.new(secret.encode("utf-8"), material, hashlib.sha256).hexdigest()
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Draft-Timestamp": str(timestamp),
        "X-Draft-Nonce": nonce,
        "X-Draft-Signature": f"v1={signature}",
    }


def sanitized_log(event: str, **fields: Any) -> None:
    allowed = {
        "attempt", "delaySeconds", "durationMs", "eventCount", "filledPicks",
        "httpStatus", "instanceId", "reason", "revision", "state", "totalPicks",
    }
    record = {"event": event, "at": utc_now()}
    record.update({key: value for key, value in fields.items() if key in allowed})
    print(json.dumps(record, sort_keys=True, separators=(",", ":")), flush=True)


@dataclass(frozen=True)
class RunnerConfig:
    season: int
    league_id: str
    draft_key: str
    worker_base: str
    checkpoint: Path
    poll_seconds: float = 1.0
    timeout_seconds: float = 10.0
    max_retries: int = 4
    once: bool = False
    fixture: Path | None = None
    init_file: Path | None = None


class LiveRunner:
    def __init__(
        self,
        config: RunnerConfig,
        *,
        secret: str,
        espn_s2: str | None = None,
        swid: str | None = None,
        cf_access_client_id: str | None = None,
        cf_access_client_secret: str | None = None,
        transport: HttpTransport | None = None,
        clock: Callable[[], float] = time.time,
        sleeper: Callable[[float], None] = time.sleep,
        random_uuid: Callable[[], uuid.UUID] = uuid.uuid4,
    ) -> None:
        if len(secret) < 32:
            raise ValueError("INGEST_HMAC_CURRENT must contain at least 32 characters")
        self.config = config
        self.secret = secret
        self.espn_s2 = espn_s2
        self.swid = swid
        self.cf_access_client_id = cf_access_client_id
        self.cf_access_client_secret = cf_access_client_secret
        self.transport = transport or UrllibTransport()
        self.clock = clock
        self.sleeper = sleeper
        self.random_uuid = random_uuid
        self.instance_id = str(random_uuid())
        self.state = self._load_state()

    def _load_state(self) -> CollectorState:
        if not self.config.checkpoint.exists():
            return CollectorState(self.config.draft_key)
        payload = load_checkpoint(self.config.checkpoint)
        state = CollectorState.from_checkpoint(payload)
        if state.draft_key != self.config.draft_key:
            raise ValueError("checkpoint draftKey mismatch")
        return state

    def _retry(self, operation: Callable[[int], Mapping[str, Any]]) -> Mapping[str, Any]:
        for attempt in range(1, self.config.max_retries + 1):
            try:
                return operation(attempt)
            except TransportError as error:
                if not error.transient or attempt >= self.config.max_retries:
                    raise
                delay = min(8.0, 0.5 * (2 ** (attempt - 1)))
                sanitized_log(
                    "retry_scheduled", attempt=attempt, delaySeconds=delay,
                    httpStatus=error.status, reason=error.operation,
                )
                self.sleeper(delay)
        raise AssertionError("unreachable")

    def _fetch(self) -> tuple[Mapping[str, Any], dict[str, Any]]:
        if self.config.fixture is not None:
            payload = json.loads(self.config.fixture.read_text(encoding="utf-8"))
            if not isinstance(payload, Mapping):
                raise ValueError("fixture must contain a JSON object")
            return payload, {"durationMs": 0.0, "httpStatus": 200, "attempt": 1}
        started = time.monotonic()
        attempts = 0

        def request(attempt: int) -> Mapping[str, Any]:
            nonlocal attempts
            attempts = attempt
            return self.transport.get_json(
                espn_url(self.config.season, self.config.league_id),
                espn_headers(self.espn_s2, self.swid),
                self.config.timeout_seconds,
            )

        payload = self._retry(request)
        return payload, {
            "durationMs": (time.monotonic() - started) * 1000,
            "httpStatus": 200,
            "attempt": attempts,
        }

    def _post_action(self, action: str, payload: Mapping[str, Any]) -> Mapping[str, Any]:
        url, pathname = worker_action_url(self.config.worker_base, self.config.draft_key, action)
        body = canonical_json(payload)

        def request(_attempt: int) -> Mapping[str, Any]:
            timestamp = int(self.clock())
            nonce = str(self.random_uuid())
            headers = signed_headers(self.secret, pathname, body, timestamp, nonce)
            if self.cf_access_client_id and self.cf_access_client_secret:
                headers["CF-Access-Client-Id"] = self.cf_access_client_id
                headers["CF-Access-Client-Secret"] = self.cf_access_client_secret
            return self.transport.post_json(
                url,
                headers,
                body,
                self.config.timeout_seconds,
            )

        return self._retry(request)

    def _post(self, batch: Mapping[str, Any]) -> Mapping[str, Any]:
        return self._post_action("ingest", batch)

    def initialize(self) -> None:
        if self.config.init_file is None:
            return
        payload = load_init_payload(self.config.init_file, self.config.draft_key)
        result = self._post_action("initialize", payload)
        if not isinstance(result.get("created"), bool) or not isinstance(result.get("revision"), int):
            raise RuntimeError("worker_initialize_invalid_ack")
        sanitized_log("worker_initialized", revision=result["revision"])

    def _deliver(self, batch: Mapping[str, Any], snapshot: Mapping[str, Any]) -> Mapping[str, Any]:
        """Post a bounded batch and close any recoverable Worker-side gaps."""

        full_events = {
            event["overallPick"]: event for event in snapshot_worker_events(snapshot)
        }
        revision_floor = -1
        final_ack: Mapping[str, Any] | None = None

        def post_one(
            part: Mapping[str, Any], *, recover: bool, require_closed: bool = True
        ) -> Mapping[str, Any]:
            nonlocal revision_floor, final_ack
            ack = validate_ingest_ack(self._post(part), part)
            if ack["revision"] < revision_floor:
                raise RuntimeError("worker_ingest_invalid_ack")
            revision_floor = ack["revision"]
            final_ack = ack
            recoverable = [
                full_events[overall]
                for overall in ack["missingOverallPicks"]
                if overall in full_events
            ]
            if recoverable and recover:
                recovery = {**part, "events": recoverable}
                recovery_parts = split_batch(recovery)
                for index, recovery_part in enumerate(recovery_parts):
                    # The Durable Object keeps a monotonic source cursor. During
                    # a multi-part reset replay, early acknowledgements therefore
                    # still advertise later missing picks. Only the final recovery
                    # part is required to close every recoverable gap.
                    ack = post_one(
                        recovery_part,
                        recover=False,
                        require_closed=index == len(recovery_parts) - 1,
                    )
            # A valid ack cannot continue to call an acknowledged, replayed
            # ESPN selection missing. Empty ESPN slots may remain real gaps.
            if require_closed and any(
                overall in full_events for overall in ack["missingOverallPicks"]
            ):
                raise RuntimeError("worker_ingest_gap_recovery_failed")
            return ack

        for part in split_batch(batch):
            post_one(part, recover=True)
        assert final_ack is not None
        return final_ack

    def poll_once(self) -> bool:
        raw, timing = self._fetch()
        captured_at = utc_now()
        return self.commit_snapshot(raw, captured_at=captured_at, request_timing=timing)

    def commit_snapshot(
        self,
        raw: Mapping[str, Any],
        *,
        captured_at: str,
        request_timing: Mapping[str, Any] | None = None,
    ) -> bool:
        """Atomically deliver an already-observed complete ESPN board.

        The HTTP poller and the live draft-room adapter share this exact
        reducer, acknowledgement, recovery, and checkpoint path.
        """
        snapshot = normalize_draft_detail(
            raw,
            draft_key=self.config.draft_key,
            captured_at=captured_at,
            request_timing=request_timing,
        )
        candidate = CollectorState.from_checkpoint(copy.deepcopy(self.state.checkpoint()))
        core_events = candidate.apply(snapshot)
        # Every successful ESPN observation is also a bounded liveness pulse.
        # This keeps Worker lastIngestAt meaningful and lets an empty heartbeat
        # detect state loss even when ESPN itself has not changed.
        batch = build_batch(snapshot, core_events, self.instance_id)
        ack = self._deliver(batch, snapshot)
        atomic_write_checkpoint(self.config.checkpoint, candidate.checkpoint())
        self.state = candidate
        sanitized_log(
            "poll_committed", eventCount=len(batch["events"]),
            filledPicks=snapshot["filledPicks"], totalPicks=snapshot["totalPicks"],
            revision=ack["revision"],
        )
        return snapshot["phase"] == PHASE_COMPLETED

    def run(self) -> str:
        sanitized_log("runner_lifecycle", state="started", instanceId=self.instance_id)
        reason = "once"
        try:
            self.initialize()
            while True:
                completed = self.poll_once()
                if completed:
                    reason = "completed"
                    break
                if self.config.once:
                    break
                self.sleeper(self.config.poll_seconds)
            sanitized_log("runner_lifecycle", state="stopped", instanceId=self.instance_id, reason=reason)
            return reason
        except BaseException as error:
            sanitized_log(
                "runner_lifecycle", state="failed", instanceId=self.instance_id,
                reason=error.__class__.__name__,
            )
            raise


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read ESPN draft state and ingest signed pick batches")
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--league-id", required=True)
    parser.add_argument("--draft-key", required=True)
    parser.add_argument("--worker-base", required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--poll-seconds", type=float, default=1.0)
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--max-retries", type=int, default=4)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--init-file", type=Path)
    args = parser.parse_args(argv)
    if args.poll_seconds < 0.25 or args.timeout_seconds <= 0 or not 1 <= args.max_retries <= 8:
        parser.error("invalid polling, timeout, or retry bounds")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    secret = os.environ.get("INGEST_HMAC_CURRENT")
    if not secret:
        print("INGEST_HMAC_CURRENT is required", file=sys.stderr)
        return 2
    config = RunnerConfig(
        season=args.season,
        league_id=args.league_id,
        draft_key=args.draft_key,
        worker_base=args.worker_base,
        checkpoint=args.checkpoint,
        poll_seconds=args.poll_seconds,
        timeout_seconds=args.timeout_seconds,
        max_retries=args.max_retries,
        once=args.once,
        fixture=args.fixture,
        init_file=args.init_file,
    )
    runner = LiveRunner(
        config,
        secret=secret,
        espn_s2=os.environ.get("ESPN_S2"),
        swid=os.environ.get("SWID"),
        cf_access_client_id=os.environ.get("CF_ACCESS_CLIENT_ID"),
        cf_access_client_secret=os.environ.get("CF_ACCESS_CLIENT_SECRET"),
    )
    runner.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
