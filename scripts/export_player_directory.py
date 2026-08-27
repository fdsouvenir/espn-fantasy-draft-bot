#!/usr/bin/env python3
"""Project a frozen ESPN catalog into the canonical Player Directory rows."""

from __future__ import annotations

import argparse
import json
import math
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable


PLAYER_DIRECTORY_HEADERS = [
    "player_key",
    "player_name",
    "position",
    "nfl_team",
    "base_tier",
    "espn_adp",
    "base_role",
    "active",
    "imported_at",
    "notes",
]
SUPPORTED_POSITIONS = ("QB", "RB", "WR", "TE", "K", "D/ST")
POSITION_ORDER = {position: index for index, position in enumerate(SUPPORTED_POSITIONS)}
ESPN_ID = re.compile(r"^-?\d{1,18}$")


def load_catalog(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("catalog must be a schemaVersion 1 object")
    if not isinstance(value.get("catalogVersion"), str) or not value["catalogVersion"]:
        raise ValueError("catalogVersion is required")
    if not isinstance(value.get("generatedAt"), str) or not value["generatedAt"]:
        raise ValueError("generatedAt is required")
    if not isinstance(value.get("catalog"), list):
        raise ValueError("catalog players must be a list")
    return value


def _safe_adp(value: Any) -> float | str:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return round(float(value), 4)
    return ""


def player_directory_rows(catalog_envelope: dict[str, Any]) -> list[list[Any]]:
    imported_at = catalog_envelope["generatedAt"]
    catalog_version = catalog_envelope["catalogVersion"]
    records: list[tuple[tuple[Any, ...], list[Any]]] = []
    seen: set[str] = set()

    for player in catalog_envelope["catalog"]:
        if not isinstance(player, dict):
            raise ValueError("catalog contains a non-object player")
        player_id = str(player.get("playerId", "")).strip()
        name = str(player.get("name", "")).strip()
        position = str(player.get("position", "")).upper().replace("DST", "D/ST")
        nfl_team = str(player.get("nflTeam", "")).upper().strip()
        if not ESPN_ID.fullmatch(player_id) or player_id == "-1":
            raise ValueError(f"invalid ESPN player id: {player_id or '<empty>'}")
        if player_id in seen:
            raise ValueError(f"duplicate ESPN player id: {player_id}")
        if not name or position not in SUPPORTED_POSITIONS or not nfl_team:
            raise ValueError(f"incomplete Player Directory identity for espn:{player_id}")
        seen.add(player_id)
        active = nfl_team != "FA"
        adp = _safe_adp(player.get("adp"))
        row = [
            f"espn:{player_id}",
            name,
            position,
            nfl_team,
            str(player.get("tier", "")),
            adp,
            str(player.get("roleClass", "")),
            active,
            imported_at,
            f"catalog:{catalog_version}",
        ]
        sort_adp = adp if isinstance(adp, float) else float("inf")
        sort_key = (
            not active,
            nfl_team,
            POSITION_ORDER[position],
            sort_adp,
            name.casefold(),
            player_id,
        )
        records.append((sort_key, row))

    return [PLAYER_DIRECTORY_HEADERS, *[row for _, row in sorted(records)]]


def atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--catalog", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    return result


def main(argv: Iterable[str] | None = None) -> int:
    args = parser().parse_args(argv)
    rows = player_directory_rows(load_catalog(args.catalog))
    atomic_json_write(args.output, rows)
    active = sum(row[7] is True for row in rows[1:])
    print(json.dumps({"output": str(args.output), "players": len(rows) - 1, "active": active}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
