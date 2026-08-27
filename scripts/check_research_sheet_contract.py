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
PUBLICATION_REVIEW_FORMULA_KEY = "Publication Review!C2:C12@FORMULA"


def nonblank(values: list[Any]) -> list[Any]:
    return [value for value in values if value != ""]


def expected_ranges(manifest: dict[str, Any]) -> dict[str, list[str]]:
    sheet = manifest["sheet"]
    ranges = {
        **{
            f"{tab}!A1:ZZ1": headers
            for tab, headers in sheet["workflowTabHeaders"].items()
        },
        "Lists!A1:V100": sheet["listsHeaders"],
        "Player Directory!A1:J1": sheet["playerDirectoryHeaders"],
        "Team Snapshots!A1:I1": sheet["teamSnapshotHeaders"],
    }
    common = sheet["profileCommonHeaders"]
    for position, tab in PROFILE_TABS.items():
        ranges[f"{tab}!A1:ZZ1"] = [*common, *sheet["positionFindingHeaders"][position]]
    return ranges


def expected_publication_review_formulas(manifest: dict[str, Any]) -> list[list[str]]:
    rows = manifest["sheet"]["publicationReviewProfileRows"]
    start = rows["start"]
    end = rows["end"]
    tabs = list(PROFILE_TABS.values())

    def cell_range(tab: str, column: str) -> str:
        return f"'{tab}'!${column}${start}:${column}${end}"

    def countif(column: str, criterion: str) -> str:
        return ",".join(
            f'COUNTIF({cell_range(tab, column)},"{criterion}")'
            for tab in tabs
        )

    def countifs(*pairs: tuple[str, str]) -> str:
        return ",".join(
            "COUNTIFS(" + ",".join(
                f'{cell_range(tab, column)},"{criterion}"'
                for column, criterion in pairs
            ) + ")"
            for tab in tabs
        )

    stale = ",".join(
        f'COUNTIFS({cell_range(tab, "L")},"published",'
        f'{cell_range(tab, "AF")},"<="&NOW())'
        for tab in tabs
    )
    evidence = ",".join(
        countifs(("L", "published"), (column, ""))
        for column in ("AC", "AA", "AG")
    )
    formulas = [
        '=IF(COUNTIF(\'Research Runs\'!$R$2:$R$1000,"complete")>=32,"PASS","NEEDS WORK")',
        '=IF(COUNTIF(\'Research Runs\'!$V$2:$V$1000,"complete")>=32,"PASS","NEEDS WORK")',
        '=IF(COUNTIF(\'Team Snapshots\'!$C$2:$C$33,"yes")>=32,"PASS","NEEDS WORK")',
        f'=SUM({countif("L", "published")})',
        f'=IF(SUM({countif("L", "needs-review")})=0,"PASS","NEEDS WORK")',
        f'=IF(SUM({countif("J", "taxonomy-gap")})=0,"PASS","NEEDS WORK")',
        f'=IF(SUM({countifs(("L", "published"), ("I", "<>complete"))})=0,"PASS","NEEDS WORK")',
        f'=IF(SUM({stale})=0,"PASS","NEEDS WORK")',
        f'=IF(SUM({evidence})=0,"PASS","NEEDS WORK")',
        f'=SUM({countifs(("L", "published"), ("Y", "<>"))})',
        '=IF(COUNTIF($C$2:$C$10,"NEEDS WORK")=0,"READY","NEEDS WORK")',
    ]
    return [[formula] for formula in formulas]


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

    actual_formulas = values_by_range.get(PUBLICATION_REVIEW_FORMULA_KEY, [])
    if actual_formulas != expected_publication_review_formulas(manifest):
        errors.append("Publication Review formulas differ from the manifest")

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


def gog_reader(account: str, spreadsheet_id: str) -> Callable[..., list[list[Any]]]:
    def read(range_name: str, render: str | None = None) -> list[list[Any]]:
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
        ]
        if render:
            command.extend(["--render", render])
        command.append("--json")
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
    values[PUBLICATION_REVIEW_FORMULA_KEY] = read(
        "Publication Review!C2:C12",
        render="FORMULA",
    )
    errors = check_contract(manifest, values)
    print(json.dumps({"ok": not errors, "errors": errors}, sort_keys=True))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
