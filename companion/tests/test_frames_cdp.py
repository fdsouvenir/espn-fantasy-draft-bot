from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from draft_companion.cdp import FrameSource, launch_chrome
from draft_companion.frames import DecodeError, raw_board, selected_frame


def test_selected_is_strict_and_preserves_negative_defense_id():
    assert selected_frame("SELECTED 4 -16007 16") == (4, -16007, 16)
    assert selected_frame("CLOCK 4 10") is None
    with pytest.raises(DecodeError):
        selected_frame("SELECTED 4 nope 16")


def test_raw_board_only_treats_minus_one_as_empty():
    init = {"draftSlotTeamIds": ["4", "3", "3", "4"], "expectedTeams": 2}
    picks = {1: {"teamId": 4, "playerId": 101}, 2: {"teamId": 3, "playerId": -16007}}
    detail = raw_board(init, picks, False)["draftDetail"]
    assert [pick["playerId"] for pick in detail["picks"]] == [101, -16007, -1, -1]


class FakeSocket:
    def __init__(self):
        self.sent = []
        self.responses = []

    def send(self, value):
        self.sent.append(json.loads(value))
        self.responses.append(json.dumps({"id": self.sent[-1]["id"]}))

    def recv(self):
        return self.responses.pop(0)

    def settimeout(self, _value):
        pass

    def close(self):
        pass


def test_cdp_attaches_to_matching_tab_and_never_subscribes_to_outbound_frames():
    socket = FakeSocket()
    seen_endpoints = []
    tabs = lambda _port: [
        {
            "type": "page",
            "url": "https://fantasy.espn.com/football/draft?league=1",
            "webSocketDebuggerUrl": "ws://localhost/devtools/page/opaque",
        }
    ]
    source = FrameSource(
        9222,
        "https://fantasy.espn.com/football/draft",
        False,
        tabs_loader=tabs,
        connector=lambda endpoint, **_kwargs: seen_endpoints.append(endpoint) or socket,
    )
    assert seen_endpoints == ["ws://localhost/devtools/page/opaque"]
    source._record(
        {
            "method": "Network.webSocketCreated",
            "params": {
                "requestId": "espn",
                "url": "wss://fantasydraft.espn.com/socket?private=value",
            },
        }
    )
    source._record(
        {
            "method": "Network.webSocketFrameSent",
            "params": {"requestId": "espn", "response": {"payloadData": "SELECTED 1 2 3"}},
        }
    )
    source._record(
        {
            "method": "Network.webSocketFrameReceived",
            "params": {"requestId": "espn", "response": {"payloadData": "AUTH secret"}},
        }
    )
    source._record(
        {
            "method": "Network.webSocketFrameReceived",
            "params": {"requestId": "espn", "response": {"payloadData": "SELECTED 1 2 3"}},
        }
    )
    assert [frame["data"] for frame in source.frames] == ["SELECTED 1 2 3"]
    assert [item["method"] for item in socket.sent] == ["Network.enable"]


def test_cdp_ignores_identical_frames_from_unrelated_websockets():
    socket = FakeSocket()
    tabs = lambda _port: [
        {
            "type": "page",
            "url": "https://fantasy.espn.com/football/draft",
            "webSocketDebuggerUrl": "ws://localhost/devtools/page/opaque",
        }
    ]
    source = FrameSource(
        9222,
        "https://fantasy.espn.com/football/draft",
        False,
        tabs_loader=tabs,
        connector=lambda _endpoint, **_kwargs: socket,
    )
    source._record(
        {
            "method": "Network.webSocketCreated",
            "params": {"requestId": "chat", "url": "wss://example.com/socket"},
        }
    )
    source._record(
        {
            "method": "Network.webSocketFrameReceived",
            "params": {"requestId": "chat", "response": {"payloadData": "SELECTED 1 2 3"}},
        }
    )
    source._record(
        {
            "method": "Network.webSocketFrameReceived",
            "params": {"requestId": "unknown", "response": {"payloadData": "INIT AAAA"}},
        }
    )
    assert source.frames == []
    assert source.tracked_requests == set()


def test_cdp_does_not_return_debugger_endpoint_in_errors():
    with pytest.raises(RuntimeError, match="tab not found") as raised:
        FrameSource(
            9222,
            "https://fantasy.espn.com/football/draft",
            False,
            tabs_loader=lambda _port: [],
            connector=None,
        )
    assert "ws://" not in str(raised.value)


def test_chrome_profile_is_owner_only(tmp_path: Path, monkeypatch):
    calls = []
    monkeypatch.setattr(
        "draft_companion.cdp.subprocess.Popen",
        lambda command, **kwargs: calls.append((command, kwargs)) or object(),
    )
    profile = tmp_path / "chrome-profile"

    launch_chrome("google-chrome", profile, 9222, "https://fantasy.espn.com/football/draft")

    if os.name != "nt":
        assert profile.stat().st_mode & 0o077 == 0
    assert "--remote-debugging-address=127.0.0.1" in calls[0][0]
