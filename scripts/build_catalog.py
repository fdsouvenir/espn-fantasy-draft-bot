#!/usr/bin/env python3
"""Build a deterministic, read-only ESPN fantasy-football player catalog.

Only public ESPN JSON endpoints are read. The emitted player records match the
Worker's CatalogPlayerV1 contract; the envelope adds reproducibility metadata.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SEASON = 2026
KONA_URL = (
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/"
    f"{SEASON}/segments/0/leaguedefaults/3?view=kona_player_info"
)
SCHEDULE_URL = (
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/"
    f"{SEASON}?view=proTeamSchedules_wl"
)
LEAGUE_KONA_URL = (
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/"
    f"{SEASON}/segments/0/leagues/{{league_id}}?view=kona_player_info"
)
DEPTH_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/"
    "{team_slug}/depthcharts"
)

# ESPN's 32 active NFL team ids (31 and 32 are historical/inactive).
TEAM_ABBR: dict[int, str] = {
    1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
    7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC",
    13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO",
    19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
    25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX",
    33: "BAL", 34: "HOU",
}
POSITION_BY_ID = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}
SUPPORTED_POSITIONS = frozenset(POSITION_BY_ID.values())
# Special-teams depth groups (KR/PR/LS/H) are not evidence of offensive
# workload. Only fantasy-relevant athlete positions may drive opportunity.
FANTASY_DEPTH_POSITIONS = frozenset({"QB", "RB", "WR", "TE", "K"})
KONA_FILTER = json.dumps(
    {
        "players": {
            "limit": 5000,
            "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
        }
    },
    separators=(",", ":"),
)


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def source_record_count(value: Any, source_kind: str) -> int:
    """Count normalized source records without retaining unneeded source text."""
    if source_kind in {"kona", "league-kona"}:
        return len(player_rows(value))
    if source_kind == "schedule":
        return len(find_pro_teams(value))
    if source_kind == "depth-chart":
        return len(extract_depth(value))
    return 0


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@dataclass(frozen=True)
class FetchResult:
    data: Any
    fetched_at: str
    etag: str | None
    from_cache: bool


class JsonFetcher:
    """Small JSON client with bounded retries and conditional ETag caching."""

    def __init__(self, cache_dir: Path, timeout: float, retries: int, now: str):
        self.cache_dir = cache_dir
        self.timeout = timeout
        self.retries = retries
        self.now = now
        cache_dir.mkdir(parents=True, exist_ok=True)

    def _cache_path(self, url: str) -> Path:
        return self.cache_dir / f"{hashlib.sha256(url.encode()).hexdigest()}.json"

    def _read_cache(self, url: str) -> dict[str, Any] | None:
        path = self._cache_path(url)
        if not path.exists():
            return None
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("url") == url and "data" in value:
                return value
        except (OSError, json.JSONDecodeError):
            pass
        return None

    def _write_cache(self, url: str, etag: str | None, data: Any) -> None:
        atomic_json_write(
            self._cache_path(url),
            {"url": url, "etag": etag, "fetchedAt": self.now, "data": data},
        )

    def get(self, url: str, extra_headers: dict[str, str] | None = None) -> FetchResult:
        cached = self._read_cache(url)
        headers = {
            "Accept": "application/json",
            # ESPN's public site endpoint rejects non-browser User-Agent families.
            "User-Agent": "Mozilla/5.0 (compatible; FDS-ESPN-Draft-Helper/1.0; private-read-only)",
        }
        if extra_headers:
            headers.update(extra_headers)
        if cached and cached.get("etag"):
            headers["If-None-Match"] = str(cached["etag"])

        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                request = urllib.request.Request(url, headers=headers, method="GET")
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read()
                    data = json.loads(raw.decode("utf-8"))
                    etag = response.headers.get("ETag")
                    self._write_cache(url, etag, data)
                    return FetchResult(data, self.now, etag, False)
            except urllib.error.HTTPError as exc:
                if exc.code == 304 and cached:
                    return FetchResult(
                        cached["data"], str(cached["fetchedAt"]), cached.get("etag"), True
                    )
                last_error = exc
                if exc.code not in {408, 429, 500, 502, 503, 504}:
                    break
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last_error = exc
            if attempt < self.retries:
                # Short bounded jitter avoids synchronized retries; no secrets are logged.
                time.sleep(min(2.0, 0.25 * (2**attempt)) + random.random() * 0.1)
        raise RuntimeError(f"read failed for ESPN endpoint after {self.retries + 1} attempts") from last_error


def atomic_json_write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def first_number(*values: Any) -> float | None:
    for value in values:
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            return float(value)
    return None


def extract_rank(player: dict[str, Any], wrapper: dict[str, Any]) -> int | None:
    candidates: list[Any] = []
    ranks = player.get("draftRanksByRankType")
    if isinstance(ranks, dict):
        for key in ("PPR", "STANDARD", "default"):
            item = ranks.get(key)
            if isinstance(item, dict):
                candidates.extend([item.get("rank"), item.get("overallRank")])
    for owner in (player, wrapper):
        candidates.extend([owner.get("rank"), owner.get("overallRank")])
    rank = first_number(*candidates)
    return max(1, int(rank)) if rank is not None else None


def ppr_rank_record(player: dict[str, Any]) -> dict[str, Any]:
    ranks = player.get("draftRanksByRankType")
    record = ranks.get("PPR") if isinstance(ranks, dict) else None
    return record if isinstance(record, dict) else {}


def full_season_projection(player: dict[str, Any]) -> float | None:
    """Select only ESPN's confirmed full-season projected-stat row."""
    stats = player.get("stats")
    if not isinstance(stats, list):
        return None
    for row in stats:
        if not isinstance(row, dict):
            continue
        if (
            row.get("seasonId") == SEASON
            and row.get("statSourceId") == 1
            and row.get("statSplitTypeId") == 0
            and row.get("scoringPeriodId") == 0
        ):
            value = first_number(row.get("appliedTotal"))
            return round(value, 4) if value is not None else None
    return None


def player_index(kona_json: Any) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for wrapper in player_rows(kona_json):
        player = wrapper.get("player")
        if not isinstance(player, dict):
            continue
        raw_id = player.get("id", wrapper.get("id"))
        if isinstance(raw_id, (str, int)) and not isinstance(raw_id, bool):
            result[str(raw_id)] = player
    return result


def ownership_as_of(kona_json: Any) -> str | None:
    newest_ms: int | None = None
    for player in player_index(kona_json).values():
        ownership = player.get("ownership")
        value = ownership.get("date") if isinstance(ownership, dict) else None
        if isinstance(value, int) and value > 0:
            newest_ms = value if newest_ms is None else max(newest_ms, value)
    if newest_ms is None:
        return None
    return datetime.fromtimestamp(newest_ms / 1000, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def extract_depth(depth_json: Any) -> dict[str, tuple[str, int]]:
    """Return athlete id -> (depth position abbreviation, ordinal)."""
    result: dict[str, tuple[str, int]] = {}

    def parse_group(node: dict[str, Any], slot_hint: str | None = None) -> None:
        athletes = node.get("athletes")
        position = node.get("position")
        if not isinstance(athletes, list) or not isinstance(position, dict):
            return
        abbreviation = str(position.get("abbreviation") or "").upper().strip()
        if abbreviation not in FANTASY_DEPTH_POSITIONS:
            return
        slot_match = re.search(r"(\d+)$", slot_hint or "")
        slot_ordinal = int(slot_match.group(1)) if slot_match else None
        for index, item in enumerate(athletes, 1):
            if not isinstance(item, dict):
                continue
            # Current public responses put athlete fields directly on each
            # list item; older fixture shapes nested them under ``athlete``.
            athlete = item.get("athlete") if isinstance(item.get("athlete"), dict) else item
            athlete_id = athlete.get("id")
            if athlete_id is None:
                continue
            explicit = first_number(item.get("rank"), item.get("slot"))
            ordinal = max(1, int(explicit)) if explicit is not None else (
                slot_ordinal + index - 1 if slot_ordinal is not None else index
            )
            key = str(athlete_id)
            current = result.get(key)
            if current is None or ordinal < current[1]:
                result[key] = (abbreviation, ordinal)

    def visit(node: Any, slot_hint: str | None = None) -> None:
        if isinstance(node, dict):
            parse_group(node, slot_hint)
            for key, child in node.items():
                if key == "positions" and isinstance(child, dict):
                    for slot_key, group in child.items():
                        if isinstance(group, dict):
                            visit(group, str(slot_key))
                    continue
                visit(child)
        elif isinstance(node, list):
            for child in node:
                visit(child)

    visit(depth_json)
    return result


def find_pro_teams(node: Any) -> list[dict[str, Any]]:
    if isinstance(node, dict):
        teams = node.get("proTeams")
        if isinstance(teams, list):
            return [team for team in teams if isinstance(team, dict)]
        for child in node.values():
            found = find_pro_teams(child)
            if found:
                return found
    elif isinstance(node, list):
        for child in node:
            found = find_pro_teams(child)
            if found:
                return found
    return []


def normalize_team_context(schedule_json: Any) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for team in find_pro_teams(schedule_json):
        team_id = team.get("id")
        if not isinstance(team_id, int) or team_id not in TEAM_ABBR:
            continue
        bye = team.get("byeWeek")
        result[TEAM_ABBR[team_id]] = {
            "espnProTeamId": team_id,
            "byeWeek": int(bye) if isinstance(bye, int) and 1 <= bye <= 25 else None,
        }
    return dict(sorted(result.items()))


def player_rows(kona_json: Any) -> list[dict[str, Any]]:
    if isinstance(kona_json, dict) and isinstance(kona_json.get("players"), list):
        return [row for row in kona_json["players"] if isinstance(row, dict)]
    raise ValueError("kona_player_info response did not contain a players array")


def normalized_score(rank: int | None) -> float:
    if rank is None:
        return 0.0
    # Keep headroom for live roster/ADP adjustments; otherwise every elite
    # starter saturates at 100 and the decision score stops being informative.
    return round(max(0.0, 90.0 - (rank - 1) * 0.25), 2)


def depth_score(ordinal: int | None) -> float:
    # This is an ordinal signal, not a claimed snap/touch/workload percentage.
    if ordinal is None:
        return 0.0
    return round(100.0 / ordinal, 2)


def normalize_players(
    kona_json: Any,
    depth_by_team: dict[int, dict[str, tuple[str, int]]],
    team_context: dict[str, dict[str, Any]] | None = None,
    league_player_data: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    catalog: list[dict[str, Any]] = []
    seen: set[str] = set()
    for wrapper in player_rows(kona_json):
        player = wrapper.get("player")
        if not isinstance(player, dict):
            continue
        raw_id = player.get("id", wrapper.get("id"))
        if not isinstance(raw_id, (int, str)) or isinstance(raw_id, bool):
            continue
        player_id = str(raw_id).strip()
        if not player_id or player_id in seen or player_id == "-1":
            continue
        name = player.get("fullName") or player.get("displayName")
        if not isinstance(name, str) or not name.strip():
            continue
        raw_position = player.get("defaultPositionId")
        position = POSITION_BY_ID.get(raw_position) if isinstance(raw_position, int) else None
        if position is None:
            candidate = str(player.get("position") or "").upper().strip()
            position = candidate if candidate in SUPPORTED_POSITIONS else None
        if position is None:
            continue
        raw_team = player.get("proTeamId")
        team_id = raw_team if isinstance(raw_team, int) else 0
        nfl_team = TEAM_ABBR.get(team_id, "FA")
        rank = extract_rank(player, wrapper)
        ppr_rank = ppr_rank_record(player)
        ownership = player.get("ownership") if isinstance(player.get("ownership"), dict) else {}
        depth = depth_by_team.get(team_id, {}).get(player_id)
        depth_position, ordinal = depth if depth else (position, None)
        role_class = position if position in {"K", "D/ST"} else (
            f"{depth_position or position}{ordinal}" if ordinal else f"{position}-unlisted"
        )
        opportunity = depth_score(ordinal)
        intrinsic = normalized_score(rank)
        # Preserve contextual headroom for roster fit, scarcity, reviewed Sheet
        # adjustments, and return urgency. The base catalog is not a final pick score.
        pick_now = round(0.78 * intrinsic + 0.12 * opportunity, 2)
        reasons: list[str] = []
        risks: list[str] = []
        if rank is not None:
            reasons.append(f"ESPN PPR rank {rank}")
        else:
            risks.append("ESPN PPR rank unavailable")
        if ordinal is not None:
            reasons.append(f"Public depth-chart ordinal {ordinal}")
        elif position not in {"K", "D/ST"}:
            risks.append("Not listed on the public team depth chart")
        tier_number = min(12, max(1, math.ceil(rank / 24))) if rank else 12
        record: dict[str, Any] = {
                "playerId": player_id,
                "name": name.strip(),
                "position": position,
                "nflTeam": nfl_team,
                "tier": f"T{tier_number}",
                "roleClass": role_class,
                "opportunityScore": opportunity,
                "intrinsicScore": intrinsic,
                "pickNowScore": pick_now,
                "returnProbability": None,
                "reasons": reasons,
                "risks": risks,
        }
        adp = first_number(ownership.get("averageDraftPosition"))
        projection_player = (
            league_player_data.get(player_id, {})
            if league_player_data is not None
            else player
        )
        projected = full_season_projection(projection_player)
        percent_owned = first_number(ownership.get("percentOwned"))
        auction_value = first_number(ppr_rank.get("auctionValue"))
        eligible_slots = player.get("eligibleSlots")
        injury_status = player.get("injuryStatus")
        bye_week = (team_context or {}).get(nfl_team, {}).get("byeWeek")
        if adp is not None and adp >= 0:
            record["adp"] = round(adp, 4)
        if projected is not None:
            record["projectedPoints"] = projected
        if percent_owned is not None and 0 <= percent_owned <= 100:
            record["percentOwned"] = round(percent_owned, 4)
        if auction_value is not None and auction_value >= 0:
            record["auctionValue"] = round(auction_value, 2)
        if isinstance(bye_week, int) and 1 <= bye_week <= 25:
            record["byeWeek"] = bye_week
        if isinstance(eligible_slots, list):
            safe_slots = [slot for slot in eligible_slots if isinstance(slot, int) and not isinstance(slot, bool) and 0 <= slot <= 99]
            if safe_slots:
                record["eligibleSlots"] = safe_slots
        if isinstance(injury_status, str) and re.fullmatch(r"[A-Z_]{2,32}", injury_status):
            record["injuryStatus"] = injury_status
        if depth is not None:
            record["depthPosition"] = depth_position
            record["depthOrdinal"] = ordinal
        catalog.append(record)
        seen.add(player_id)
    return sorted(catalog, key=lambda p: (-p["pickNowScore"], p["name"], p["playerId"]))


def fixture_result(path: Path, now: str) -> FetchResult:
    data = json.loads(path.read_text(encoding="utf-8"))
    return FetchResult(data, now, None, False)


def build_catalog(
    *,
    output: Path,
    cache_dir: Path,
    fixture_dir: Path | None,
    timeout: float,
    retries: int,
    now: str,
    league_id: int | None = None,
) -> dict[str, Any]:
    parse_timestamp(now)  # Validate caller-supplied reproducibility timestamp.
    fetcher = JsonFetcher(cache_dir, timeout, retries, now)
    sources: list[dict[str, Any]] = []

    def load(
        url: str,
        fixture_name: str,
        source_kind: str,
        headers: dict[str, str] | None = None,
    ) -> FetchResult:
        result = (
            fixture_result(fixture_dir / fixture_name, now)
            if fixture_dir is not None
            else fetcher.get(url, headers)
        )
        source_metadata: dict[str, Any] = {
                "url": url,
                "fetchedAt": result.fetched_at,
                "etag": result.etag,
                "fromCache": result.from_cache,
                "contentSha256": digest(result.data),
                "recordCount": source_record_count(result.data, source_kind),
                "sourceKind": source_kind,
        }
        if headers and "x-fantasy-filter" in headers:
            source_metadata["requestFilter"] = json.loads(headers["x-fantasy-filter"])
        sources.append(source_metadata)
        return result

    kona = load(
        KONA_URL,
        "kona_player_info.json",
        "kona",
        {"x-fantasy-filter": KONA_FILTER},
    ).data
    league_kona: Any | None = None
    if league_id is not None:
        league_url = LEAGUE_KONA_URL.format(league_id=league_id)
        league_kona = load(
            league_url,
            "league_kona_player_info.json",
            "league-kona",
            {"x-fantasy-filter": KONA_FILTER},
        ).data
        sources[-1]["authentication"] = "none"
        sources[-1]["cookiesSent"] = False
    schedule = load(SCHEDULE_URL, "pro_team_schedules.json", "schedule").data
    depth_by_team: dict[int, dict[str, tuple[str, int]]] = {}
    for team_id in sorted(TEAM_ABBR):
        team_slug = TEAM_ABBR[team_id].lower()
        url = DEPTH_URL.format(team_slug=team_slug)
        depth = load(url, f"depthchart-{team_slug}.json", "depth-chart").data
        depth_by_team[team_id] = extract_depth(depth)

    team_context = normalize_team_context(schedule)
    catalog = normalize_players(
        kona,
        depth_by_team,
        team_context,
        player_index(league_kona) if league_kona is not None else None,
    )
    if not catalog:
        raise ValueError("normalization produced an empty catalog")
    fetched_times = [parse_timestamp(source["fetchedAt"]) for source in sources]
    oldest = min(fetched_times)
    newest = max(fetched_times)
    envelope: dict[str, Any] = {
        "schemaVersion": 1,
        "season": SEASON,
        "generatedAt": now,
        "catalogVersion": "pending",
        "catalogSha256": digest(catalog),
        "catalog": catalog,
        "teamContext": team_context,
        "freshness": {
            "oldestSourceAt": oldest.isoformat().replace("+00:00", "Z"),
            "newestSourceAt": newest.isoformat().replace("+00:00", "Z"),
            "sourceCount": len(sources),
            "depthChartsExpected": len(TEAM_ABBR),
            "depthChartsLoaded": len(depth_by_team),
            "konaPlayersReturned": len(player_rows(kona)),
            "catalogPlayersRetained": len(catalog),
        },
        "provenance": {
            "provider": "ESPN public JSON endpoints",
            "readOnly": True,
            "scoringFormat": "PPR",
            "leagueDefaultId": 3,
            "projectionScoring": (
                {"mode": "league", "leagueId": league_id, "authenticated": False}
                if league_id is not None
                else {"mode": "ESPN PPR default", "leagueId": None, "authenticated": False}
            ),
            "projectionStatSelector": {
                "seasonId": SEASON,
                "statSourceId": 1,
                "statSplitTypeId": 0,
                "scoringPeriodId": 0,
            },
            "marketOwnershipAsOf": ownership_as_of(kona),
            "completeness": {
                "konaRequestedLimit": 5000,
                "konaReturnedPlayers": len(player_rows(kona)),
                "catalogRetainedPlayers": len(catalog),
                "playersViewUsed": False,
                "playersViewReason": (
                    "kona_player_info returned below its 5000-player request limit; "
                    "a second players_wl payload would not add a proven completeness signal"
                ),
                "publicDepthChartsRequested": len(TEAM_ABBR),
                "publicDepthChartsLoaded": len(depth_by_team),
            },
            "fieldsRetained": [
                "player identity", "fantasy position", "NFL team", "PPR rank",
                "ADP", "projected points", "percent owned", "auction value",
                "eligible slots", "injury status", "depth position",
                "depth ordinal", "bye week",
            ],
            "sources": sources,
        },
    }
    envelope["catalogVersion"] = f"espn-{SEASON}-{envelope['catalogSha256'][:12]}"
    atomic_json_write(output, envelope)
    return envelope


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--cache-dir", type=Path, default=Path(".cache/espn-catalog"))
    result.add_argument("--fixture-dir", type=Path, help="Offline fixture directory; performs no network calls")
    result.add_argument("--timeout", type=float, default=15.0)
    result.add_argument("--retries", type=int, default=3)
    result.add_argument("--league-id", type=int, help="Public ESPN league id for league-scored projections (GET only)")
    result.add_argument("--now", default=None, help="ISO-8601 generation time (for reproducible fixtures)")
    return result


def main(argv: Iterable[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.timeout <= 0 or not 0 <= args.retries <= 8:
        raise SystemExit("timeout must be positive and retries must be between 0 and 8")
    if args.league_id is not None and args.league_id <= 0:
        raise SystemExit("league id must be positive")
    if args.fixture_dir is not None and not args.fixture_dir.is_dir():
        raise SystemExit("fixture directory does not exist")
    envelope = build_catalog(
        output=args.output,
        cache_dir=args.cache_dir,
        fixture_dir=args.fixture_dir,
        timeout=args.timeout,
        retries=args.retries,
        now=args.now or utc_now(),
        league_id=args.league_id,
    )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "catalogVersion": envelope["catalogVersion"],
                "players": len(envelope["catalog"]),
                "sources": envelope["freshness"]["sourceCount"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
