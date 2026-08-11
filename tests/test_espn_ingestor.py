import importlib.util
import json
import pathlib
import stat
import sys
import tempfile
import unittest


MODULE_PATH = pathlib.Path(__file__).parents[1] / "scripts" / "espn_ingestor.py"
SPEC = importlib.util.spec_from_file_location("espn_ingestor", MODULE_PATH)
assert SPEC and SPEC.loader
INGESTOR = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = INGESTOR
SPEC.loader.exec_module(INGESTOR)

DRAFT_KEY = "staging:espn:2026:123456789:fixture-draft"


def slot(overall, player=-1, team=1, round_id=1, round_pick=None, **extra):
    return {
        "overallPickNumber": overall,
        "roundId": round_id,
        "roundPickNumber": round_pick or overall,
        "teamId": team,
        "playerId": player,
        **extra,
    }


def fixture(picks, *, in_progress=False, drafted=False, **extra):
    return {
        "draftDetail": {
            "inProgress": in_progress,
            "drafted": drafted,
            "picks": picks,
            "members": [{"id": "must-not-leak"}],
            **extra,
        },
        "cookie": "must-not-leak",
    }


def normalized(raw, at="2026-08-11T12:00:00.000Z", timing=None):
    return INGESTOR.normalize_draft_detail(
        raw, draft_key=DRAFT_KEY, captured_at=at, request_timing=timing
    )


class NormalizationTests(unittest.TestCase):
    def test_only_minus_one_is_empty_and_defense_is_filled(self):
        self.assertFalse(INGESTOR.is_filled_pick({"playerId": -1}))
        self.assertTrue(INGESTOR.is_filled_pick({"playerId": -16007}))
        self.assertFalse(INGESTOR.is_filled_pick({}))

        snap = normalized(fixture([slot(1, -16007), slot(2, -1)], in_progress=True))
        self.assertEqual(snap["filledPicks"], 1)
        self.assertEqual(snap["missingOverallPicks"], [2])
        self.assertEqual(snap["picks"][0]["playerId"], "-16007")

    def test_whitelist_excludes_secrets_and_request_headers(self):
        snap = normalized(
            fixture([slot(1, 101, secret="no")], accessToken="no"),
            timing={
                "durationMs": 12.3456,
                "httpStatus": 200,
                "attempt": 2,
                "headers": {"Cookie": "no"},
                "url": "https://secret.example/",
            },
        )
        encoded = json.dumps(snap)
        self.assertNotIn("must-not-leak", encoded)
        self.assertNotIn("secret", encoded.lower())
        self.assertNotIn("cookie", encoded.lower())
        self.assertNotIn("url", snap["request"])
        self.assertEqual(snap["request"], {"durationMs": 12.346, "httpStatus": 200, "attempt": 2})


class ReplayTests(unittest.TestCase):
    def test_multi_pick_jump_emits_ordered_inserts_and_stable_ids(self):
        state = INGESTOR.CollectorState(DRAFT_KEY)
        state.apply(normalized(fixture([slot(1), slot(2), slot(3)], in_progress=True)))
        events = state.apply(
            normalized(fixture([slot(1, 101), slot(2, -16007), slot(3, 303)], in_progress=True), at="2026-08-11T12:00:02.000Z")
        )
        inserts = [event for event in events if event["type"] == "pick.inserted"]
        self.assertEqual([event["payload"]["pick"]["overallPick"] for event in inserts], [1, 2, 3])
        self.assertEqual(inserts[1]["payload"]["pick"]["playerId"], "-16007")
        payload = inserts[0]["payload"]
        self.assertEqual(
            inserts[0]["eventId"],
            INGESTOR.deterministic_event_id("pick.inserted", DRAFT_KEY, payload),
        )

    def test_duplicate_poll_ignores_observation_and_timing_changes(self):
        state = INGESTOR.CollectorState(DRAFT_KEY)
        raw = fixture([slot(1, 101), slot(2)], in_progress=True)
        first = state.apply(normalized(raw, timing={"durationMs": 10}))
        revision = state.revision
        second = state.apply(
            normalized(raw, at="2026-08-11T12:00:10.000Z", timing={"durationMs": 99})
        )
        self.assertTrue(first)
        self.assertEqual(second, [])
        self.assertEqual(state.revision, revision)

    def test_correction_uses_stable_pick_key_and_new_revision(self):
        state = INGESTOR.CollectorState(DRAFT_KEY)
        state.apply(normalized(fixture([slot(1, 101)], in_progress=True)))
        events = state.apply(
            normalized(fixture([slot(1, 202)], in_progress=True), at="2026-08-11T12:01:00.000Z")
        )
        correction = next(event for event in events if event["type"] == "pick.corrected")
        self.assertEqual(correction["payload"]["pickKey"], f"{DRAFT_KEY}:pick:1")
        self.assertEqual(correction["payload"]["before"]["playerId"], "101")
        self.assertEqual(correction["payload"]["after"]["playerId"], "202")
        self.assertGreater(correction["revision"], 1)

    def test_restart_checkpoint_reconstructs_all_missed_picks(self):
        state = INGESTOR.CollectorState(DRAFT_KEY)
        state.apply(normalized(fixture([slot(1, 101), slot(2), slot(3), slot(4)], in_progress=True)))
        with tempfile.TemporaryDirectory() as directory:
            checkpoint_path = pathlib.Path(directory) / "checkpoint.json"
            INGESTOR.atomic_write_checkpoint(checkpoint_path, state.checkpoint())
            resumed = INGESTOR.CollectorState.from_checkpoint(INGESTOR.load_checkpoint(checkpoint_path))
            events = resumed.apply(
                normalized(
                    fixture([slot(1, 101), slot(2, 202), slot(3, 303), slot(4, 404)], in_progress=True),
                    at="2026-08-11T12:02:00.000Z",
                )
            )
            inserts = [event for event in events if event["type"] == "pick.inserted"]
            self.assertEqual([event["payload"]["pick"]["overallPick"] for event in inserts], [2, 3, 4])
            self.assertEqual(resumed.revision, state.revision + len(events))

    def test_phase_and_final_completeness(self):
        state = INGESTOR.CollectorState(DRAFT_KEY)
        state.apply(normalized(fixture([slot(1), slot(2)])))
        active = state.apply(
            normalized(fixture([slot(1, 101), slot(2)], in_progress=True), at="2026-08-11T12:03:00.000Z")
        )
        self.assertIn("draft.phase_changed", [event["type"] for event in active])
        final = state.apply(
            normalized(fixture([slot(1, 101), slot(2, -16007)], drafted=True), at="2026-08-11T12:04:00.000Z")
        )
        completion = next(event for event in final if event["type"] == "draft.completed")
        self.assertEqual(completion["payload"]["filledPicks"], 2)
        self.assertEqual(completion["payload"]["totalPicks"], 2)
        self.assertEqual(completion["payload"]["missingOverallPicks"], [])
        self.assertTrue(completion["payload"]["boardComplete"])


class PersistenceTests(unittest.TestCase):
    def test_owner_only_checkpoint_and_ndjson_with_lifecycle(self):
        state = INGESTOR.CollectorState(DRAFT_KEY)
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = pathlib.Path(directory) / "checkpoint.json"
            journal = pathlib.Path(directory) / "events.ndjson"
            INGESTOR.atomic_write_checkpoint(checkpoint, state.checkpoint())
            records = [
                INGESTOR.lifecycle_record(
                    "started", draft_key=DRAFT_KEY, instance_id="fixture-instance", captured_at="2026-08-11T12:00:00.000Z"
                ),
                INGESTOR.lifecycle_record(
                    "stopped", draft_key=DRAFT_KEY, instance_id="fixture-instance", captured_at="2026-08-11T12:05:00.000Z", reason="completed"
                ),
            ]
            INGESTOR.append_ndjson(journal, records)
            self.assertEqual(stat.S_IMODE(checkpoint.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(journal.stat().st_mode), 0o600)
            loaded = [json.loads(line) for line in journal.read_text().splitlines()]
            self.assertEqual([item["payload"]["state"] for item in loaded], ["started", "stopped"])


if __name__ == "__main__":
    unittest.main()
