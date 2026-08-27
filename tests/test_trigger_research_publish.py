import importlib.util
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "scripts" / "trigger_research_publish.py"
SPEC = importlib.util.spec_from_file_location("trigger_research_publish", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


class TriggerResearchPublishTests(unittest.TestCase):
    def test_builds_bounded_raw_sheet_trigger_without_classification(self):
        seen = []

        def reader(spreadsheet_id, range_name, account):
            seen.append((spreadsheet_id, range_name, account))
            return [["header"], ["value"]]

        payload = module.build_trigger_payload(
            "sheet-1",
            "owner@example.com",
            "Verl",
            request_id="request-1",
            requested_at="2026-08-27T12:00:00.000Z",
            reader=reader,
        )
        self.assertEqual(payload["requestId"], "request-1")
        self.assertEqual(payload["requestedBy"], "Verl")
        self.assertEqual(set(payload["ranges"]), set(module.IMPORT_TABS))
        self.assertEqual(len(seen), len(module.IMPORT_TABS))

    def test_builds_local_draft_catalog_from_profile_identity_only(self):
        payload = {
            "ranges": {
                tab: [["player_key"], ["espn:101"]] if tab == "RB Profiles" else [["player_key"]]
                for tab in module.PROFILE_TABS
            }
        }
        directory = [[
            "player_key", "player_name", "position", "nfl_team", "base_tier",
            "espn_adp", "base_role", "active", "imported_at", "notes",
        ], ["espn:101", "Runner One", "RB", "CHI", "T2", "24.5", "RB1", "yes", "", ""]]
        result = module.build_local_draft_init(payload, directory, "local:research-pilot")
        self.assertEqual(result["draftKey"], "local:research-pilot")
        self.assertEqual(result["totalPickSlots"], 150)
        self.assertEqual(result["catalog"][0]["playerId"], "101")
        self.assertEqual(result["catalog"][0]["adp"], 24.5)
        self.assertNotIn("researchedRole", result["catalog"][0])

    def test_rejects_non_local_plain_http_publisher(self):
        with self.assertRaisesRegex(ValueError, "must use HTTPS"):
            module.post_trigger(
                {"schemaVersion": 1},
                "http://publisher.example/api/research/publish",
                "t" * 32,
                1,
            )

    def test_reports_remote_validation_problems_without_raw_response(self):
        error = __import__("urllib.error").error.HTTPError(
            "https://publisher.example/api/research/publish", 400, "bad", {}, None
        )
        error.read = lambda _limit: json.dumps({
            "error": "invalid_research_sheet_import",
            "problems": ["RB Profiles row 2 is still marked working"],
        }).encode()
        with patch("urllib.request.urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "still marked working"):
                module.post_trigger(
                    {"schemaVersion": 1},
                    "https://publisher.example/api/research/publish",
                    "t" * 32,
                    1,
                )


if __name__ == "__main__":
    unittest.main()
