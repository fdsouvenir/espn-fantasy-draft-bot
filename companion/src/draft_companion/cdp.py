from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import websocket


def discover_chrome(explicit: str | None = None) -> str:
    if explicit:
        if Path(explicit).is_file() or shutil.which(explicit):
            return explicit
        raise FileNotFoundError("configured Chrome executable was not found")
    names = ["google-chrome", "chromium", "chromium-browser", "chrome"]
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    candidates = {
        "Darwin": ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
        "Windows": [
            os.path.expandvars(r"%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        ],
    }.get(platform.system(), [])
    for candidate in candidates:
        if Path(candidate).is_file():
            return candidate
    raise FileNotFoundError("Chrome or Chromium was not found")


def launch_chrome(
    executable: str, profile: Path, port: int, draft_url: str
) -> subprocess.Popen[Any]:
    profile.mkdir(parents=True, exist_ok=True)
    return subprocess.Popen(
        [
            executable,
            f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            draft_url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def list_tabs(port: int, *, opener=urllib.request.urlopen) -> list[dict[str, Any]]:
    with opener(f"http://127.0.0.1:{port}/json", timeout=3) as response:
        value = json.load(response)
    if not isinstance(value, list):
        raise TypeError("invalid CDP response")
    return [item for item in value if isinstance(item, dict) and item.get("type") == "page"]


class FrameSource:
    """Reads ESPN draft frames without persisting cookies or socket URLs."""

    def __init__(
        self,
        port: int,
        draft_url: str,
        reload_page: bool,
        *,
        tabs_loader=list_tabs,
        connector=websocket.create_connection,
    ):
        tabs = tabs_loader(port)
        target = next((tab for tab in tabs if str(tab.get("url", "")).startswith(draft_url)), None)
        if target is None:
            raise RuntimeError("ESPN draft-room tab not found")
        debugger_endpoint = target.get("webSocketDebuggerUrl")
        if not isinstance(debugger_endpoint, str):
            raise TypeError("CDP target is unavailable")
        self.socket = connector(debugger_endpoint, timeout=5, suppress_origin=True)
        self.request_id, self.frames = 0, []
        self.tracked_requests: set[str] = set()
        self._command("Network.enable")
        if reload_page:
            self._command("Page.reload", {"ignoreCache": False})

    def _command(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.request_id += 1
        request_id = self.request_id
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            response = json.loads(self.socket.recv())
            if response.get("id") == request_id:
                return
            self._record(response)

    def _record(self, response: dict[str, Any]) -> None:
        method, params = response.get("method"), response.get("params", {})
        if method == "Network.webSocketCreated":
            request_id, socket_url = params.get("requestId"), params.get("url")
            # Inspect the host in memory only. The URL is never retained or logged.
            if (
                isinstance(request_id, str)
                and isinstance(socket_url, str)
                and urlparse(socket_url).hostname == "fantasydraft.espn.com"
            ):
                self.tracked_requests.add(request_id)
            return
        if (
            method != "Network.webSocketFrameReceived"
            or params.get("requestId") not in self.tracked_requests
        ):
            return
        payload = params.get("response", {}).get("payloadData")
        if isinstance(payload, str) and payload.startswith(("INIT ", "SELECTED ")):
            self.frames.append({"at": round(time.time() * 1000), "data": payload})

    def read(self, wait_seconds: float) -> list[dict[str, Any]]:
        deadline = time.monotonic() + wait_seconds
        self.socket.settimeout(max(0.05, min(wait_seconds, 0.25)))
        while time.monotonic() < deadline:
            try:
                response = json.loads(self.socket.recv())
            except websocket.WebSocketTimeoutException:
                continue
            self._record(response)
        frames, self.frames = self.frames, []
        return frames

    def close(self) -> None:
        self.socket.close()
