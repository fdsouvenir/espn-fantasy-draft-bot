from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import UTC, datetime

import pytest

from draft_companion.credentials import Credentials
from draft_companion.worker import WorkerClient, WorkerError, signed_headers


def test_hmac_contract_is_deterministic():
    body = b'{"a":1}'
    headers = signed_headers("s" * 32, "/path", body, 123, "nonce")
    material = f"123\nnonce\nPOST\n/path\n{hashlib.sha256(body).hexdigest()}".encode()
    assert (
        headers["X-Draft-Signature"]
        == "v1=" + hmac.new(("s" * 32).encode(), material, hashlib.sha256).hexdigest()
    )


class Response:
    def __init__(self, payload, headers=None):
        self.payload, self.headers = payload, headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        pass

    def read(self, *_args):
        return json.dumps(self.payload).encode()


def test_worker_posts_signed_bounded_batches_without_secret_in_url():
    requests = []

    def opener(request, timeout):
        requests.append(request)
        payload = json.loads(request.data)
        if request.full_url.endswith("/initialize"):
            return Response({"created": True, "revision": 1})
        return Response(
            {
                "revision": 2,
                "accepted": len(payload["events"]),
                "deduped": 0,
                "lastOverallPick": payload["cursor"]["lastOverallPick"],
                "missingOverallPicks": [],
            }
        )

    creds = Credentials("h" * 32, "client-id", "client-secret")
    values = iter([uuid.UUID(int=1), uuid.UUID(int=2), uuid.UUID(int=3), uuid.UUID(int=4)])
    client = WorkerClient(
        "https://worker.example.com",
        "draft:test",
        creds,
        5,
        opener=opener,
        clock=lambda: 123,
        uuid4=lambda: next(values),
    )
    client.initialize({"schemaVersion": 1, "draftKey": "draft:test"})
    picks = {i: {"teamId": 1, "playerId": i, "round": i, "roundPick": 1} for i in range(1, 102)}
    client.ingest(picks, 101, True, "2026-08-11T00:00:00.000Z")
    assert len(requests) == 3
    assert [len(json.loads(r.data)["events"]) for r in requests[1:]] == [100, 1]
    assert all("h" * 32 not in request.full_url for request in requests)
    assert requests[1].headers["Cf-access-client-secret"] == "client-secret"
    payloads = [json.loads(request.data) for request in requests[1:]]
    assert [payload["cursor"]["lastOverallPick"] for payload in payloads] == [100, 101]
    assert [payload["draftState"]["drafted"] for payload in payloads] == [False, True]


def test_worker_preflight_checks_backend_and_clock_without_leaking_credentials():
    requests = []
    now = datetime(2026, 8, 11, tzinfo=UTC).timestamp()

    def opener(request, timeout):
        requests.append(request)
        return Response({"ok": True}, {"Date": "Tue, 11 Aug 2026 00:00:00 GMT"})

    client = WorkerClient(
        "https://worker.example.com",
        "draft:test",
        Credentials("h" * 32, "client-id", "client-secret"),
        5,
        opener=opener,
        clock=lambda: now,
    )
    assert client.health() == {"ok": True}
    assert requests[0].full_url == "https://worker.example.com/healthz"
    assert requests[0].headers["Cf-access-client-secret"] == "client-secret"


def test_worker_heartbeat_has_no_events_and_validates_ack():
    payloads = []

    def opener(request, timeout):
        payloads.append(json.loads(request.data))
        return Response({"revision": 4, "accepted": 0, "deduped": 0, "missingOverallPicks": []})

    client = WorkerClient(
        "https://worker.example.com",
        "draft:test",
        Credentials("h" * 32, "id", "secret"),
        5,
        opener=opener,
    )
    assert client.heartbeat(12, 205)["revision"] == 4
    assert payloads[0]["events"] == []
    assert payloads[0]["cursor"]["lastOverallPick"] == 12


def test_worker_rejects_partial_ack():
    def opener(request, timeout):
        return Response({"revision": 1, "accepted": 0, "deduped": 0, "missingOverallPicks": []})

    client = WorkerClient(
        "https://worker.example.com",
        "draft:test",
        Credentials("h" * 32, "id", "secret"),
        5,
        opener=opener,
    )
    with pytest.raises(WorkerError, match="partial"):
        client.ingest({1: {"teamId": 1, "playerId": 2, "round": 1, "roundPick": 1}}, 1, True, "now")
