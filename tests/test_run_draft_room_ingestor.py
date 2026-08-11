import importlib.util
import pathlib
import sys
import unittest


PROJECT = pathlib.Path(__file__).parents[1]
SCRIPTS = PROJECT / "scripts"
sys.path.insert(0, str(SCRIPTS))
MODULE_PATH = SCRIPTS / "run_draft_room_ingestor.py"
SPEC = importlib.util.spec_from_file_location("run_draft_room_ingestor", MODULE_PATH)
assert SPEC and SPEC.loader
ROOM = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ROOM)


class DraftRoomAdapterTests(unittest.TestCase):
    def test_draft_identity_supports_public_and_legacy_key_shapes(self):
        self.assertEqual(
            ROOM.draft_identity("staging:espn:ffl:2026:123456:fixture-draft"),
            (2026, "123456"),
        )
        self.assertEqual(
            ROOM.draft_identity("local:espn:2026:123456:fixture-draft"),
            (2026, "123456"),
        )
        with self.assertRaises(ValueError):
            ROOM.draft_identity("unsupported")

    def test_selected_frame_is_strict_and_preserves_negative_defense_id(self):
        self.assertEqual(ROOM.selected_frame("SELECTED 4 -16007 16"), (4, -16007, 16))
        self.assertIsNone(ROOM.selected_frame("CLOCK 1 15000 4"))
        with self.assertRaises(ROOM.DecodeError):
            ROOM.selected_frame("SELECTED 4 nope 16")

    def test_raw_board_uses_initialized_snake_order_and_only_minus_one_is_empty(self):
        init = {
            "draftSlotTeamIds": ["4", "3", "3", "4"],
            "expectedTeams": 2,
        }
        picks = {
            1: {"teamId": 4, "playerId": 101, "slotId": 2},
            2: {"teamId": 3, "playerId": -16007, "slotId": 16},
        }
        detail = ROOM.raw_board(init, picks, complete=False)["draftDetail"]
        self.assertEqual([pick["teamId"] for pick in detail["picks"]], [4, 3, 3, 4])
        self.assertEqual([pick["playerId"] for pick in detail["picks"]], [101, -16007, -1, -1])
        self.assertEqual(detail["picks"][2]["roundId"], 2)
        self.assertTrue(detail["inProgress"])
        self.assertFalse(detail["drafted"])


if __name__ == "__main__":
    unittest.main()
