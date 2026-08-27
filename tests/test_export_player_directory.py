import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "export_player_directory.py"
SPEC = importlib.util.spec_from_file_location("export_player_directory", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


class PlayerDirectoryExportTests(unittest.TestCase):
    def test_projects_signed_ids_and_marks_free_agents_inactive(self):
        envelope = {
            "schemaVersion": 1,
            "catalogVersion": "espn-2026-test",
            "generatedAt": "2026-08-27T12:00:00Z",
            "catalog": [
                {
                    "playerId": "101",
                    "name": "Runner",
                    "position": "RB",
                    "nflTeam": "CHI",
                    "tier": "T2",
                    "adp": 44.25,
                    "roleClass": "RB1",
                },
                {
                    "playerId": "-16010",
                    "name": "Titans D/ST",
                    "position": "D/ST",
                    "nflTeam": "TEN",
                    "tier": "T8",
                    "roleClass": "D/ST",
                },
                {
                    "playerId": "303",
                    "name": "Free Agent",
                    "position": "WR",
                    "nflTeam": "FA",
                    "tier": "T12",
                    "roleClass": "WR-unlisted",
                },
            ],
        }
        rows = module.player_directory_rows(envelope)
        by_key = {row[0]: row for row in rows[1:]}
        self.assertEqual(rows[0], module.PLAYER_DIRECTORY_HEADERS)
        self.assertTrue(by_key["espn:101"][7])
        self.assertTrue(by_key["espn:-16010"][7])
        self.assertFalse(by_key["espn:303"][7])
        self.assertEqual(by_key["espn:101"][9], "catalog:espn-2026-test")

    def test_rejects_the_espn_empty_sentinel(self):
        envelope = {
            "schemaVersion": 1,
            "catalogVersion": "test",
            "generatedAt": "2026-08-27T12:00:00Z",
            "catalog": [{
                "playerId": "-1",
                "name": "Empty",
                "position": "D/ST",
                "nflTeam": "FA",
            }],
        }
        with self.assertRaisesRegex(ValueError, "invalid ESPN player id"):
            module.player_directory_rows(envelope)


if __name__ == "__main__":
    unittest.main()
