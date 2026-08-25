import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "build_draft_init.py"
SPEC = importlib.util.spec_from_file_location("build_draft_init", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


def catalog():
    return {
        "catalogVersion": "espn-2026-test",
        "catalog": [
            {
                "playerId": "101", "name": "Runner", "position": "RB", "nflTeam": "CHI",
                "tier": "T2", "roleClass": "RB1", "opportunityScore": 80,
                "intrinsicScore": 75, "pickNowScore": 72, "returnProbability": None,
                "reasons": [], "risks": [], "eligibleSlots": [2, 3, 23],
            },
            {
                "playerId": "-16034", "name": "Detroit D/ST", "position": "D/ST",
                "nflTeam": "DET", "tier": "T8", "roleClass": "D/ST",
                "opportunityScore": 10, "intrinsicScore": 20, "pickNowScore": 5,
                "returnProbability": None, "reasons": [], "risks": [],
            },
        ],
    }


def league(team_count=12, rounds=17):
    order = list(range(1, team_count + 1))
    picks = []
    overall = 1
    for round_id in range(1, rounds + 1):
        round_order = order if round_id % 2 else list(reversed(order))
        for round_pick, team_id in enumerate(round_order, 1):
            picks.append({
                "id": overall,
                "overallPickNumber": overall,
                "roundId": round_id,
                "roundPickNumber": round_pick,
                "teamId": team_id,
                "playerId": -1,
            })
            overall += 1
    return {
        "id": 123456789,
        "seasonId": 2026,
        "settings": {
            "size": team_count,
            "draftSettings": {"type": "SNAKE", "pickOrder": order, "date": 1788033600000},
            "rosterSettings": {
                "lineupSlotCounts": {
                    "0": 1, "2": 2, "4": 3, "6": 1, "16": 1,
                    "17": 1, "20": 7, "21": 1, "23": 1,
                }
            },
        },
        "teams": [{"id": team_id, "name": f"Team {team_id}"} for team_id in order],
        "draftDetail": {"drafted": False, "inProgress": False, "picks": picks},
        "status": {"isActive": True},
    }


class DraftInitBuilderTests(unittest.TestCase):
    def build(self, body=None, catalog_document=None):
        return module.build_draft_init(
            body or league(), catalog_document or catalog(),
            league_id=123456789, season=2026, managed_team_id="7",
        )

    def test_league_shape_snake_order_and_roster_targets(self):
        result = self.build()
        self.assertEqual(result["draftKey"], "staging:espn:ffl:2026:123456789:1788033600000")
        self.assertEqual(result["displayName"], "ESPN league 123456789")
        self.assertEqual(result["expectedTeams"], 12)
        self.assertEqual(result["expectedRounds"], 17)
        self.assertEqual(result["totalPickSlots"], 204)
        self.assertEqual(result["draftSlotTeamIds"][:12], [str(i) for i in range(1, 13)])
        self.assertEqual(result["draftSlotTeamIds"][12:24], [str(i) for i in range(12, 0, -1)])
        self.assertEqual(result["rosterTargets"], {"QB": 1, "RB": 2, "WR": 3, "TE": 1, "FLEX": 1})
        self.assertEqual(result["managedTeamId"], "7")

    def test_catalog_version_is_pinned_and_negative_dst_is_retained(self):
        result = self.build()
        self.assertEqual(result["pinnedCatalogVersion"], "espn-2026-test")
        self.assertIn("-16034", [player["playerId"] for player in result["catalog"]])
        self.assertEqual(result["catalog"][0]["eligibleSlots"], [2, 3, 23])

    def test_input_pick_array_order_does_not_change_output(self):
        body = league()
        body["draftDetail"]["picks"].reverse()
        result = self.build(body)
        self.assertEqual(result["draftSlotTeamIds"][:2], ["1", "2"])

    def test_rejects_gaps_duplicates_and_slot_metadata_mismatch(self):
        cases = []
        gap = league()
        gap["draftDetail"]["picks"].pop(4)
        cases.append(gap)
        duplicate = league()
        duplicate["draftDetail"]["picks"][-1]["overallPickNumber"] = 1
        cases.append(duplicate)
        mismatch = league()
        mismatch["draftDetail"]["picks"][12]["roundPickNumber"] = 2
        cases.append(mismatch)
        wrong_team = league()
        wrong_team["draftDetail"]["picks"][12]["teamId"] = 11
        cases.append(wrong_team)
        for body in cases:
            with self.subTest(case=cases.index(body)), self.assertRaises(module.DraftInitError):
                self.build(body)

    def test_rejects_identity_team_shape_and_completed_phase_mismatches(self):
        mutations = []
        wrong_league = league()
        wrong_league["id"] = 99
        mutations.append(wrong_league)
        no_member = league()
        mutations.append(no_member)
        drafted = league()
        drafted["draftDetail"]["drafted"] = True
        mutations.append(drafted)
        with self.assertRaises(module.DraftInitError):
            self.build(mutations[0])
        with self.assertRaises(module.DraftInitError):
            module.build_draft_init(
                mutations[1], catalog(), league_id=123456789, season=2026, managed_team_id="99"
            )
        with self.assertRaises(module.DraftInitError):
            self.build(mutations[2])

    def test_live_draft_is_valid_for_recovery_initialization(self):
        body = league()
        body["draftDetail"]["inProgress"] = True
        self.assertEqual(self.build(body)["totalPickSlots"], 204)

    def test_atomic_output_is_deterministic(self):
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "first.json"
            second = Path(directory) / "second.json"
            result = self.build()
            module.atomic_json_write(first, result)
            module.atomic_json_write(second, result)
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_fetch_is_one_cookie_free_get_with_required_views(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(league()).encode()
        with mock.patch.object(module.urllib.request, "urlopen", return_value=response) as opened:
            result = module.fetch_league(123456789, 2026, timeout=3)
        self.assertEqual(result["id"], 123456789)
        request = opened.call_args.args[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertNotIn("Cookie", request.headers)
        self.assertEqual(opened.call_count, 1)
        self.assertEqual(module.VIEWS, tuple(module.urllib.parse.parse_qs(request.full_url.split("?", 1)[1])["view"]))


if __name__ == "__main__":
    unittest.main()
