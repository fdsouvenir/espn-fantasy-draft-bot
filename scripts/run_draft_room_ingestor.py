#!/usr/bin/env python3
"""Ingest ESPN's live draft-room stream through an attached Chrome tab.

The adapter reads only an already-authenticated draft room. It never reads
cookies, never persists authentication-bearing socket metadata, and never
sends an ESPN command. INIT frames
recover the complete selected board after a browser reconnect; SELECTED frames
provide pick-by-pick delivery between reconnects.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import websocket

from espn_ingestor import utc_now
from run_live_ingestor import LiveRunner, RunnerConfig


class DecodeError(ValueError):
    pass


DRAFT_KEY = re.compile(
    r"^(?:[A-Za-z0-9._-]+):espn:(?:ffl:)?(?P<season>[0-9]{4}):"
    r"(?P<league>[1-9][0-9]*):[^:]+$"
)


def draft_identity(draft_key: str) -> tuple[int, str]:
    """Return the season and league ID encoded in a validated draft key."""
    match = DRAFT_KEY.fullmatch(draft_key)
    if not match:
        raise ValueError("draftKey does not contain a supported ESPN identity")
    return int(match.group("season")), match.group("league")


class Reader:
    def __init__(self, payload: bytes):
        self.payload = payload
        self.index = 0

    def number(self, size: int) -> int:
        end = self.index + size
        if end > len(self.payload):
            raise DecodeError("truncated INIT frame")
        value = int.from_bytes(self.payload[self.index:end], "big")
        self.index = end
        return value

    def int32(self) -> int:
        value = self.number(4)
        return value - (1 << 32) if value > (1 << 31) else value

    def skip(self, size: int) -> None:
        self.number(size)

    def boolean(self) -> bool:
        return self.number(1) == 1


def _header(reader: Reader, version: int) -> None:
    if reader.int32() != 1 or reader.int32() != version:
        raise DecodeError("unsupported INIT structure")


def _draft_block(reader: Reader) -> None:
    _header(reader, 1)
    reader.int32()
    reader.int32()
    if reader.int32() != 0:
        reader.skip(8)
    for _ in range(5):
        reader.int32()


def _break_schedule(reader: Reader) -> None:
    _header(reader, 1)
    for _ in range(3):
        reader.int32()


def _autodraft_protection(reader: Reader) -> None:
    _header(reader, 1)
    for _ in range(3):
        reader.int32()


def _scoring(reader: Reader) -> None:
    _header(reader, 1)
    reader.int32()
    reader.int32()
    count = reader.int32()
    if not 0 <= count <= 1000:
        raise DecodeError("invalid scoring category count")
    for _ in range(count):
        _header(reader, 3)
        reader.int32()
        reader.int32()
        reader.skip(8)
        reader.boolean()


def _draft_rules(reader: Reader) -> None:
    _header(reader, 2)
    for _ in range(5):
        reader.int32()
    _break_schedule(reader)
    _autodraft_protection(reader)
    for _ in range(4):
        reader.int32()
    for _ in range(4):
        reader.skip(8)
    reader.int32()
    reader.boolean()
    for _ in range(3):
        reader.int32()
    reader.boolean()
    reader.boolean()
    _scoring(reader)
    reader.boolean()


def _position(reader: Reader) -> None:
    _header(reader, 1)
    for _ in range(3):
        reader.int32()


def _slot_position(reader: Reader) -> None:
    _header(reader, 1)
    for _ in range(3):
        reader.int32()


def _slot(reader: Reader) -> None:
    _header(reader, 1)
    for _ in range(3):
        reader.int32()
    count = reader.int32()
    if not 0 <= count <= 100:
        raise DecodeError("invalid slot position count")
    for _ in range(count):
        _slot_position(reader)


def _pick(reader: Reader) -> dict[str, int]:
    _header(reader, 3)
    values = [reader.int32() for _ in range(7)]
    reader.boolean()
    reader.int32()
    reader.int32()
    return {
        "teamId": values[1],
        "pickNumber": values[2],
        "playerId": values[3],
        "slotId": values[4],
    }


def decode_init_picks(message: str) -> list[dict[str, int]]:
    if not message.startswith("INIT "):
        raise DecodeError("not an INIT frame")
    try:
        fields = message.split()
        if len(fields) < 2:
            raise DecodeError("invalid INIT encoding")
        payload = base64.b64decode(fields[1], validate=True)
    except (ValueError, TypeError) as error:
        raise DecodeError("invalid INIT encoding") from error
    reader = Reader(payload)
    _header(reader, 1)
    reader.int32()
    reader.int32()
    _header(reader, 1)
    reader.int32()
    reader.int32()
    reader.int32()
    if reader.int32() != 0:
        reader.skip(8)
    reader.int32()
    _draft_block(reader)
    _draft_rules(reader)
    positions = reader.int32()
    if not 0 <= positions <= 100:
        raise DecodeError("invalid position count")
    for _ in range(positions):
        _position(reader)
    slots = reader.int32()
    if not 0 <= slots <= 100:
        raise DecodeError("invalid slot count")
    for _ in range(slots):
        _slot(reader)
    count = reader.int32()
    if not 0 <= count <= 1000:
        raise DecodeError("invalid pick count")
    slots = [_pick(reader) for _ in range(count)]
    if [pick["pickNumber"] for pick in slots] != list(range(1, count + 1)):
        raise DecodeError("INIT picks are not contiguous")
    return [pick for pick in slots if pick["playerId"] != -1]


def selected_frame(message: str) -> tuple[int, int, int] | None:
    fields = message.split()
    if not fields or fields[0] != "SELECTED":
        return None
    if len(fields) != 4:
        raise DecodeError("invalid SELECTED frame")
    try:
        return int(fields[1]), int(fields[2]), int(fields[3])
    except ValueError as error:
        raise DecodeError("invalid SELECTED frame") from error


def iso_from_epoch_ms(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return utc_now()
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def raw_board(init: dict[str, Any], picks: dict[int, dict[str, int]], *, complete: bool) -> dict[str, Any]:
    teams = init["draftSlotTeamIds"]
    team_count = init["expectedTeams"]
    slots = []
    for overall, team_id in enumerate(teams, 1):
        selected = picks.get(overall)
        slots.append({
            "overallPickNumber": overall,
            "roundId": (overall - 1) // team_count + 1,
            "roundPickNumber": (overall - 1) % team_count + 1,
            "teamId": int(team_id),
            "playerId": selected["playerId"] if selected else -1,
        })
    return {"draftDetail": {"inProgress": not complete, "drafted": complete, "picks": slots}}


class CdpFrames:
    def __init__(self, port: int, target_id: str, *, reload_page: bool = False):
        tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=3))
        url = next((tab["webSocketDebuggerUrl"] for tab in tabs if tab.get("id") == target_id), None)
        if not url:
            raise RuntimeError("CDP target not found")
        self.socket = websocket.create_connection(url, timeout=5, suppress_origin=True)
        self.request_id = 0
        self.tracked_requests: set[str] = set()
        self.frames: list[dict[str, Any]] = []
        self._command("Network.enable")
        if reload_page:
            # Network instrumentation must precede navigation so the opening
            # INIT frame cannot race the adapter. Reloading is read-only.
            self._command("Page.reload", {"ignoreCache": False})

    def _command(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.request_id += 1
        request_id = self.request_id
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            response = json.loads(self.socket.recv())
            if response.get("id") == request_id:
                return

            self._record(response)

    def _record(self, response: dict[str, Any]) -> None:
        method = response.get("method")
        params = response.get("params", {})
        if method == "Network.webSocketCreated":
            request_id = params.get("requestId")
            url = params.get("url", "")
            if isinstance(request_id, str) and "fantasydraft.espn.com" in url:
                self.tracked_requests.add(request_id)
        elif (
            method == "Network.webSocketFrameReceived"
            and params.get("requestId") in self.tracked_requests
        ):
            data = params.get("response", {}).get("payloadData")
            if isinstance(data, str):
                self.frames.append({"at": round(time.time() * 1000), "data": data})

    def read(self, wait_seconds: float) -> list[dict[str, Any]]:
        deadline = time.monotonic() + wait_seconds
        self.socket.settimeout(max(0.05, min(wait_seconds, 0.25)))
        while time.monotonic() < deadline:
            try:
                response = json.loads(self.socket.recv())
            except websocket.WebSocketTimeoutException:
                continue
            self._record(response)
        return self.frames


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cdp-port", type=int, required=True)
    parser.add_argument("--target-id", required=True)
    parser.add_argument("--init-file", type=Path, required=True)
    parser.add_argument("--worker-base", required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--poll-seconds", type=float, default=0.25)
    parser.add_argument("--reload", action="store_true", help="reload after Network capture is armed")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    init = json.loads(args.init_file.read_text())
    secret = os.environ.get("INGEST_HMAC_CURRENT")
    if not secret:
        raise SystemExit("INGEST_HMAC_CURRENT is required")
    season, league_id = draft_identity(init["draftKey"])
    config = RunnerConfig(
        season=season,
        league_id=league_id,
        draft_key=init["draftKey"],
        worker_base=args.worker_base,
        checkpoint=args.checkpoint,
        init_file=args.init_file,
    )
    runner = LiveRunner(
        config,
        secret=secret,
        cf_access_client_id=os.environ.get("CF_ACCESS_CLIENT_ID"),
        cf_access_client_secret=os.environ.get("CF_ACCESS_CLIENT_SECRET"),
    )
    runner.initialize()
    source = CdpFrames(args.cdp_port, args.target_id, reload_page=args.reload)
    picks: dict[int, dict[str, int]] = {}
    processed = 0
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    while True:
        frames = source.read(args.poll_seconds)
        changed_at: Any = None
        reconnect = False
        for frame in frames[processed:]:
            message = frame.get("data")
            if not isinstance(message, str):
                continue
            if message.startswith("INIT "):
                recovered = decode_init_picks(message)
                picks = {pick["pickNumber"]: pick for pick in recovered}
                reconnect = True
                changed_at = frame.get("at")
            else:
                selected = selected_frame(message)
                if selected is None:
                    continue
                overall = len(picks) + 1
                team_id, player_id, slot_id = selected
                if overall > init["totalPickSlots"] or str(team_id) != init["draftSlotTeamIds"][overall - 1]:
                    raise RuntimeError("live pick does not match initialized draft order")
                picks[overall] = {
                    "teamId": team_id,
                    "pickNumber": overall,
                    "playerId": player_id,
                    "slotId": slot_id,
                }
                changed_at = frame.get("at")
        processed = len(frames)
        if changed_at is not None:
            observed = iso_from_epoch_ms(changed_at)
            started = time.monotonic()
            complete = len(picks) == init["totalPickSlots"]
            runner.commit_snapshot(raw_board(init, picks, complete=complete), captured_at=observed)
            latency_ms = round((time.time() * 1000) - float(changed_at), 1)
            record = {
                "at": utc_now(),
                "event": "board_committed",
                "filledPicks": len(picks),
                "recoveredFromInit": reconnect,
                "sourceToCommitMs": latency_ms,
                "commitDurationMs": round((time.monotonic() - started) * 1000, 1),
            }
            with args.evidence.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
            print(json.dumps(record, sort_keys=True, separators=(",", ":")), flush=True)
            if complete:
                return 0


if __name__ == "__main__":
    raise SystemExit(main())
