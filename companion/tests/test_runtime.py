from __future__ import annotations

import json
import os
from pathlib import Path
from typing import ClassVar

from draft_companion.config import ChromeConfig, Config, RuntimeConfig
from draft_companion.credentials import Credentials
from draft_companion.runtime import (
    Companion,
    append_evidence,
    atomic_json,
    ensure_chrome,
    process_alive,
)


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
        ChromeConfig(None, tmp_path / "profile", 9222, True, False),
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
    assert calls == [("chrome", tmp_path / "profile", 9222, cfg.draft_url)]


def test_process_alive_rejects_invalid_pid():
    assert not process_alive(-1)
