#!/usr/bin/env python3
"""Trigger Draftside's mechanical Sheet import without creating publication JSON."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


PROFILE_TABS = (
    "QB Profiles",
    "RB Profiles",
    "WR Profiles",
    "TE Profiles",
    "K Profiles",
    "DST Profiles",
)
IMPORT_TABS = ("Team Snapshots", *PROFILE_TABS)
MAX_RESPONSE_BYTES = 256 * 1024
MAX_TRIGGER_BYTES = 5 * 1024 * 1024
USER_AGENT = "draftside-sheet-trigger/1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def gog_get(
    spreadsheet_id: str,
    range_name: str,
    account: str,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> list[list[Any]]:
    result = runner(
        [
            "gog",
            "--readonly",
            "--enable-commands",
            "sheets.get",
            "--account",
            account,
            "sheets",
            "get",
            spreadsheet_id,
            range_name,
            "--json",
            "--no-input",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    values = payload.get("values") if isinstance(payload, dict) else None
    if not isinstance(values, list):
        raise RuntimeError(f"Google Sheets returned no values for {range_name}")
    return values


def build_trigger_payload(
    spreadsheet_id: str,
    account: str,
    requested_by: str,
    *,
    request_id: str | None = None,
    requested_at: str | None = None,
    reader: Callable[[str, str, str], list[list[Any]]] = gog_get,
) -> dict[str, Any]:
    ranges = {
        tab: reader(spreadsheet_id, f"'{tab}'!A1:ZZ1000", account)
        for tab in IMPORT_TABS
    }
    return {
        "schemaVersion": 1,
        "spreadsheetId": spreadsheet_id,
        "requestId": request_id or str(uuid.uuid4()),
        "requestedAt": requested_at or utc_now(),
        "requestedBy": requested_by,
        "ranges": ranges,
    }


def post_trigger(payload: dict[str, Any], publisher_url: str, token: str, timeout: float) -> dict[str, Any]:
    if len(token) < 32:
        raise ValueError("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN must contain at least 32 characters")
    parsed = urllib.parse.urlsplit(publisher_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("publisher URL must be absolute HTTP(S)")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise ValueError("non-local publisher URL must use HTTPS")
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_TRIGGER_BYTES:
        raise ValueError("research Sheet trigger exceeds 5 MiB")
    request = urllib.request.Request(
        publisher_url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raw = error.read(MAX_RESPONSE_BYTES + 1)
        try:
            result = json.loads(raw.decode("utf-8"))
            code = result.get("error", "publish_trigger_failed")
            problems = result.get("problems", [])
        except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
            code, problems = "publish_trigger_failed", []
        detail = f": {'; '.join(str(item) for item in problems[:20])}" if problems else ""
        raise RuntimeError(f"research publish trigger failed ({error.code}): {code}{detail}") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise RuntimeError("research publish trigger returned an oversized response")
    result = json.loads(raw.decode("utf-8"))
    if not isinstance(result, dict) or result.get("publicationId") is None:
        raise RuntimeError("research publish trigger returned an invalid acknowledgement")
    return result


def _rows(values: list[list[Any]]) -> list[dict[str, Any]]:
    if not values:
        return []
    headers = [str(value) for value in values[0]]
    return [
        {header: row[index] if index < len(row) else "" for index, header in enumerate(headers)}
        for row in values[1:]
    ]


def build_local_draft_init(
    payload: dict[str, Any],
    player_directory: list[list[Any]],
    draft_key: str,
) -> dict[str, Any]:
    profile_keys = {
        str(row.get("player_key", "")).strip()
        for tab in PROFILE_TABS
        for row in _rows(payload["ranges"][tab])
        if str(row.get("player_key", "")).strip()
    }
    directory = {
        str(row.get("player_key", "")).strip(): row
        for row in _rows(player_directory)
        if str(row.get("player_key", "")).strip()
    }
    missing = sorted(profile_keys - directory.keys())
    if missing:
        raise ValueError(f"Player Directory is missing {len(missing)} pilot profile identities")
    catalog = []
    for player_key in sorted(profile_keys):
        row = directory[player_key]
        player_id = player_key.removeprefix("espn:")
        try:
            adp = float(row["espn_adp"]) if str(row.get("espn_adp", "")).strip() else None
        except (TypeError, ValueError) as error:
            raise ValueError(f"Player Directory has invalid ESPN ADP for {player_key}") from error
        player = {
            "playerId": player_id,
            "name": str(row.get("player_name", "")).strip(),
            "position": str(row.get("position", "")).strip(),
            "nflTeam": str(row.get("nfl_team", "")).strip(),
            "tier": str(row.get("base_tier", "")).strip() or "Unranked",
            "roleClass": str(row.get("base_role", "")).strip() or "unknown",
            "opportunityScore": 50,
            "intrinsicScore": 50,
            "pickNowScore": 50,
            "returnProbability": None,
            "reasons": ["Local research integration rehearsal"],
            "risks": [],
        }
        if adp is not None:
            player["adp"] = adp
        catalog.append(player)
    team_ids = [f"team-{index}" for index in range(1, 11)]
    draft_slots = []
    for round_index in range(15):
        draft_slots.extend(team_ids if round_index % 2 == 0 else reversed(team_ids))
    return {
        "schemaVersion": 1,
        "draftKey": draft_key,
        "displayName": "Local research pilot",
        "expectedTeams": 10,
        "expectedRounds": 15,
        "totalPickSlots": 150,
        "managedTeamId": "team-3",
        "draftSlotTeamIds": draft_slots,
        "rosterTargets": {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "FLEX": 1},
        "pinnedCatalogVersion": "sheet-research-pilot-2026.3",
        "catalog": catalog,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spreadsheet-id", required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--requested-by", default="Draftside operator")
    parser.add_argument("--publisher-url")
    parser.add_argument("--payload-output", type=Path)
    parser.add_argument("--draft-init-output", type=Path)
    parser.add_argument("--draft-key")
    parser.add_argument("--timeout", type=float, default=30.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = build_trigger_payload(args.spreadsheet_id, args.account, args.requested_by)
    if args.payload_output:
        atomic_json_write(args.payload_output, payload)
    if args.draft_init_output:
        if not args.draft_key:
            raise SystemExit("--draft-key is required with --draft-init-output")
        directory = gog_get(args.spreadsheet_id, "'Player Directory'!A1:J5000", args.account)
        atomic_json_write(
            args.draft_init_output,
            build_local_draft_init(payload, directory, args.draft_key),
        )
    if args.publisher_url:
        token = os.environ.get("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN", "")
        result = post_trigger(payload, args.publisher_url, token, args.timeout)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    elif not args.payload_output and not args.draft_init_output:
        raise SystemExit("provide --publisher-url, --payload-output, or --draft-init-output")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
