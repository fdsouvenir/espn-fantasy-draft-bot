import importlib.util
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "build_catalog.py"
SPEC = importlib.util.spec_from_file_location("build_catalog", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


class CatalogBuilderTests(unittest.TestCase):
    def make_fixtures(self, root: Path) -> None:
        (root / "kona_player_info.json").write_text(
            json.dumps(
                {
                    "players": [
                        {
                            "id": 100,
                            "player": {
                                "id": 100,
                                "fullName": "Running Back",
                                "defaultPositionId": 2,
                                "proTeamId": 1,
                                "draftRanksByRankType": {"PPR": {"rank": 25, "auctionValue": 31}},
                                "ownership": {
                                    "averageDraftPosition": 26.75,
                                    "percentOwned": 91.5,
                                    "date": 1786429811810,
                                },
                                "eligibleSlots": [2, 3, 23],
                                "injuryStatus": "ACTIVE",
                            },
                        },
                        {
                            "id": -16001,
                            "player": {
                                "id": -16001,
                                "fullName": "Atlanta D/ST",
                                "defaultPositionId": 16,
                                "proTeamId": 1,
                                "draftRanksByRankType": {"PPR": {"rank": 190}},
                            },
                        },
                        {"id": -1, "player": {"id": -1, "fullName": "Empty"}},
                    ]
                }
            ),
            encoding="utf-8",
        )
        (root / "pro_team_schedules.json").write_text(
            json.dumps({"settings": {"proTeams": [{"id": 1, "byeWeek": 12}]}}),
            encoding="utf-8",
        )
        for team_id in module.TEAM_ABBR:
            body = {
                "positions": [
                    {
                        "position": {"abbreviation": "RB"},
                        "athletes": [
                            {"rank": 1, "athlete": {"id": "100", "fullName": "Ignored prose"}}
                        ],
                    }
                ]
            } if team_id == 1 else {"positions": []}
            team_slug = module.TEAM_ABBR[team_id].lower()
            (root / f"depthchart-{team_slug}.json").write_text(json.dumps(body), encoding="utf-8")

    def test_offline_build_is_deterministic_and_contract_compatible(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixtures = root / "fixtures"
            fixtures.mkdir()
            self.make_fixtures(fixtures)
            output_a = root / "a.json"
            output_b = root / "b.json"
            kwargs = dict(
                cache_dir=root / "cache", fixture_dir=fixtures, timeout=1, retries=0,
                now="2026-08-11T12:00:00Z",
            )
            with mock.patch.object(module.urllib.request, "urlopen", side_effect=AssertionError("network")):
                first = module.build_catalog(output=output_a, **kwargs)
                second = module.build_catalog(output=output_b, **kwargs)
            self.assertEqual(output_a.read_bytes(), output_b.read_bytes())
            self.assertEqual(first, second)
            self.assertEqual(first["freshness"]["sourceCount"], 34)
            self.assertEqual(first["freshness"]["depthChartsLoaded"], 32)
            self.assertEqual(first["freshness"]["konaPlayersReturned"], 3)
            self.assertEqual(first["freshness"]["catalogPlayersRetained"], 2)
            self.assertEqual(first["teamContext"]["ATL"]["byeWeek"], 12)
            required = {
                "playerId", "name", "position", "nflTeam", "tier", "roleClass",
                "opportunityScore", "intrinsicScore", "pickNowScore",
                "returnProbability", "reasons", "risks",
            }
            self.assertTrue(all(required <= set(player) for player in first["catalog"]))
            running_back = next(player for player in first["catalog"] if player["playerId"] == "100")
            self.assertEqual(running_back["adp"], 26.75)
            self.assertEqual(running_back["percentOwned"], 91.5)
            self.assertEqual(running_back["auctionValue"], 31.0)
            self.assertEqual(running_back["byeWeek"], 12)
            self.assertEqual(running_back["eligibleSlots"], [2, 3, 23])
            self.assertEqual(running_back["injuryStatus"], "ACTIVE")
            self.assertEqual(running_back["depthPosition"], "RB")
            self.assertEqual(running_back["depthOrdinal"], 1)
            self.assertEqual(first["provenance"]["scoringFormat"], "PPR")
            self.assertEqual(first["provenance"]["marketOwnershipAsOf"], "2026-08-11T06:30:11Z")
            self.assertFalse(first["provenance"]["completeness"]["playersViewUsed"])
            self.assertEqual(first["provenance"]["sources"][0]["recordCount"], 3)
            self.assertEqual(first["provenance"]["sources"][0]["sourceKind"], "kona")

    def test_negative_dst_id_is_preserved_and_empty_sentinel_is_excluded(self):
        rows = {
            "players": [
                {"player": {"id": -16034, "fullName": "Detroit D/ST", "defaultPositionId": 16, "proTeamId": 8}},
                {"player": {"id": -1, "fullName": "Empty", "defaultPositionId": 16, "proTeamId": 0}},
            ]
        }
        catalog = module.normalize_players(rows, {})
        self.assertEqual([player["playerId"] for player in catalog], ["-16034"])

    def test_depth_parser_keeps_only_id_position_and_ordinal(self):
        body = {
            "depthchart": [{
                "positions": [{
                    "position": {"abbreviation": "WR", "displayName": "Wide Receiver"},
                    "athletes": [
                        {"slot": 1, "athlete": {"id": "7", "fullName": "Do Not Copy"}},
                        {"slot": 2, "athlete": {"id": "8", "fullName": "Do Not Copy Either"}},
                    ],
                }]
            }]
        }
        self.assertEqual(module.extract_depth(body), {"7": ("WR", 1), "8": ("WR", 2)})

    def test_live_depth_shape_uses_slot_key_and_direct_athlete_ids(self):
        body = {"depthchart": [{"positions": {
            "wr1": {"position": {"abbreviation": "WR"}, "athletes": [{"id": "7"}, {"id": "8"}]},
            "wr2": {"position": {"abbreviation": "WR"}, "athletes": [{"id": "9"}]},
        }}]}
        self.assertEqual(
            module.extract_depth(body),
            {"7": ("WR", 1), "8": ("WR", 2), "9": ("WR", 2)},
        )

    def test_special_teams_depth_role_cannot_override_offensive_depth(self):
        body = {"depthchart": [{"positions": {
            "rb2": {"position": {"abbreviation": "RB"}, "athletes": [{"id": "7"}]},
            "kr1": {"position": {"abbreviation": "KR"}, "athletes": [{"id": "7"}]},
            "pr1": {"position": {"abbreviation": "PR"}, "athletes": [{"id": "8"}]},
        }}]}
        self.assertEqual(module.extract_depth(body), {"7": ("RB", 2)})

    def test_rank_and_depth_scores_are_numeric_signals_not_workload_claims(self):
        rows = {"players": [{"player": {
            "id": 7, "fullName": "Receiver", "defaultPositionId": 3, "proTeamId": 1,
            "draftRanksByRankType": {"PPR": {"rank": 12}},
        }}]}
        player = module.normalize_players(rows, {1: {"7": ("WR", 2)}})[0]
        self.assertEqual(player["roleClass"], "WR2")
        self.assertEqual(player["opportunityScore"], 50.0)
        self.assertLess(player["pickNowScore"], 90.0)
        self.assertNotIn("share", json.dumps(player).lower())

    def test_real_emitted_role_values_and_base_scores_preserve_contextual_headroom(self):
        rows = {"players": [
            {"player": {"id": 1, "fullName": "Lead Back", "defaultPositionId": 2,
                         "proTeamId": 1, "draftRanksByRankType": {"PPR": {"rank": 1}}}},
            {"player": {"id": 2, "fullName": "Unlisted Back", "defaultPositionId": 2,
                         "proTeamId": 1, "draftRanksByRankType": {"PPR": {"rank": 2}}}},
        ]}
        catalog = module.normalize_players(rows, {1: {"1": ("RB", 1)}})
        lead = next(player for player in catalog if player["playerId"] == "1")
        unlisted = next(player for player in catalog if player["playerId"] == "2")
        self.assertEqual(lead["roleClass"], "RB1")
        self.assertEqual(unlisted["roleClass"], "RB-unlisted")
        self.assertLess(lead["pickNowScore"], 90.0)

    def test_normalization_whitelists_fields(self):
        rows = {"players": [{"secret": "drop", "player": {
            "id": 9, "fullName": "Quarterback", "defaultPositionId": 1, "proTeamId": 2,
            "editorial": "copyrighted prose", "injuryStatus": "drop",
        }}]}
        serialized = json.dumps(module.normalize_players(rows, {}))
        self.assertNotIn("secret", serialized)
        self.assertNotIn("copyrighted", serialized)
        self.assertNotIn("injuryStatus", serialized)

    def test_league_projection_uses_exact_selector_but_ppr_market_rank(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixtures = root / "fixtures"
            fixtures.mkdir()
            self.make_fixtures(fixtures)
            (fixtures / "league_kona_player_info.json").write_text(
                json.dumps({"players": [{"player": {
                    "id": 100,
                    "draftRanksByRankType": {"PPR": {"rank": 999}},
                    "stats": [
                        {"seasonId": 2026, "statSourceId": 1, "statSplitTypeId": 0,
                         "scoringPeriodId": 1, "appliedTotal": 9999},
                        {"seasonId": 2026, "statSourceId": 0, "statSplitTypeId": 0,
                         "scoringPeriodId": 0, "appliedTotal": 8888},
                        {"seasonId": 2026, "statSourceId": 1, "statSplitTypeId": 0,
                         "scoringPeriodId": 0, "appliedTotal": 111.25491},
                    ],
                }}]}),
                encoding="utf-8",
            )
            result = module.build_catalog(
                output=root / "catalog.json", cache_dir=root / "cache", fixture_dir=fixtures,
                timeout=1, retries=0, now="2026-08-11T12:00:00Z", league_id=123456789,
            )
            player = next(item for item in result["catalog"] if item["playerId"] == "100")
            self.assertEqual(player["projectedPoints"], 111.2549)
            self.assertEqual(player["tier"], "T2")  # Default-PPR rank 25, not league rank 999.
            self.assertEqual(result["freshness"]["sourceCount"], 35)
            self.assertEqual(result["provenance"]["projectionScoring"]["leagueId"], 123456789)
            league_source = next(
                source for source in result["provenance"]["sources"]
                if "/leagues/123456789?" in source["url"]
            )
            self.assertFalse(league_source["cookiesSent"])
            self.assertEqual(league_source["authentication"], "none")

    def test_league_mode_never_falls_back_to_default_scoring_projection(self):
        rows = {"players": [{"player": {
            "id": 7, "fullName": "Receiver", "defaultPositionId": 3, "proTeamId": 1,
            "stats": [{"seasonId": 2026, "statSourceId": 1, "statSplitTypeId": 0,
                       "scoringPeriodId": 0, "appliedTotal": 321.0}],
        }}]}
        player = module.normalize_players(rows, {}, league_player_data={})[0]
        self.assertNotIn("projectedPoints", player)

    def test_fetcher_uses_etag_cache_on_not_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            fetcher = module.JsonFetcher(Path(directory), timeout=1, retries=0, now="2026-08-11T12:00:00Z")
            url = "https://example.invalid/public.json"
            fetcher._write_cache(url, '"etag-1"', {"players": [1]})

            def not_modified(request, timeout):
                self.assertEqual(request.get_header("If-none-match"), '"etag-1"')
                raise urllib.error.HTTPError(url, 304, "Not Modified", {}, None)

            with mock.patch.object(module.urllib.request, "urlopen", side_effect=not_modified):
                result = fetcher.get(url)
            self.assertTrue(result.from_cache)
            self.assertEqual(result.data, {"players": [1]})

    def test_fetcher_retries_transient_failure(self):
        class Response:
            headers = {}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"ok":true}'

        transient = urllib.error.HTTPError(
            "https://example.invalid/public.json", 503, "Unavailable", {}, None
        )
        with tempfile.TemporaryDirectory() as directory:
            fetcher = module.JsonFetcher(Path(directory), timeout=1, retries=1, now="2026-08-11T12:00:00Z")
            with mock.patch.object(
                module.urllib.request, "urlopen", side_effect=[transient, Response()]
            ) as opened, mock.patch.object(module.time, "sleep"):
                result = fetcher.get("https://example.invalid/public.json")
            self.assertEqual(opened.call_count, 2)
            self.assertEqual(result.data, {"ok": True})


if __name__ == "__main__":
    unittest.main()
