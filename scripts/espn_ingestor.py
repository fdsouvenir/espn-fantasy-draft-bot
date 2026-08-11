#!/usr/bin/env python3
"""Pure ESPN draft normalization and replay state.

The live transport (CDP, HTTP, authentication, retry policy) intentionally does
not live here.  An adapter supplies an already-decoded ``mDraftDetail`` payload
plus safe request timing metadata; this module emits a deterministic, redacted
change stream and maintains a restartable checkpoint.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping


SCHEMA_VERSION = 1
EMPTY_PLAYER_ID = -1
PHASE_PRE_DRAFT = "pre_draft"
PHASE_ACTIVE = "active"
PHASE_COMPLETED = "completed"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _integer(value: Any, *, minimum: int | None = None) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        result = int(value)
    except (TypeError, ValueError):
        return None
    if minimum is not None and result < minimum:
        return None
    return result


def is_filled_pick(pick: Mapping[str, Any]) -> bool:
    """ESPN reserves exactly ``-1`` for an empty slot.

    Other negative IDs are real selections (notably NFL team defenses).
    Missing and malformed IDs are not selections.
    """

    player_id = _integer(pick.get("playerId"))
    return player_id is not None and player_id != EMPTY_PLAYER_ID


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def stable_pick_key(draft_key: str, overall_pick: int) -> str:
    return f"{draft_key}:pick:{overall_pick}"


def deterministic_event_id(event_type: str, draft_key: str, payload: Mapping[str, Any]) -> str:
    material = {"schemaVersion": SCHEMA_VERSION, "type": event_type, "draftKey": draft_key, "payload": payload}
    return f"evt_{_digest(material)[:32]}"


def normalize_request_timing(metadata: Mapping[str, Any] | None) -> dict[str, Any]:
    """Whitelist non-secret request telemetry.

    Headers, cookies, URLs, bodies, and arbitrary adapter metadata are never
    copied.  Duration may be supplied directly or derived from monotonic times.
    """

    metadata = metadata or {}
    duration = metadata.get("durationMs")
    if duration is None:
        started = metadata.get("startedMonotonic")
        completed = metadata.get("completedMonotonic")
        if isinstance(started, (int, float)) and isinstance(completed, (int, float)):
            duration = max(0.0, (completed - started) * 1000)
    result: dict[str, Any] = {}
    if isinstance(duration, (int, float)) and not isinstance(duration, bool):
        result["durationMs"] = round(max(0.0, float(duration)), 3)
    status = _integer(metadata.get("httpStatus"), minimum=100)
    if status is not None and status <= 599:
        result["httpStatus"] = status
    attempt = _integer(metadata.get("attempt"), minimum=1)
    if attempt is not None:
        result["attempt"] = attempt
    return result


def _normalize_pick(raw: Mapping[str, Any]) -> dict[str, Any] | None:
    overall = _integer(raw.get("overallPickNumber"), minimum=1)
    if overall is None:
        return None
    player_id = _integer(raw.get("playerId"))
    round_number = _integer(raw.get("roundId"), minimum=1)
    round_pick = _integer(raw.get("roundPickNumber"), minimum=1)
    team_id = _integer(raw.get("teamId"))
    return {
        "overallPick": overall,
        "round": round_number,
        "roundPick": round_pick,
        "teamId": str(team_id) if team_id is not None else None,
        "playerId": str(player_id) if player_id is not None else None,
        "filled": player_id is not None and player_id != EMPTY_PLAYER_ID,
    }


def normalize_draft_detail(
    raw_payload: Mapping[str, Any],
    *,
    draft_key: str,
    captured_at: str,
    request_timing: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Return the strict, redacted snapshot consumed by :class:`CollectorState`."""

    detail = raw_payload.get("draftDetail", raw_payload)
    if not isinstance(detail, Mapping):
        raise ValueError("payload does not contain a draftDetail object")
    raw_picks = detail.get("picks", [])
    if not isinstance(raw_picks, list):
        raise ValueError("draftDetail.picks must be a list")
    picks = []
    seen_overall: set[int] = set()
    for raw in raw_picks:
        if not isinstance(raw, Mapping):
            continue
        pick = _normalize_pick(raw)
        if pick is None:
            continue
        if pick["overallPick"] in seen_overall:
            raise ValueError(f"duplicate overall pick {pick['overallPick']}")
        seen_overall.add(pick["overallPick"])
        picks.append(pick)
    picks.sort(key=lambda item: item["overallPick"])

    declared_complete = bool(detail.get("drafted"))
    in_progress = bool(detail.get("inProgress"))
    total_picks = len(picks)
    filled_count = sum(1 for pick in picks if pick["filled"])
    board_complete = total_picks > 0 and filled_count == total_picks
    if declared_complete or board_complete:
        phase = PHASE_COMPLETED
    elif in_progress:
        phase = PHASE_ACTIVE
    else:
        phase = PHASE_PRE_DRAFT
    missing = [pick["overallPick"] for pick in picks if not pick["filled"]]
    normalized = {
        "schemaVersion": SCHEMA_VERSION,
        "draftKey": draft_key,
        "capturedAt": captured_at,
        "phase": phase,
        "declaredComplete": declared_complete,
        "boardComplete": board_complete,
        "totalPicks": total_picks,
        "filledPicks": filled_count,
        "missingOverallPicks": missing,
        "picks": picks,
        "request": normalize_request_timing(request_timing),
    }
    # Digest deliberately excludes observation time and request latency so an
    # unchanged poll deduplicates even though its telemetry differs.
    normalized["stateSha256"] = _digest(
        {key: value for key, value in normalized.items() if key not in {"capturedAt", "request", "stateSha256"}}
    )
    return normalized


def _pick_event_payload(pick: Mapping[str, Any]) -> dict[str, Any]:
    return {key: pick.get(key) for key in ("overallPick", "round", "roundPick", "teamId", "playerId")}


@dataclass
class CollectorState:
    """Restartable reducer that compares complete ESPN snapshots."""

    draft_key: str
    revision: int = 0
    phase: str | None = None
    completed: bool = False
    picks: dict[int, dict[str, Any]] = field(default_factory=dict)
    last_state_sha256: str | None = None

    def _emit(self, event_type: str, captured_at: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.revision += 1
        return {
            "schemaVersion": SCHEMA_VERSION,
            "eventId": deterministic_event_id(event_type, self.draft_key, payload),
            "type": event_type,
            "draftKey": self.draft_key,
            "revision": self.revision,
            "capturedAt": captured_at,
            "payload": payload,
        }

    def apply(self, snapshot: Mapping[str, Any]) -> list[dict[str, Any]]:
        if snapshot.get("schemaVersion") != SCHEMA_VERSION:
            raise ValueError("unsupported snapshot schema version")
        if snapshot.get("draftKey") != self.draft_key:
            raise ValueError("snapshot draftKey does not match collector state")
        state_hash = snapshot.get("stateSha256")
        if state_hash == self.last_state_sha256:
            return []

        captured_at = str(snapshot["capturedAt"])
        events: list[dict[str, Any]] = []
        current: dict[int, dict[str, Any]] = {
            int(pick["overallPick"]): dict(pick)
            for pick in snapshot.get("picks", [])
            if pick.get("filled")
        }

        # Because every poll is a complete board, a jump from pick N to N+k is
        # naturally reconstructed as k ordered insertions, including after a
        # restart from a persisted checkpoint.
        for overall in sorted(set(self.picks) | set(current)):
            before = self.picks.get(overall)
            after = current.get(overall)
            if before == after:
                continue
            pick_key = stable_pick_key(self.draft_key, overall)
            if before is None and after is not None:
                payload = {"pickKey": pick_key, "pick": _pick_event_payload(after)}
                events.append(self._emit("pick.inserted", captured_at, payload))
            else:
                payload = {
                    "pickKey": pick_key,
                    "before": _pick_event_payload(before) if before is not None else None,
                    "after": _pick_event_payload(after) if after is not None else None,
                }
                events.append(self._emit("pick.corrected", captured_at, payload))

        next_phase = str(snapshot["phase"])
        if next_phase != self.phase:
            payload = {"before": self.phase, "after": next_phase}
            events.append(self._emit("draft.phase_changed", captured_at, payload))

        next_completed = next_phase == PHASE_COMPLETED
        if next_completed and not self.completed:
            payload = {
                "declaredComplete": bool(snapshot.get("declaredComplete")),
                "boardComplete": bool(snapshot.get("boardComplete")),
                "filledPicks": int(snapshot.get("filledPicks", 0)),
                "totalPicks": int(snapshot.get("totalPicks", 0)),
                "missingOverallPicks": list(snapshot.get("missingOverallPicks", [])),
            }
            events.append(self._emit("draft.completed", captured_at, payload))

        self.picks = current
        self.phase = next_phase
        self.completed = next_completed
        self.last_state_sha256 = str(state_hash)
        return events

    def checkpoint(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "draftKey": self.draft_key,
            "revision": self.revision,
            "phase": self.phase,
            "completed": self.completed,
            "lastStateSha256": self.last_state_sha256,
            "picks": [self.picks[key] for key in sorted(self.picks)],
        }

    @classmethod
    def from_checkpoint(cls, payload: Mapping[str, Any]) -> "CollectorState":
        if payload.get("schemaVersion") != SCHEMA_VERSION:
            raise ValueError("unsupported checkpoint schema version")
        draft_key = payload.get("draftKey")
        if not isinstance(draft_key, str) or not draft_key:
            raise ValueError("checkpoint draftKey is required")
        state = cls(
            draft_key=draft_key,
            revision=int(payload.get("revision", 0)),
            phase=payload.get("phase"),
            completed=bool(payload.get("completed")),
            last_state_sha256=payload.get("lastStateSha256"),
        )
        for raw in payload.get("picks", []):
            pick = dict(raw)
            state.picks[int(pick["overallPick"])] = pick
        return state


def lifecycle_record(
    lifecycle: str,
    *,
    draft_key: str,
    instance_id: str,
    captured_at: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    if lifecycle not in {"started", "stopping", "stopped", "failed"}:
        raise ValueError("unsupported lifecycle state")
    payload: dict[str, Any] = {"state": lifecycle, "instanceId": instance_id}
    if reason:
        payload["reason"] = reason[:240]
    captured_at = captured_at or utc_now()
    return {
        "schemaVersion": SCHEMA_VERSION,
        "eventId": deterministic_event_id("collector.lifecycle", draft_key, payload),
        "type": "collector.lifecycle",
        "draftKey": draft_key,
        "capturedAt": captured_at,
        "payload": payload,
    }


def atomic_write_checkpoint(path: Path, payload: Mapping[str, Any]) -> None:
    """Atomically replace a checkpoint and enforce mode 0600."""

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def load_checkpoint(path: Path) -> dict[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("checkpoint must be a JSON object")
    return payload


def append_ndjson(path: Path, records: Iterable[Mapping[str, Any]]) -> None:
    """Append complete owner-only NDJSON records with one OS write each."""

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_APPEND | os.O_CREAT | os.O_WRONLY
    fd = os.open(path, flags, 0o600)
    try:
        os.fchmod(fd, 0o600)
        for record in records:
            encoded = (_canonical(record) + "\n").encode("utf-8")
            view = memoryview(encoded)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise OSError("short NDJSON write")
                view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
