#!/usr/bin/env python3
"""Build a deterministic DraftInitV1 from ESPN's read-only league view.

The network path performs exactly one unauthenticated GET. It never sends ESPN
cookies and never calls a mutation endpoint. ``--fixture`` makes the same
validation and normalization path available offline for tests and rehearsals.
"""

from __future__ import annotations

import argparse
import json
import math
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


BASE_URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"
VIEWS = ("mSettings", "mDraftDetail", "mTeam", "mStatus")
LINEUP_SLOT_POSITIONS = {"QB": "0", "RB": "2", "WR": "4", "TE": "6", "FLEX": "23"}
# ESPN reports injured-reserve capacity in lineupSlotCounts, but IR is not a
# draftable roster slot and therefore does not add a draft round.
NON_DRAFT_ROSTER_SLOTS = frozenset({"21"})
USER_AGENT = "Mozilla/5.0 (compatible; FDS-ESPN-Draft-Helper/1.0; private-read-only)"


class DraftInitError(ValueError):
    """Raised when ESPN or catalog input cannot produce a safe initializer."""


def atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def _integer(value: Any, label: str, *, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise DraftInitError(f"{label} must be an integer from {minimum} through {maximum}")
    return value


def _identifier(value: Any, label: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise DraftInitError(f"{label} must be a string or integer identifier")
    result = str(value)
    if not result or len(result) > 80:
        raise DraftInitError(f"{label} is empty or too long")
    return result


def league_url(league_id: int, season: int) -> str:
    query = urllib.parse.urlencode([("view", view) for view in VIEWS])
    return f"{BASE_URL}/seasons/{season}/segments/0/leagues/{league_id}?{query}"


def fetch_league(league_id: int, season: int, *, timeout: float = 20.0) -> Any:
    request = urllib.request.Request(
        league_url(league_id, season),
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError("read-only ESPN league fetch failed") from exc


def load_json(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DraftInitError(f"unable to read valid {label} JSON: {path}") from exc


def _validate_catalog(catalog_document: Any) -> tuple[str, list[dict[str, Any]]]:
    if not isinstance(catalog_document, dict):
        raise DraftInitError("catalog must be a JSON object")
    version = catalog_document.get("catalogVersion")
    catalog = catalog_document.get("catalog")
    if not isinstance(version, str) or not version or len(version) > 120:
        raise DraftInitError("catalogVersion is required")
    if not isinstance(catalog, list) or len(catalog) > 5000:
        raise DraftInitError("catalog must be a list of at most 5000 players")

    player_ids: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, player in enumerate(catalog):
        if not isinstance(player, dict):
            raise DraftInitError(f"catalog player {index} must be an object")
        player_id = _identifier(player.get("playerId"), f"catalog player {index} playerId")
        if player_id == "-1":
            raise DraftInitError("catalog may not contain ESPN's -1 empty-player sentinel")
        if player_id in player_ids:
            raise DraftInitError(f"duplicate catalog playerId: {player_id}")
        player_ids.add(player_id)
        item = dict(player)
        item["playerId"] = player_id
        for field, maximum in (
            ("name", 160), ("position", 16), ("nflTeam", 16),
            ("tier", 32), ("roleClass", 64),
        ):
            value = item.get(field)
            if not isinstance(value, str) or not value or len(value) > maximum:
                raise DraftInitError(f"catalog player {index} has invalid {field}")
        for field in ("opportunityScore", "intrinsicScore", "pickNowScore"):
            value = item.get(field)
            if (
                isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or not 0 <= value <= 100
            ):
                raise DraftInitError(f"catalog player {index} has invalid {field}")
        probability = item.get("returnProbability")
        if probability is not None and (
            isinstance(probability, bool) or not isinstance(probability, (int, float))
            or not math.isfinite(probability) or not 0 <= probability <= 1
        ):
            raise DraftInitError(f"catalog player {index} has invalid returnProbability")
        for field in ("reasons", "risks"):
            values = item.get(field)
            if (
                not isinstance(values, list) or len(values) > 12
                or any(not isinstance(value, str) or not value or len(value) > 240 for value in values)
            ):
                raise DraftInitError(f"catalog player {index} has invalid {field}")
        eligible = item.get("eligibleSlots")
        if eligible is not None:
            if (
                not isinstance(eligible, list) or len(eligible) > 32
                or any(isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot <= 99 for slot in eligible)
            ):
                raise DraftInitError(f"catalog player {index} has invalid eligibleSlots")
        # Retain legitimate negative ESPN D/ST ids such as -16034.
        normalized.append(item)
    return version, normalized


def _roster_targets(roster_settings: Any) -> tuple[dict[str, int], int]:
    if not isinstance(roster_settings, dict):
        raise DraftInitError("settings.rosterSettings is required")
    counts = roster_settings.get("lineupSlotCounts")
    if not isinstance(counts, dict):
        raise DraftInitError("lineupSlotCounts is required")

    normalized_counts: dict[str, int] = {}
    for raw_slot, raw_count in counts.items():
        slot = str(raw_slot)
        normalized_counts[slot] = _integer(
            raw_count, f"lineupSlotCounts[{slot}]", minimum=0, maximum=40
        )
    roster_size = sum(
        count for slot, count in normalized_counts.items() if slot not in NON_DRAFT_ROSTER_SLOTS
    )
    if not 1 <= roster_size <= 40:
        raise DraftInitError("roster size must be from 1 through 40")
    targets = {
        position: normalized_counts.get(slot, 0)
        for position, slot in LINEUP_SLOT_POSITIONS.items()
    }
    return targets, roster_size


def build_draft_init(
    league_json: Any,
    catalog_document: Any,
    *,
    league_id: int,
    season: int,
    managed_team_id: str | int,
    environment: str = "staging",
) -> dict[str, Any]:
    if not isinstance(league_json, dict):
        raise DraftInitError("league response must be a JSON object")

    response_league_id = _integer(league_json.get("id"), "league id", minimum=1, maximum=10**12)
    response_season = _integer(league_json.get("seasonId"), "season id", minimum=2000, maximum=2200)
    if response_league_id != league_id:
        raise DraftInitError(f"league id mismatch: requested {league_id}, received {response_league_id}")
    if response_season != season:
        raise DraftInitError(f"season mismatch: requested {season}, received {response_season}")

    settings = league_json.get("settings")
    if not isinstance(settings, dict):
        raise DraftInitError("settings are required")
    expected_teams = _integer(settings.get("size"), "settings.size", minimum=2, maximum=32)

    teams = league_json.get("teams")
    if not isinstance(teams, list) or len(teams) != expected_teams:
        raise DraftInitError("team list length does not match settings.size")
    team_ids = [_identifier(team.get("id"), "team id") for team in teams if isinstance(team, dict)]
    if len(team_ids) != expected_teams or len(set(team_ids)) != expected_teams:
        raise DraftInitError("team list contains missing or duplicate team ids")
    managed = _identifier(managed_team_id, "managed team id")
    if managed not in team_ids:
        raise DraftInitError("managed team is not a league member")

    roster_targets, expected_rounds = _roster_targets(settings.get("rosterSettings"))
    total_pick_slots = expected_teams * expected_rounds

    draft_settings = settings.get("draftSettings")
    if not isinstance(draft_settings, dict):
        raise DraftInitError("settings.draftSettings is required")
    if environment not in {"local", "staging"}:
        raise DraftInitError("environment must be local or staging")
    draft_epoch = _integer(
        draft_settings.get("date"), "draftSettings.date", minimum=1, maximum=10**15
    )
    if draft_settings.get("type") != "SNAKE":
        raise DraftInitError("only SNAKE drafts are supported")
    pick_order = draft_settings.get("pickOrder")
    if not isinstance(pick_order, list) or len(pick_order) != expected_teams:
        raise DraftInitError("draftSettings.pickOrder must contain every team exactly once")
    first_round = [_identifier(team_id, "pickOrder team id") for team_id in pick_order]
    if len(set(first_round)) != expected_teams or set(first_round) != set(team_ids):
        raise DraftInitError("draftSettings.pickOrder does not match league teams")

    draft_detail = league_json.get("draftDetail")
    if not isinstance(draft_detail, dict):
        raise DraftInitError("draftDetail is required")
    drafted = draft_detail.get("drafted")
    in_progress = draft_detail.get("inProgress")
    if not isinstance(drafted, bool) or not isinstance(in_progress, bool):
        raise DraftInitError("draft phase flags must be booleans")
    if drafted:
        raise DraftInitError("initializer requires a pre-draft or live league")

    picks = draft_detail.get("picks")
    if not isinstance(picks, list) or len(picks) != total_pick_slots:
        raise DraftInitError(
            f"draft pick slots do not match {expected_teams} teams x {expected_rounds} rounds"
        )

    by_overall: dict[int, tuple[int, int, str]] = {}
    seen_round_slots: set[tuple[int, int]] = set()
    for pick in picks:
        if not isinstance(pick, dict):
            raise DraftInitError("every draft pick slot must be an object")
        overall = _integer(pick.get("overallPickNumber"), "overallPickNumber", minimum=1, maximum=1000)
        round_id = _integer(pick.get("roundId"), "roundId", minimum=1, maximum=40)
        round_pick = _integer(pick.get("roundPickNumber"), "roundPickNumber", minimum=1, maximum=32)
        team_id = _identifier(pick.get("teamId"), "draft slot team id")
        if overall in by_overall:
            raise DraftInitError(f"duplicate overallPickNumber: {overall}")
        if (round_id, round_pick) in seen_round_slots:
            raise DraftInitError(f"duplicate round slot: round {round_id}, pick {round_pick}")
        if team_id not in team_ids:
            raise DraftInitError(f"draft slot references unknown team: {team_id}")
        by_overall[overall] = (round_id, round_pick, team_id)
        seen_round_slots.add((round_id, round_pick))

    expected_overalls = list(range(1, total_pick_slots + 1))
    if sorted(by_overall) != expected_overalls:
        raise DraftInitError("draft pick slots contain a gap or out-of-range overall pick")

    draft_slot_team_ids: list[str] = []
    round_team_ids: dict[int, set[str]] = {}
    for overall in expected_overalls:
        round_id, round_pick, team_id = by_overall[overall]
        expected_round = math.ceil(overall / expected_teams)
        expected_round_pick = ((overall - 1) % expected_teams) + 1
        if round_id != expected_round or round_pick != expected_round_pick:
            raise DraftInitError(f"draft slot metadata mismatch at overall pick {overall}")
        draft_slot_team_ids.append(team_id)
        round_team_ids.setdefault(round_id, set()).add(team_id)

    # draftDetail.picks is authoritative. Keeper placement and commissioner
    # adjustments can legitimately diverge from the simple alternating
    # draftSettings.pickOrder. Every
    # round must still allocate exactly one slot to every league team.
    for round_id in range(1, expected_rounds + 1):
        if round_team_ids.get(round_id) != set(team_ids):
            raise DraftInitError(f"round {round_id} does not contain every team exactly once")

    catalog_version, catalog = _validate_catalog(catalog_document)
    display_name = league_json.get("name")
    if not isinstance(display_name, str) or not display_name.strip() or len(display_name.strip()) > 120:
        display_name = f"ESPN league {league_id}"
    return {
        "schemaVersion": 1,
        "draftKey": f"{environment}:espn:ffl:{season}:{league_id}:{draft_epoch}",
        "displayName": display_name.strip(),
        "expectedTeams": expected_teams,
        "expectedRounds": expected_rounds,
        "totalPickSlots": total_pick_slots,
        "managedTeamId": managed,
        "draftSlotTeamIds": draft_slot_team_ids,
        "rosterTargets": roster_targets,
        "pinnedCatalogVersion": catalog_version,
        "catalog": catalog,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league-id", required=True, type=int)
    parser.add_argument("--season", required=True, type=int)
    parser.add_argument("--managed-team-id", required=True)
    parser.add_argument("--environment", choices=("local", "staging"), default="staging")
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--fixture", type=Path, help="offline league JSON; bypasses network")
    parser.add_argument("--timeout", type=float, default=20.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.league_id <= 0 or not 2000 <= args.season <= 2200 or args.timeout <= 0:
        raise SystemExit("league id, season, and timeout must be positive and in range")
    league_json = (
        load_json(args.fixture, "league fixture")
        if args.fixture
        else fetch_league(args.league_id, args.season, timeout=args.timeout)
    )
    result = build_draft_init(
        league_json,
        load_json(args.catalog, "catalog"),
        league_id=args.league_id,
        season=args.season,
        managed_team_id=args.managed_team_id,
        environment=args.environment,
    )
    atomic_json_write(args.output, result)
    print(
        json.dumps(
            {
                "output": str(args.output),
                "draftKey": result["draftKey"],
                "totalPickSlots": result["totalPickSlots"],
                "catalogPlayers": len(result["catalog"]),
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
