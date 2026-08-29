from __future__ import annotations

import json
import os
from pathlib import Path
from typing import ClassVar

from draft_companion.cdp import DraftRoomIdentity, DraftRoomNotFoundError
from draft_companion.config import ChromeConfig, Config, RuntimeConfig
from draft_companion.credentials import Credentials
from draft_companion.runtime import (
    Companion,
    _accepted_recovery,
    _contiguous_pick_cursor,
    append_evidence,
    atomic_json,
    ensure_chrome,
    process_alive,
)
from draft_companion.worker import WorkerError


def test_contiguous_pick_cursor_ignores_future_keeper_slots():
    assert _contiguous_pick_cursor({107: object(), 114: object()}) == 0
    assert _contiguous_pick_cursor({1: object(), 2: object(), 107: object()}) == 2


def test_recovery_ignores_stale_init_frames_and_rejects_conflicts():
    first = {1: {"playerId": 101}, 2: {"playerId": 102}}
    assert _accepted_recovery(first, {1: {"playerId": 101}}, "INIT") is None
    assert _accepted_recovery(first, dict(first), "INIT") == first
    try:
        _accepted_recovery(first, {1: {"playerId": 999}, 2: {"playerId": 102}}, "INIT")
    except RuntimeError as error:
        assert str(error) == "INIT draft board conflicts with prior picks"
    else:
        raise AssertionError("conflicting recovery was accepted")


def config(tmp_path: Path) -> Config:
    initializer = {
        "schemaVersion": 1,
        "draftKey": "draft:test",
        "draftSlotTeamIds": ["1", "2"],
        "expectedTeams": 2,
        "totalPickSlots": 2,
    }
    (tmp_path / "init.json").write_text(json.dumps(initializer))
    return Config(
        "https://worker.example.com",
        "draft:test",
        tmp_path / "init.json",
        "https://fantasy.espn.com/football/draft",
        ChromeConfig(None, tmp_path / "profile", 9222, True),
        RuntimeConfig(tmp_path / "state", 0.25, 15, 45, 5, "environment", "service"),
    )


class FakeFrames:
    def __init__(self, *_args):
        self.calls = 0

    def read(self, _wait):
        self.calls += 1
        return (
            [{"at": 1000, "data": "SELECTED 1 101 2"}]
            if self.calls == 1
            else [{"at": 1100, "data": "SELECTED 2 -16007 16"}]
        )

    def close(self):
        pass


class FakeWorker:
    instances: ClassVar[list[FakeWorker]] = []

    def __init__(self, *_args):
        self.posts = []
        self.instances.append(self)

    def initialize(self, payload):
        self.initialized = payload["draftKey"]

    def heartbeat(self, _last, _total):
        return {"revision": 1, "accepted": 0, "deduped": 0, "missingOverallPicks": []}

    def ingest(self, picks, total, complete, observed):
        self.posts.append((dict(picks), total, complete, observed))
        return {"revision": len(self.posts)}


def test_runtime_commits_exact_board_and_owner_only_files(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("draft_companion.runtime.signal.signal", lambda *_args: None)
    runtime = Companion(
        config(tmp_path),
        frame_factory=FakeFrames,
        worker_factory=FakeWorker,
        credential_loader=lambda *_args: Credentials("h" * 32, "id", "secret"),
        sleeper=lambda _seconds: None,
    )
    runtime.run()
    checkpoint = json.loads((tmp_path / "state/checkpoint.json").read_text())
    health = json.loads((tmp_path / "state/health.json").read_text())
    assert [p["playerId"] for p in checkpoint["picks"]] == [101, -16007]
    assert health["state"] == "complete"
    if os.name != "nt":
        assert oct((tmp_path / "state/checkpoint.json").stat().st_mode & 0o777) == "0o600"
    assert len(FakeWorker.instances[-1].posts) == 2


def test_runtime_recovers_complete_board_from_dom_snapshot(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("draft_companion.runtime.signal.signal", lambda *_args: None)

    class DomFrames:
        def read(self, _wait):
            return [
                {
                    "at": 1200,
                    "picks": [
                        {"pickNumber": 1, "teamId": 99, "playerId": 101, "slotId": 2},
                        {"pickNumber": 2, "teamId": 98, "playerId": -16007, "slotId": 16},
                    ],
                }
            ]

        def close(self):
            pass

    runtime = Companion(
        config(tmp_path),
        frame_factory=lambda *_args: DomFrames(),
        worker_factory=FakeWorker,
        credential_loader=lambda *_args: Credentials("h" * 32, "id", "secret"),
        sleeper=lambda _seconds: None,
    )
    runtime.run()

    checkpoint = json.loads((tmp_path / "state/checkpoint.json").read_text())
    assert [pick["playerId"] for pick in checkpoint["picks"]] == [101, -16007]
    posted = FakeWorker.instances[-1].posts[0][0]
    assert [posted[overall]["teamId"] for overall in (1, 2)] == [1, 2]
    assert len(FakeWorker.instances[-1].posts) == 1


def test_health_logs_only_redacted_status_transitions(tmp_path: Path, capsys):
    runtime = Companion(config(tmp_path))
    runtime._health(
        "waiting_for_draft_room",
        reason="draft_room_not_open",
        reconnects=1,
        dashboardUrl="https://private.example.com/?draft=secret",
    )
    runtime._health(
        "waiting_for_draft_room",
        reason="draft_room_not_open",
        reconnects=2,
        dashboardUrl="https://private.example.com/?draft=secret",
    )
    runtime._health("live", filledPicks=0, totalPicks=64)

    output = capsys.readouterr().out
    entries = [json.loads(line) for line in output.splitlines()]
    assert [entry["state"] for entry in entries] == ["waiting_for_draft_room", "live"]
    assert "dashboardUrl" not in output
    assert "private.example.com" not in output
    assert "secret" not in output


def test_missing_draft_room_is_reported_as_waiting_for_user(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("draft_companion.runtime.signal.signal", lambda *_args: None)

    def missing_draft_room(*_args):
        raise DraftRoomNotFoundError("ESPN draft-room tab not found")

    runtime = Companion(
        config(tmp_path),
        frame_factory=missing_draft_room,
        worker_factory=FakeWorker,
        credential_loader=lambda *_args: Credentials("h" * 32, "id", "secret"),
    )
    health_updates = []
    runtime._health = lambda state, **fields: health_updates.append((state, fields))
    runtime.sleeper = lambda _seconds: runtime.stop()

    runtime.run()

    assert any(
        state == "waiting_for_draft_room" and fields.get("reason") == "draft_room_not_open"
        for state, fields in health_updates
    )


def test_worker_retry_does_not_reload_draft_room_again(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("draft_companion.runtime.signal.signal", lambda *_args: None)
    reloads = []
    runtime = None

    class RetryFrames:
        def __init__(self, _port, _url, reload_page):
            reloads.append(reload_page)

        def read(self, _wait):
            if len(reloads) == 1:
                return [{"at": 1000, "data": "SELECTED 1 101 2"}]
            runtime.stop()
            return []

        def close(self):
            pass

    class RetryWorker(FakeWorker):
        def ingest(self, *_args):
            raise WorkerError("worker_ingest_network_error")

    runtime = Companion(
        config(tmp_path),
        frame_factory=RetryFrames,
        worker_factory=RetryWorker,
        credential_loader=lambda *_args: Credentials("h" * 32, "id", "secret"),
        sleeper=lambda _seconds: None,
    )

    runtime.run()

    assert reloads == [True, False]


def test_stream_retry_reattaches_without_reloading_draft_room(tmp_path: Path, monkeypatch):
    monkeypatch.setattr("draft_companion.runtime.signal.signal", lambda *_args: None)
    reloads = []
    runtime = None

    class RetryFrames:
        def __init__(self, _port, _url, reload_page):
            reloads.append(reload_page)

        def read(self, _wait):
            if len(reloads) == 1:
                raise RuntimeError("rendered board temporarily unavailable")
            runtime.stop()
            return []

        def close(self):
            pass

    runtime = Companion(
        config(tmp_path),
        frame_factory=RetryFrames,
        worker_factory=FakeWorker,
        credential_loader=lambda *_args: Credentials("h" * 32, "id", "secret"),
        sleeper=lambda _seconds: None,
    )

    runtime.run()

    assert reloads == [True, False]


def test_device_resolution_failure_keeps_runtime_and_chrome_open(tmp_path: Path):
    cfg = config(tmp_path)
    reloads = []
    health_updates = []
    runtime = None

    class OpenDraftRoom:
        room_identity = DraftRoomIdentity(2026, "123", None)

        def close(self):
            pass

    class DeviceWorker:
        def enroll(self, _name, _version):
            pass

        def resolve_drafts(self, _rooms):
            raise WorkerError("device_resolution_network_error")

    def frames(_port, _url, reload_page, *, preferred_identity=None):
        assert preferred_identity is None
        reloads.append(reload_page)
        return OpenDraftRoom()

    runtime = Companion(cfg, frame_factory=frames, sleeper=lambda _seconds: runtime.stop())
    runtime._health = lambda state, **fields: health_updates.append((state, fields))

    assert runtime._connect_device_draft(DeviceWorker()) is None
    assert reloads == [False]
    assert health_updates[-1] == (
        "dashboard_unreachable",
        {
            "reason": "device_resolution_network_error",
            "dashboardUrl": "https://worker.example.com",
        },
    )


def test_device_enrollment_failure_retries_without_exiting(tmp_path: Path):
    cfg = config(tmp_path)
    health_updates = []
    runtime = None

    class DeviceWorker:
        def enroll(self, _name, _version):
            raise WorkerError("device_enrollment_network_error")

    runtime = Companion(cfg, sleeper=lambda _seconds: runtime.stop())
    runtime._health = lambda state, **fields: health_updates.append((state, fields))

    assert runtime._connect_device_draft(DeviceWorker()) is None
    assert health_updates[-1][0] == "dashboard_unreachable"
    assert health_updates[-1][1]["reason"] == "device_enrollment_network_error"


def test_atomic_json_never_leaves_world_readable_state(tmp_path: Path):
    path = tmp_path / "state.json"
    atomic_json(path, {"ok": True})
    assert json.loads(path.read_text()) == {"ok": True}
    if os.name != "nt":
        assert path.stat().st_mode & 0o077 == 0


def test_state_writes_work_without_unix_fchmod(tmp_path: Path, monkeypatch):
    monkeypatch.delattr(os, "fchmod", raising=False)
    state = tmp_path / "state.json"
    evidence = tmp_path / "evidence.jsonl"

    atomic_json(state, {"ok": True})
    append_evidence(evidence, {"event": "connected"})

    assert json.loads(state.read_text()) == {"ok": True}
    assert [json.loads(line) for line in evidence.read_text().splitlines()] == [
        {"event": "connected"}
    ]


def test_ensure_chrome_launches_dedicated_profile_and_waits(tmp_path: Path):
    cfg = config(tmp_path)
    calls = []
    attempts = iter([OSError(), []])

    def tabs(_port):
        value = next(attempts)
        if isinstance(value, Exception):
            raise value
        return value

    ensure_chrome(
        cfg,
        tabs_loader=tabs,
        launcher=lambda executable, profile, port, url: calls.append(
            (executable, profile, port, url)
        ),
        discover=lambda _explicit: "chrome",
        sleeper=lambda _seconds: None,
    )
    assert calls == [("chrome", tmp_path / "profile", 9222, cfg.chrome.start_url)]


def test_process_alive_rejects_invalid_pid():
    assert not process_alive(-1)
