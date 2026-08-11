#!/usr/bin/env python3
"""Compile reviewed Google Sheet edits into a frozen draft catalog release.

The compiler never writes to Google.  It accepts a sanitized local export for
offline/reproducible use, or reads the two configured tabs with ``gog`` in
read-only mode.  Every editorial row is validated before any output is written.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable


COMPILER_VERSION = "sheet-release-v1"
ROLE_TAB = "Role Overrides"
TIER_TAB = "Tiers & Flags"
ROLE_RANGE = f"'{ROLE_TAB}'!A1:Y2000"
TIER_RANGE = f"'{TIER_TAB}'!A1:J2000"

ROLE_CLASSES = {
    "starter", "lead-committee", "committee", "passing-down", "goal-line",
    "backup", "specialist", "unknown",
}
TARGET_FLAGS = {"target", "neutral", "avoid"}
SHARE_NAMES = ("snap", "carry", "route", "target", "goal_line")
TARGET_ADJUSTMENT_LIMIT = 6.0
PICK_GUARDRAIL_MAX = 400
PLAYER_KEY = re.compile(r"espn:(-?[1-9][0-9]*)\Z")
SAFE_TIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,31}\Z")
WRAPPED_CELL = re.compile(
    r'^<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>\nSource: google_api\n---\n'
    r'(.*)\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>$',
    re.DOTALL,
)

# The workbook cannot express all opportunity inputs in the full design.  These
# fixed weights therefore apply only to supplied midpoint evidence; missing
# fields receive no invented baseline and reduce the maximum achievable score.
POSITION_WEIGHTS: dict[str, dict[str, float]] = {
    "RB": {"carry": .30, "snap": .20, "route": .10, "target": .10, "goal_line": .20},
    "WR": {"target": .35, "route": .30, "snap": .15, "goal_line": .10},
    "TE": {"target": .35, "route": .30, "snap": .15, "goal_line": .10},
    "QB": {"snap": .35, "carry": .15, "goal_line": .10},
    "K": {},
    "D/ST": {},
}


class ReleaseError(ValueError):
    """A release-blocking editorial or catalog validation error."""


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def parse_time(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except (AttributeError, ValueError) as exc:
        raise ReleaseError(f"{field} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ReleaseError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def cell_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    match = WRAPPED_CELL.fullmatch(text)
    return match.group(1).strip() if match else text


def rows_from_values(values: Any, tab: str) -> list[dict[str, str]]:
    if not isinstance(values, list) or not values:
        return []
    if all(isinstance(row, dict) for row in values):
        return [
            {cell_text(key): cell_text(value) for key, value in row.items()}
            for row in values
            if any(cell_text(value) for value in row.values())
        ]
    if not all(isinstance(row, list) for row in values):
        raise ReleaseError(f"{tab} rows must all be objects or all be arrays")
    headers = [cell_text(value) for value in values[0]]
    if not headers or any(not header for header in headers) or len(headers) != len(set(headers)):
        raise ReleaseError(f"{tab} has blank or duplicate headers")
    output: list[dict[str, str]] = []
    for row_number, raw in enumerate(values[1:], start=2):
        cells = [cell_text(value) for value in raw]
        if not any(cells):
            continue
        if len(cells) > len(headers) and any(cells[len(headers):]):
            raise ReleaseError(f"{tab} row {row_number} contains values beyond its headers")
        cells.extend([""] * (len(headers) - len(cells)))
        output.append(dict(zip(headers, cells[:len(headers)])))
    return output


def tab_values(payload: Any, tab: str) -> list[dict[str, str]]:
    if not isinstance(payload, dict):
        raise ReleaseError("sheet export must be a JSON object")
    container = payload.get("tabs", payload)
    value = container.get(tab) if isinstance(container, dict) else None
    if value is None:
        raise ReleaseError(f"sheet export is missing {tab}")
    if isinstance(value, dict) and "values" in value:
        value = value["values"]
    return rows_from_values(value, tab)


def run_gog(*, gog_bin: str, account: str, spreadsheet_id: str, range_name: str) -> dict[str, Any]:
    command = [
        gog_bin, "--readonly", "--account", account, "--no-input", "sheets", "get",
        spreadsheet_id, range_name, "--json", "--wrap-untrusted",
    ]
    try:
        completed = subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise ReleaseError(f"read-only gog fetch failed for {range_name}") from exc
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ReleaseError(f"gog returned invalid JSON for {range_name}") from exc
    if not isinstance(value, dict) or not isinstance(value.get("values"), list):
        raise ReleaseError(f"gog response for {range_name} has no values array")
    return value


def fetch_sheet(account: str, spreadsheet_id: str, gog_bin: str) -> dict[str, Any]:
    return {
        "spreadsheetId": spreadsheet_id,
        "tabs": {
            ROLE_TAB: run_gog(gog_bin=gog_bin, account=account, spreadsheet_id=spreadsheet_id, range_name=ROLE_RANGE),
            TIER_TAB: run_gog(gog_bin=gog_bin, account=account, spreadsheet_id=spreadsheet_id, range_name=TIER_RANGE),
        },
    }


def number(value: str, field: str, *, minimum: float, maximum: float) -> float | None:
    if value == "":
        return None
    try:
        parsed = float(value)
    except ValueError as exc:
        raise ReleaseError(f"{field} must be numeric") from exc
    if not math.isfinite(parsed) or not minimum <= parsed <= maximum:
        raise ReleaseError(f"{field} must be between {minimum:g} and {maximum:g}")
    return parsed


def expiration(row: dict[str, str], label: str, now: datetime) -> str:
    raw = row.get("expires_at", "")
    if not raw:
        raise ReleaseError(f"{label} requires expires_at")
    parsed = parse_time(raw, f"{label} expires_at")
    if parsed <= now:
        raise ReleaseError(f"{label} is expired")
    return parsed.isoformat().replace("+00:00", "Z")


def resolve_player(row: dict[str, str], label: str, players: dict[str, dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    key = row.get("player_key", "")
    match = PLAYER_KEY.fullmatch(key)
    if not match:
        raise ReleaseError(f"{label} player_key must match espn:<signed id>")
    if key not in players:
        raise ReleaseError(f"{label} references unknown player {key}")
    return key, players[key]


def role_overrides(rows: list[dict[str, str]], players: dict[str, dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen_players: set[str] = set()
    seen_rows: set[str] = set()
    for index, row in enumerate(rows, start=2):
        label = f"{ROLE_TAB} row {index}"
        unsupported_editorial = sorted(
            field for field in ("contingent_role", "contingent_probability", "contingent_value", "role_certainty")
            if row.get(field, "")
        )
        if unsupported_editorial:
            raise ReleaseError(
                f"{label} contains fields not implemented by {COMPILER_VERSION}: "
                f"{', '.join(unsupported_editorial)}"
            )
        row_id = row.get("editorial_row_id", "")
        if not row_id:
            raise ReleaseError(f"{label} requires editorial_row_id")
        if row_id in seen_rows:
            raise ReleaseError(f"duplicate editorial_row_id {row_id}")
        key, player = resolve_player(row, label, players)
        if key in seen_players:
            raise ReleaseError(f"duplicate role override for {key}")
        role = row.get("role_class", "")
        if role not in ROLE_CLASSES:
            raise ReleaseError(f"{label} has invalid role_class")
        reason = row.get("override_reason", "")
        if not reason:
            raise ReleaseError(f"{label} requires override_reason")
        expires_at = expiration(row, label, now)

        workload: dict[str, dict[str, float]] = {}
        for share in SHARE_NAMES:
            low = number(row.get(f"{share}_share_low", ""), f"{label} {share}_share_low", minimum=0, maximum=1)
            mid = number(row.get(f"{share}_share_mid", ""), f"{label} {share}_share_mid", minimum=0, maximum=1)
            high = number(row.get(f"{share}_share_high", ""), f"{label} {share}_share_high", minimum=0, maximum=1)
            if low is None and mid is None and high is None:
                continue
            if mid is None:
                raise ReleaseError(f"{label} {share} range requires a midpoint")
            if (low is not None and low > mid) or (high is not None and mid > high):
                raise ReleaseError(f"{label} {share} shares must satisfy low <= mid <= high")
            values = {"mid": mid}
            if low is not None:
                values["low"] = low
            if high is not None:
                values["high"] = high
            workload[share] = values

        position = str(player["position"])
        weights = POSITION_WEIGHTS.get(position)
        if weights is None:
            raise ReleaseError(f"{label} has unsupported player position {position}")
        unsupported = sorted(set(workload) - set(weights))
        if unsupported:
            raise ReleaseError(f"{label} has workload fields unsupported for {position}: {', '.join(unsupported)}")
        opportunity = None
        coverage = 0.0
        if workload:
            coverage = sum(weights[name] for name in workload)
            opportunity = round(100 * sum(weights[name] * workload[name]["mid"] for name in workload), 2)

        normalized.append({
            "editorialRowId": row_id,
            "playerKey": key,
            "roleClass": role,
            "workload": workload,
            "opportunityScore": opportunity,
            "opportunityEvidenceCoverage": round(coverage, 4),
            "reason": reason,
            "expiresAt": expires_at,
        })
        seen_rows.add(row_id)
        seen_players.add(key)
    return sorted(normalized, key=lambda item: item["playerKey"])


def integer(value: str, field: str) -> int | None:
    parsed = number(value, field, minimum=1, maximum=PICK_GUARDRAIL_MAX)
    if parsed is None:
        return None
    if not parsed.is_integer():
        raise ReleaseError(f"{field} must be an integer")
    return int(parsed)


def tier_flags(rows: list[dict[str, str]], players: dict[str, dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, row in enumerate(rows, start=2):
        label = f"{TIER_TAB} row {index}"
        key, player = resolve_player(row, label, players)
        if key in seen:
            raise ReleaseError(f"duplicate tier/flag row for {key}")
        supplied_position = row.get("position", "")
        if supplied_position and supplied_position != player["position"]:
            raise ReleaseError(f"{label} position does not match base catalog")
        tier = row.get("tier", "")
        if tier and not SAFE_TIER.fullmatch(tier):
            raise ReleaseError(f"{label} has invalid tier")
        flag = row.get("target_flag", "") or "neutral"
        if flag not in TARGET_FLAGS:
            raise ReleaseError(f"{label} has invalid target_flag")
        adjustment = number(
            row.get("target_adjustment", ""), f"{label} target_adjustment",
            minimum=-TARGET_ADJUSTMENT_LIMIT, maximum=TARGET_ADJUSTMENT_LIMIT,
        )
        adjustment = adjustment if adjustment is not None else 0.0
        before = integer(row.get("do_not_take_before", ""), f"{label} do_not_take_before")
        after = integer(row.get("do_not_pass_after", ""), f"{label} do_not_pass_after")
        if before is not None and after is not None and before > after:
            raise ReleaseError(f"{label} pick guardrails must satisfy do_not_take_before <= do_not_pass_after")
        reason = row.get("reason", "")
        if not reason:
            raise ReleaseError(f"{label} requires reason")
        expires_at = expiration(row, label, now)
        normalized.append({
            "playerKey": key,
            "tier": tier or None,
            "targetFlag": flag,
            "targetAdjustment": round(adjustment, 2),
            "doNotTakeBefore": before,
            "doNotPassAfter": after,
            "reason": reason,
            "expiresAt": expires_at,
        })
        seen.add(key)
    return sorted(normalized, key=lambda item: item["playerKey"])


def base_players(base: dict[str, Any]) -> dict[str, dict[str, Any]]:
    catalog = base.get("catalog")
    if not isinstance(catalog, list) or not catalog:
        raise ReleaseError("base catalog envelope must contain a non-empty catalog")
    players: dict[str, dict[str, Any]] = {}
    for index, player in enumerate(catalog):
        if not isinstance(player, dict) or not isinstance(player.get("playerId"), str):
            raise ReleaseError(f"base catalog player {index} is invalid")
        key = f"espn:{player['playerId']}"
        if not PLAYER_KEY.fullmatch(key) or player["playerId"] == "-1":
            raise ReleaseError(f"base catalog player {index} has invalid playerId")
        if key in players:
            raise ReleaseError(f"base catalog contains duplicate player {key}")
        if player.get("position") not in POSITION_WEIGHTS:
            raise ReleaseError(f"base catalog player {key} has unsupported position")
        players[key] = player
    return players


def clamp(value: float, low: float = 0, high: float = 120) -> float:
    bounded = min(Decimal(str(high)), max(Decimal(str(low)), Decimal(str(value))))
    return float(bounded.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def pick_score(intrinsic: Any, opportunity: Any, adjustment: Any) -> float:
    value = (
        Decimal(str(intrinsic)) * Decimal("0.85")
        + Decimal(str(opportunity)) * Decimal("0.15")
        + Decimal(str(adjustment))
    )
    return clamp(float(value))


def compile_release(
    base: dict[str, Any], sheet: dict[str, Any], *, generated_at: str,
    spreadsheet_id: str | None = None, source_mode: str = "local-export",
) -> dict[str, Any]:
    now = parse_time(generated_at, "generated_at")
    players = base_players(base)
    roles = role_overrides(tab_values(sheet, ROLE_TAB), players, now)
    tiers = tier_flags(tab_values(sheet, TIER_TAB), players, now)
    role_by_key = {item["playerKey"]: item for item in roles}
    tier_by_key = {item["playerKey"]: item for item in tiers}

    output = copy.deepcopy(base)
    compiled: list[dict[str, Any]] = []
    for player in output["catalog"]:
        key = f"espn:{player['playerId']}"
        role = role_by_key.get(key)
        tier = tier_by_key.get(key)
        if role:
            player["roleClass"] = role["roleClass"]
            player["editorialWorkload"] = role["workload"]
            player["editorialOpportunityEvidenceCoverage"] = role["opportunityEvidenceCoverage"]
            if role["opportunityScore"] is not None:
                player["opportunityScore"] = role["opportunityScore"]
            destination = "risks" if role["roleClass"] in {"backup", "unknown"} else "reasons"
            player.setdefault(destination, []).append(f"Editorial role: {role['reason']}")
        if tier:
            if tier["tier"] is not None:
                player["tier"] = tier["tier"]
            player["targetFlag"] = tier["targetFlag"]
            player["targetAdjustment"] = tier["targetAdjustment"]
            player["doNotTakeBefore"] = tier["doNotTakeBefore"]
            player["doNotPassAfter"] = tier["doNotPassAfter"]
            destination = "risks" if tier["targetFlag"] == "avoid" or tier["targetAdjustment"] < 0 else "reasons"
            player.setdefault(destination, []).append(f"Editorial flag: {tier['reason']}")
        if role or tier:
            adjustment = tier["targetAdjustment"] if tier else 0.0
            player["pickNowScore"] = pick_score(
                player["intrinsicScore"], player["opportunityScore"], adjustment
            )
        compiled.append(player)
    compiled.sort(key=lambda item: (-float(item["pickNowScore"]), item["name"], item["playerId"]))

    editorial = {"roleOverrides": roles, "tiersAndFlags": tiers}
    editorial_hash = digest(editorial)
    catalog_hash = digest(compiled)
    base_version = str(base.get("catalogVersion") or f"base-{digest(base.get('catalog'))[:12]}")
    output["catalog"] = compiled
    output["catalogSha256"] = catalog_hash
    output["catalogVersion"] = f"{base_version}+editorial-{editorial_hash[:12]}"
    output["generatedAt"] = now.isoformat().replace("+00:00", "Z")
    provenance = copy.deepcopy(output.get("provenance")) if isinstance(output.get("provenance"), dict) else {}
    provenance["editorialRelease"] = {
        "compilerVersion": COMPILER_VERSION,
        "sourceMode": source_mode,
        "spreadsheetId": spreadsheet_id or sheet.get("spreadsheetId"),
        "tabs": [ROLE_TAB, TIER_TAB],
        "roleOverrideCount": len(roles),
        "tierFlagCount": len(tiers),
        "editorialSha256": editorial_hash,
        "baseCatalogVersion": base_version,
        "baseCatalogSha256": str(base.get("catalogSha256") or digest(base["catalog"])),
        "generatedAt": output["generatedAt"],
        "workloadPolicy": "position-weighted supplied midpoints only; no missing-share inference",
        "targetAdjustmentBounds": [-TARGET_ADJUSTMENT_LIMIT, TARGET_ADJUSTMENT_LIMIT],
    }
    output["provenance"] = provenance
    return output


def atomic_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--base", type=Path, required=True, help="Frozen base catalog JSON")
    source = result.add_mutually_exclusive_group(required=True)
    source.add_argument("--sheet-export", type=Path, help="Sanitized offline Sheet export JSON")
    source.add_argument("--spreadsheet-id", help="Read tabs through gog (read-only)")
    result.add_argument("--account", help="Google account used by gog for a read-only Sheet fetch")
    result.add_argument("--gog-bin", default="gog")
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--now", required=True, help="Release time (ISO-8601 with timezone)")
    return result


def main(argv: Iterable[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        base = json.loads(args.base.read_text(encoding="utf-8"))
        if args.sheet_export:
            sheet = json.loads(args.sheet_export.read_text(encoding="utf-8"))
            source_mode = "local-export"
            spreadsheet_id = sheet.get("spreadsheetId") if isinstance(sheet, dict) else None
        else:
            spreadsheet_id = args.spreadsheet_id
            if not args.account:
                raise ReleaseError("--account is required with --spreadsheet-id")
            sheet = fetch_sheet(args.account, spreadsheet_id, args.gog_bin)
            source_mode = "gog-readonly"
        release = compile_release(
            base, sheet, generated_at=args.now,
            spreadsheet_id=spreadsheet_id, source_mode=source_mode,
        )
        atomic_write(args.output, release)
    except (OSError, json.JSONDecodeError, ReleaseError) as exc:
        raise SystemExit(f"release rejected: {exc}") from exc
    print(json.dumps({
        "catalogVersion": release["catalogVersion"],
        "catalogSha256": release["catalogSha256"],
        "players": len(release["catalog"]),
        "output": str(args.output),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
