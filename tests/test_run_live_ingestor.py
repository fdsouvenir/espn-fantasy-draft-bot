import hashlib
import hmac
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
import uuid
from contextlib import redirect_stdout
from io import StringIO
from unittest import mock


PROJECT = pathlib.Path(__file__).parents[1]
SCRIPTS = PROJECT / "scripts"
sys.path.insert(0, str(SCRIPTS))
MODULE_PATH = SCRIPTS / "run_live_ingestor.py"
SPEC = importlib.util.spec_from_file_location("run_live_ingestor", MODULE_PATH)
assert SPEC and SPEC.loader
RUNNER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RUNNER
SPEC.loader.exec_module(RUNNER)


DRAFT_KEY = "staging:espn:2026:123456789:fixture"
SECRET = "a" * 32
SERVER_TIME = "2026-08-11T12:00:00.000Z"


def ack(event_count=0, *, revision=1, accepted=None, deduped=0, last=0, missing=None):
    return {
        "revision": revision,
        "accepted": event_count - deduped if accepted is None else accepted,
        "deduped": deduped,
        "lastOverallPick": last,
        "missingOverallPicks": list(missing or []),
        "serverTime": SERVER_TIME,
    }


def slot(overall, player=-1, team=1, round_id=1, round_pick=None):
    return {
        "overallPickNumber": overall,
        "roundId": round_id,
        "roundPickNumber": round_pick or overall,
        "teamId": team,
        "playerId": player,
    }


def fixture(picks, *, in_progress=False, drafted=False):
    return {"draftDetail": {"inProgress": in_progress, "drafted": drafted, "picks": picks}}


class FakeTransport:
    def __init__(self, payload, post_results=None):
        self.payload = payload
        self.post_results = list(post_results) if post_results is not None else None
        self.get_calls = []
        self.post_calls = []

    def get_json(self, url, headers, timeout):
        self.get_calls.append((url, dict(headers), timeout))
        return self.payload

    def post_json(self, url, headers, body, timeout):
        self.post_calls.append((url, dict(headers), body, timeout))
        if self.post_results is None:
            payload = json.loads(body)
            result = ack(
                len(payload.get("events", [])),
                last=payload.get("cursor", {}).get("lastOverallPick", 0),
            )
        else:
            result = self.post_results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


def config(directory, *, once=True, retries=1, init_file=None):
    return RUNNER.RunnerConfig(
        season=2026,
        league_id="123456789",
        draft_key=DRAFT_KEY,
        worker_base="https://draft-helper.example.com/",
        checkpoint=pathlib.Path(directory) / "checkpoint.json",
        poll_seconds=0.25,
        timeout_seconds=2,
        max_retries=retries,
        once=once,
        init_file=init_file,
    )


class PureHelperTests(unittest.TestCase):
    def test_espn_request_is_get_only_and_cookie_header_is_optional(self):
        url = RUNNER.espn_url(2026, "123456789")
        self.assertEqual(
            url,
            "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/"
            "seasons/2026/segments/0/leagues/123456789?view=mDraftDetail",
        )
        self.assertNotIn("Cookie", RUNNER.espn_headers(None, None))
        headers = RUNNER.espn_headers("private-s2", "{private-swid}")
        self.assertEqual(headers["Cookie"], "SWID={private-swid}; espn_s2=private-s2")

    def test_hmac_matches_worker_canonical_input(self):
        body = b'{"schemaVersion":1}'
        timestamp = 1786450000
        nonce = "00000000-0000-4000-8000-000000000000"
        path = "/api/v1/drafts/example/ingest"
        headers = RUNNER.signed_headers(SECRET, path, body, timestamp, nonce)
        body_hash = hashlib.sha256(body).hexdigest()
        material = f"{timestamp}\n{nonce}\nPOST\n{path}\n{body_hash}".encode()
        expected = hmac.new(SECRET.encode(), material, hashlib.sha256).hexdigest()
        self.assertEqual(headers["X-Draft-Signature"], f"v1={expected}")

    def test_batch_includes_negative_defense_and_completion_cursor(self):
        raw = fixture([slot(1, 101), slot(2, -16007), slot(3)], drafted=True)
        snapshot = RUNNER.normalize_draft_detail(
            raw, draft_key=DRAFT_KEY, captured_at="2026-08-11T12:00:00.000Z"
        )
        state = RUNNER.CollectorState(DRAFT_KEY)
        batch = RUNNER.build_batch(snapshot, state.apply(snapshot), "instance")
        self.assertEqual([event["playerId"] for event in batch["events"]], ["101", "-16007"])
        self.assertTrue(all(len(event["eventId"]) == 64 for event in batch["events"]))
        self.assertEqual(batch["cursor"]["lastOverallPick"], 3)
        self.assertTrue(batch["draftState"]["drafted"])

    def test_recovered_large_board_splits_at_worker_limit(self):
        batch = {"schemaVersion": 1, "events": [{"overallPick": index} for index in range(1, 206)]}
        parts = RUNNER.split_batch(batch)
        self.assertEqual([len(part["events"]) for part in parts], [100, 100, 5])
        self.assertEqual(
            [event["overallPick"] for part in parts for event in part["events"]],
            list(range(1, 206)),
        )

    def test_init_file_is_bounded_and_draft_identity_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "init.json"
            path.write_text(json.dumps({"schemaVersion": 1, "draftKey": DRAFT_KEY}))
            self.assertEqual(RUNNER.load_init_payload(path, DRAFT_KEY)["draftKey"], DRAFT_KEY)
            with self.assertRaisesRegex(ValueError, "draftKey mismatch"):
                RUNNER.load_init_payload(path, "other")
            path.write_bytes(b"x" * (RUNNER.MAX_INIT_BYTES + 1))
            with self.assertRaisesRegex(ValueError, "exceeds"):
                RUNNER.load_init_payload(path, DRAFT_KEY)


class RunnerTests(unittest.TestCase):
    def test_fetch_exposes_sanitized_request_latency_without_network(self):
        transport = FakeTransport(fixture([slot(1)]))
        with tempfile.TemporaryDirectory() as directory:
            runner = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=transport)
            with mock.patch.object(RUNNER.time, "monotonic", side_effect=[10.0, 10.125]):
                _payload, timing = runner._fetch()
            self.assertEqual(timing, {"durationMs": 125.0, "httpStatus": 200, "attempt": 1})
            self.assertEqual(len(transport.get_calls), 1)
            self.assertNotIn("headers", timing)
            self.assertNotIn("url", timing)

    def test_init_file_posts_signed_initialize_before_ingest_and_accepts_idempotent_ack(self):
        payload = fixture([slot(1, 101)], drafted=True)
        transport = FakeTransport(
            payload,
            [{"created": False, "revision": 4}, ack(1, revision=5, last=1)],
        )
        with tempfile.TemporaryDirectory() as directory:
            init_path = pathlib.Path(directory) / "init.json"
            init_path.write_text(json.dumps({
                "schemaVersion": 1,
                "draftKey": DRAFT_KEY,
                "expectedTeams": 4,
                "expectedRounds": 1,
                "totalPickSlots": 1,
                "pinnedCatalogVersion": "fixture-v1",
                "catalog": [],
            }))
            runner = RUNNER.LiveRunner(
                config(directory, init_file=init_path), secret=SECRET, transport=transport,
                cf_access_client_id="access-id", cf_access_client_secret="access-secret",
            )
            self.assertEqual(runner.run(), "completed")
            self.assertEqual(len(transport.post_calls), 2)
            self.assertTrue(transport.post_calls[0][0].endswith("/initialize"))
            self.assertTrue(transport.post_calls[1][0].endswith("/ingest"))
            self.assertEqual(transport.post_calls[0][1]["CF-Access-Client-Id"], "access-id")
            self.assertEqual(json.loads(transport.post_calls[0][2])["draftKey"], DRAFT_KEY)

    def test_init_conflict_is_hard_stop_before_espn_read(self):
        conflict = RUNNER.TransportError("worker_ingest", 409, False)
        transport = FakeTransport({}, [conflict])
        with tempfile.TemporaryDirectory() as directory:
            init_path = pathlib.Path(directory) / "init.json"
            init_path.write_text(json.dumps({"schemaVersion": 1, "draftKey": DRAFT_KEY}))
            runner = RUNNER.LiveRunner(
                config(directory, init_file=init_path), secret=SECRET, transport=transport,
            )
            with self.assertRaises(RUNNER.TransportError) as caught:
                runner.run()
            self.assertEqual(caught.exception.status, 409)
            self.assertEqual(transport.get_calls, [])
            self.assertEqual(len(transport.post_calls), 1)

    def test_once_posts_signed_batch_with_access_headers_and_checkpoints(self):
        payload = fixture([slot(1, 101), slot(2, -16007)], drafted=True)
        transport = FakeTransport(payload, [ack(2, revision=7, last=2)])
        with tempfile.TemporaryDirectory() as directory:
            runner = RUNNER.LiveRunner(
                config(directory),
                secret=SECRET,
                espn_s2="s2-secret",
                swid="swid-secret",
                cf_access_client_id="access-id",
                cf_access_client_secret="access-secret",
                transport=transport,
                clock=lambda: 1786450000,
                sleeper=lambda _seconds: None,
                random_uuid=lambda: uuid.UUID("00000000-0000-4000-8000-000000000000"),
            )
            self.assertEqual(runner.run(), "completed")
            self.assertTrue(runner.config.checkpoint.exists())
            self.assertEqual(len(transport.get_calls), 1)
            self.assertEqual(len(transport.post_calls), 1)
            _, get_headers, _ = transport.get_calls[0]
            self.assertIn("espn_s2=s2-secret", get_headers["Cookie"])
            url, headers, body, _ = transport.post_calls[0]
            self.assertNotIn("s2-secret", json.dumps(headers))
            self.assertEqual(headers["CF-Access-Client-Id"], "access-id")
            self.assertEqual(headers["CF-Access-Client-Secret"], "access-secret")
            self.assertIn(urllib_quote(DRAFT_KEY), url)
            self.assertEqual(json.loads(body)["events"][1]["playerId"], "-16007")

    def test_access_headers_absent_unless_both_values_present(self):
        payload = fixture([slot(1, 101)], in_progress=True)
        for client_id, client_secret in [(None, None), ("only-id", None), (None, "only-secret")]:
            with self.subTest(client_id=bool(client_id), client_secret=bool(client_secret)):
                with tempfile.TemporaryDirectory() as directory:
                    transport = FakeTransport(payload)
                    runner = RUNNER.LiveRunner(
                        config(directory), secret=SECRET, transport=transport,
                        cf_access_client_id=client_id, cf_access_client_secret=client_secret,
                    )
                    runner.poll_once()
                    headers = transport.post_calls[0][1]
                    self.assertNotIn("CF-Access-Client-Id", headers)
                    self.assertNotIn("CF-Access-Client-Secret", headers)

    def test_failed_post_does_not_advance_checkpoint(self):
        payload = fixture([slot(1, 101)], in_progress=True)
        failure = RUNNER.TransportError("worker_ingest", 403, False)
        transport = FakeTransport(payload, [failure])
        with tempfile.TemporaryDirectory() as directory:
            runner = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=transport)
            with self.assertRaises(RUNNER.TransportError):
                runner.poll_once()
            self.assertFalse(runner.config.checkpoint.exists())
            self.assertEqual(runner.state.revision, 0)

    def test_transient_failure_retries_with_fresh_nonce(self):
        payload = fixture([slot(1, 101)], in_progress=True)
        transport = FakeTransport(
            payload,
            [RUNNER.TransportError("worker_ingest", 503, True), ack(1, last=1)],
        )
        uuids = iter(
            [
                uuid.UUID("00000000-0000-4000-8000-000000000001"),
                uuid.UUID("00000000-0000-4000-8000-000000000002"),
                uuid.UUID("00000000-0000-4000-8000-000000000003"),
            ]
        )
        delays = []
        with tempfile.TemporaryDirectory() as directory:
            runner = RUNNER.LiveRunner(
                config(directory, retries=2), secret=SECRET, transport=transport,
                random_uuid=lambda: next(uuids), sleeper=delays.append,
            )
            runner.poll_once()
            self.assertEqual(len(transport.post_calls), 2)
            self.assertNotEqual(
                transport.post_calls[0][1]["X-Draft-Nonce"],
                transport.post_calls[1][1]["X-Draft-Nonce"],
            )
            self.assertEqual(delays, [0.5])

    def test_unchanged_state_posts_empty_heartbeat(self):
        payload = fixture([slot(1, 101), slot(2)], in_progress=True)
        with tempfile.TemporaryDirectory() as directory:
            first_transport = FakeTransport(payload)
            first = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=first_transport)
            self.assertFalse(first.poll_once())
            second_transport = FakeTransport(payload)
            second = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=second_transport)
            self.assertFalse(second.poll_once())
            self.assertEqual(len(second_transport.post_calls), 1)
            heartbeat = json.loads(second_transport.post_calls[0][2])
            self.assertEqual(heartbeat["events"], [])
            self.assertEqual(heartbeat["cursor"]["lastOverallPick"], 1)

    def test_board_shape_change_posts_even_without_new_pick_or_phase_event(self):
        initial = fixture([slot(1), slot(2)], in_progress=True)
        expanded = fixture([slot(1), slot(2), slot(3)], in_progress=True)
        with tempfile.TemporaryDirectory() as directory:
            first = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=FakeTransport(initial))
            first.poll_once()
            transport = FakeTransport(expanded)
            resumed = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=transport)
            resumed.poll_once()
            self.assertEqual(len(transport.post_calls), 1)
            batch = json.loads(transport.post_calls[0][2])
            self.assertEqual(batch["events"], [])
            self.assertEqual(batch["draftState"]["totalPickSlots"], 3)

    def test_middle_missing_ack_is_immediately_backfilled(self):
        payload = fixture([slot(1, 101), slot(2, 102), slot(3, 103)], drafted=True)
        transport = FakeTransport(
            payload,
            [ack(3, last=3, missing=[2]), ack(1, revision=2, last=3)],
        )
        with tempfile.TemporaryDirectory() as directory:
            runner = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=transport)
            self.assertTrue(runner.poll_once())
            self.assertEqual(len(transport.post_calls), 2)
            replay = json.loads(transport.post_calls[1][2])
            self.assertEqual([event["overallPick"] for event in replay["events"]], [2])
            self.assertTrue(runner.config.checkpoint.exists())

    def test_trailing_missing_ack_is_immediately_backfilled(self):
        payload = fixture([slot(1, 101), slot(2, 102), slot(3, 103)], drafted=True)
        transport = FakeTransport(
            payload,
            [ack(3, last=3, missing=[3]), ack(1, revision=2, last=3)],
        )
        with tempfile.TemporaryDirectory() as directory:
            runner = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=transport)
            runner.poll_once()
            replay = json.loads(transport.post_calls[1][2])
            self.assertEqual([event["overallPick"] for event in replay["events"]], [3])

    def test_worker_reset_on_unchanged_espn_replays_full_board(self):
        payload = fixture([slot(1, 101), slot(2, 102)], drafted=True)
        with tempfile.TemporaryDirectory() as directory:
            first = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=FakeTransport(payload))
            first.poll_once()
            reset_transport = FakeTransport(
                payload,
                [ack(0, revision=0, last=2, missing=[1, 2]), ack(2, last=2)],
            )
            resumed = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=reset_transport)
            resumed.poll_once()
            self.assertEqual(json.loads(reset_transport.post_calls[0][2])["events"], [])
            replay = json.loads(reset_transport.post_calls[1][2])
            self.assertEqual([event["overallPick"] for event in replay["events"]], [1, 2])

    def test_full_draft_restart_replay_delivers_every_pick_exactly_once_across_splits(self):
        generated = [
            slot(
                overall,
                -(16000 + overall) if overall % 16 == 0 else 100000 + overall,
                team=((overall - 1) % 12) + 1,
                round_id=((overall - 1) // 12) + 1,
                round_pick=((overall - 1) % 12) + 1,
            )
            for overall in range(1, 206)
        ]
        payload = fixture(generated, drafted=True)
        with tempfile.TemporaryDirectory() as directory:
            RUNNER.LiveRunner(
                config(directory), secret=SECRET, transport=FakeTransport(payload)
            ).poll_once()
            reset_transport = FakeTransport(
                payload,
                [
                    ack(0, revision=0, last=205, missing=list(range(1, 206))),
                    ack(100, revision=1, last=205, missing=list(range(101, 206))),
                    ack(100, revision=2, last=205, missing=list(range(201, 206))),
                    ack(5, revision=3, last=205),
                ],
            )
            resumed = RUNNER.LiveRunner(
                config(directory), secret=SECRET, transport=reset_transport
            )
            resumed.poll_once()

            self.assertEqual(json.loads(reset_transport.post_calls[0][2])["events"], [])
            replayed = [
                event
                for call in reset_transport.post_calls[1:]
                for event in json.loads(call[2])["events"]
            ]
            overalls = [event["overallPick"] for event in replayed]
            self.assertEqual(overalls, list(range(1, 206)))
            self.assertEqual(len(overalls), len(set(overalls)))
            self.assertTrue(any(int(event["playerId"]) < -1 for event in replayed))
            self.assertEqual(
                [len(json.loads(call[2])["events"]) for call in reset_transport.post_calls[1:]],
                [100, 100, 5],
            )

    def test_invalid_ack_never_checkpoints(self):
        payload = fixture([slot(1, 101)], drafted=True)
        invalid = {"revision": 1, "accepted": 1}
        with tempfile.TemporaryDirectory() as directory:
            runner = RUNNER.LiveRunner(
                config(directory), secret=SECRET, transport=FakeTransport(payload, [invalid])
            )
            with self.assertRaisesRegex(RuntimeError, "invalid_ack"):
                runner.poll_once()
            self.assertFalse(runner.config.checkpoint.exists())
            self.assertEqual(runner.state.revision, 0)

    def test_partial_split_failure_never_checkpoints(self):
        picks = [slot(index, 1000 + index) for index in range(1, 102)]
        payload = fixture(picks, drafted=True)
        failure = RUNNER.TransportError("worker_ingest", 503, False)
        transport = FakeTransport(payload, [ack(100, last=100), failure])
        with tempfile.TemporaryDirectory() as directory:
            runner = RUNNER.LiveRunner(config(directory), secret=SECRET, transport=transport)
            with self.assertRaises(RUNNER.TransportError):
                runner.poll_once()
            self.assertEqual(len(transport.post_calls), 2)
            self.assertFalse(runner.config.checkpoint.exists())
            self.assertEqual(runner.state.revision, 0)

    def test_partial_ack_never_checkpoints(self):
        payload = fixture([slot(1, 101), slot(2, 102)], drafted=True)
        partial = ack(2, accepted=1, last=2)
        with tempfile.TemporaryDirectory() as directory:
            runner = RUNNER.LiveRunner(
                config(directory), secret=SECRET, transport=FakeTransport(payload, [partial])
            )
            with self.assertRaisesRegex(RuntimeError, "partial_ack"):
                runner.poll_once()
            self.assertFalse(runner.config.checkpoint.exists())

    def test_credentials_are_not_logged_on_failure(self):
        payload = fixture([slot(1, 101)], drafted=True)
        hmac_secret = "hmac-secret-that-must-never-appear-123456"
        espn_secret = "espn-cookie-that-must-never-appear"
        access_secret = "access-secret-that-must-never-appear"
        failure = RUNNER.TransportError("worker_ingest", 403, False)
        with tempfile.TemporaryDirectory() as directory:
            runner = RUNNER.LiveRunner(
                config(directory),
                secret=hmac_secret,
                espn_s2=espn_secret,
                cf_access_client_id="safe-id",
                cf_access_client_secret=access_secret,
                transport=FakeTransport(payload, [failure]),
            )
            output = StringIO()
            with redirect_stdout(output), self.assertRaises(RUNNER.TransportError):
                runner.run()
            rendered = output.getvalue()
            self.assertNotIn(hmac_secret, rendered)
            self.assertNotIn(espn_secret, rendered)
            self.assertNotIn(access_secret, rendered)


def urllib_quote(value):
    import urllib.parse
    return urllib.parse.quote(value, safe="")


if __name__ == "__main__":
    unittest.main()
