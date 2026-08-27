#!/usr/bin/env python3
"""Read-only comparison of the live research Sheet with the checked-in contract."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).parents[1]
DEFAULT_MANIFEST = ROOT / "config" / "research-vocabulary.json"
PROFILE_TABS = {
    "QB": "QB Profiles",
    "RB": "RB Profiles",
    "WR": "WR Profiles",
    "TE": "TE Profiles",
    "K": "K Profiles",
    "D/ST": "DST Profiles",
}


def nonblank(values: list[Any]) -> list[Any]:
    return [value for value in values if value != ""]


def expected_ranges(manifest: dict[str, Any]) -> dict[str, list[str]]:
    sheet = manifest["sheet"]
    ranges = {
        "Lists!A1:V100": sheet["listsHeaders"],
        "Player Directory!A1:J1": sheet["playerDirectoryHeaders"],
        "Team Snapshots!A1:I1": sheet["teamSnapshotHeaders"],
    }
    common = sheet["profileCommonHeaders"]
    for position, tab in PROFILE_TABS.items():
        ranges[f"{tab}!A1:ZZ1"] = [*common, *sheet["positionFindingHeaders"][position]]
    return ranges


def check_contract(
    manifest: dict[str, Any],
    values_by_range: dict[str, list[list[Any]]],
) -> list[str]:
    errors: list[str] = []
    expected = expected_ranges(manifest)
    for range_name, headers in expected.items():
        values = values_by_range.get(range_name, [])
        actual_headers = nonblank(values[0]) if values else []
        if actual_headers != headers:
            errors.append(f"{range_name} headers differ from the manifest")

    list_values = values_by_range.get("Lists!A1:V100", [])
    list_headers = manifest["sheet"]["listsHeaders"]
    columns = [
        [row[index] if index < len(row) else "" for row in list_values]
        for index in range(len(list_headers))
    ]

    def column(name: str) -> list[Any]:
        index = list_headers.index(name)
        return nonblank(columns[index][1:]) if index < len(columns) else []

    expected_roles: list[str] = []
    for position in ("QB", "RB", "WR", "TE", "K", "D/ST"):
        for role in manifest["rolesByPosition"][position]:
            if role not in expected_roles:
                expected_roles.append(role)
    expected_roles.append("taxonomy-gap")
    if column("all_researched_roles") != expected_roles:
        errors.append("Lists!all_researched_roles differs from the manifest")
    if column("workflow_status") != manifest["workflowStatuses"]:
        errors.append("Lists!workflow_status differs from the manifest")
    if column("publication_status") != manifest["publicationStatuses"]:
        errors.append("Lists!publication_status differs from the manifest")
    for position, header in manifest["sheet"]["positionRoleListHeaders"].items():
        if column(header) != [*manifest["rolesByPosition"][position], "taxonomy-gap"]:
            errors.append(f"Lists!{header} differs from the manifest")
    return errors


def gog_reader(account: str, spreadsheet_id: str) -> Callable[[str], list[list[Any]]]:
    def read(range_name: str) -> list[list[Any]]:
        command = [
            "gog",
            "--readonly",
            "--enable-commands",
            "sheets.get",
            "--account",
            account,
            "--no-input",
            "sheets",
            "get",
            spreadsheet_id,
            range_name,
            "--json",
        ]
        completed = subprocess.run(command, check=True, capture_output=True, text=True)
        payload = json.loads(completed.stdout)
        values = payload.get("values", [])
        if not isinstance(values, list):
            raise ValueError(f"invalid Sheets response for {range_name}")
        return values

    return read


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--spreadsheet-id", required=True)
    result.add_argument("--account", required=True)
    result.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    return result


def main() -> int:
    args = parser().parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    read = gog_reader(args.account, args.spreadsheet_id)
    values = {range_name: read(range_name) for range_name in expected_ranges(manifest)}
    errors = check_contract(manifest, values)
    print(json.dumps({"ok": not errors, "errors": errors}, sort_keys=True))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
