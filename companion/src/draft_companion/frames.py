from __future__ import annotations

import base64
from typing import Any


class DecodeError(ValueError):
    pass


class Reader:
    def __init__(self, payload: bytes):
        self.payload, self.index = payload, 0

    def number(self, size: int) -> int:
        end = self.index + size
        if end > len(self.payload):
            raise DecodeError("truncated INIT frame")
        value = int.from_bytes(self.payload[self.index : end], "big")
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


def _draft_block(r: Reader) -> None:
    _header(r, 1)
    r.int32()
    r.int32()
    if r.int32() != 0:
        r.skip(8)
    for _ in range(5):
        r.int32()


def _break_schedule(r: Reader) -> None:
    _header(r, 1)
    for _ in range(3):
        r.int32()


def _autodraft(r: Reader) -> None:
    _header(r, 1)
    for _ in range(3):
        r.int32()


def _scoring(r: Reader) -> None:
    _header(r, 1)
    r.int32()
    r.int32()
    count = r.int32()
    if not 0 <= count <= 1000:
        raise DecodeError("invalid scoring count")
    for _ in range(count):
        _header(r, 3)
        r.int32()
        r.int32()
        r.skip(8)
        r.boolean()


def _rules(r: Reader) -> None:
    _header(r, 2)
    for _ in range(5):
        r.int32()
    _break_schedule(r)
    _autodraft(r)
    for _ in range(4):
        r.int32()
    for _ in range(4):
        r.skip(8)
    r.int32()
    r.boolean()
    for _ in range(3):
        r.int32()
    r.boolean()
    r.boolean()
    _scoring(r)
    r.boolean()


def _position(r: Reader) -> None:
    _header(r, 1)
    for _ in range(3):
        r.int32()


def _slot_position(r: Reader) -> None:
    _header(r, 1)
    for _ in range(3):
        r.int32()


def _slot(r: Reader) -> None:
    _header(r, 1)
    for _ in range(3):
        r.int32()
    count = r.int32()
    if not 0 <= count <= 100:
        raise DecodeError("invalid slot count")
    for _ in range(count):
        _slot_position(r)


def _pick(r: Reader) -> dict[str, int]:
    _header(r, 3)
    values = [r.int32() for _ in range(7)]
    r.boolean()
    r.int32()
    r.int32()
    return {
        "teamId": values[1],
        "pickNumber": values[2],
        "playerId": values[3],
        "slotId": values[4],
    }


def decode_init_picks(message: str) -> list[dict[str, int]]:
    fields = message.split()
    if len(fields) < 2 or fields[0] != "INIT":
        raise DecodeError("invalid INIT frame")
    try:
        payload = base64.b64decode(fields[1], validate=True)
    except (ValueError, TypeError) as error:
        raise DecodeError("invalid INIT encoding") from error
    r = Reader(payload)
    _header(r, 1)
    r.int32()
    r.int32()
    _header(r, 1)
    r.int32()
    r.int32()
    r.int32()
    if r.int32() != 0:
        r.skip(8)
    r.int32()
    _draft_block(r)
    _rules(r)
    positions = r.int32()
    if not 0 <= positions <= 100:
        raise DecodeError("invalid position count")
    for _ in range(positions):
        _position(r)
    slots = r.int32()
    if not 0 <= slots <= 100:
        raise DecodeError("invalid slot count")
    for _ in range(slots):
        _slot(r)
    count = r.int32()
    if not 0 <= count <= 1000:
        raise DecodeError("invalid pick count")
    picks = [_pick(r) for _ in range(count)]
    if [p["pickNumber"] for p in picks] != list(range(1, count + 1)):
        raise DecodeError("INIT picks are not contiguous")
    return [p for p in picks if p["playerId"] != -1]


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


def raw_board(
    init: dict[str, Any], picks: dict[int, dict[str, int]], complete: bool
) -> dict[str, Any]:
    teams, team_count = init["draftSlotTeamIds"], int(init["expectedTeams"])
    slots = []
    for overall, team_id in enumerate(teams, 1):
        selected = picks.get(overall)
        slots.append(
            {
                "overallPickNumber": overall,
                "roundId": (overall - 1) // team_count + 1,
                "roundPickNumber": (overall - 1) % team_count + 1,
                "teamId": int(team_id),
                "playerId": selected["playerId"] if selected else -1,
            }
        )
    return {"draftDetail": {"inProgress": not complete, "drafted": complete, "picks": slots}}
