from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import websocket

DOM_BOARD_EXPRESSION = r"""(() => {
  const elements = [
    document.querySelector('.completedPick'),
    document.querySelector('.draftContainer'),
    document.body,
  ].filter(Boolean);
  for (const element of elements) {
    const internalKey = Object.getOwnPropertyNames(element).find(
      (key) => key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$')
    );
    let fiber = internalKey ? element[internalKey] : null;
    for (let depth = 0; fiber && depth < 30; depth += 1, fiber = fiber.return) {
      for (const props of [fiber.pendingProps, fiber.memoizedProps]) {
        const picks = props?.store?.draft?.picks;
        if (!Array.isArray(picks)) continue;
        return picks
          .filter((pick) => pick && Number.isInteger(pick.playerId) && pick.playerId !== -1)
          .map((pick) => ({
            pickNumber: pick.pickNumber,
            teamId: pick.teamId,
            playerId: pick.playerId,
            slotId: pick.slotId,
          }));
      }
    }
  }
  return null;
})()"""


class DraftRoomNotFoundError(RuntimeError):
    """Raised while Chrome is open but no ESPN draft-room tab is available."""


class DraftRoomAmbiguousError(RuntimeError):
    """Raised when multiple distinct ESPN draft rooms are open."""

    def __init__(self, identities: list[DraftRoomIdentity | None]):
        super().__init__("multiple ESPN draft-room tabs are open")
        self.identities = identities


def validated_dom_picks(value: Any) -> list[dict[str, int]] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > 1000:
        raise ValueError("invalid DOM draft board")
    picks = []
    seen_pick_numbers: set[int] = set()
    for item in value:
        if not isinstance(item, dict):
            raise TypeError("invalid DOM draft pick")
        pick_number = item.get("pickNumber")
        team_id = item.get("teamId")
        player_id = item.get("playerId")
        slot_id = item.get("slotId")
        if (
            type(pick_number) is not int
            or not 1 <= pick_number <= 1000
            or type(team_id) is not int
            or not 1 <= team_id <= 10**9
            or type(player_id) is not int
            or not -(10**9) <= player_id <= 10**9
            or player_id == -1
            or type(slot_id) is not int
            or not 0 <= slot_id <= 100
        ):
            raise ValueError("invalid DOM draft pick")
        if pick_number in seen_pick_numbers:
            raise ValueError("duplicate DOM draft pick")
        seen_pick_numbers.add(pick_number)
        picks.append(
            {
                "pickNumber": pick_number,
                "teamId": team_id,
                "playerId": player_id,
                "slotId": slot_id,
            }
        )
    picks.sort(key=lambda pick: pick["pickNumber"])
    return picks


@dataclass(frozen=True)
class DraftRoomIdentity:
    season: int | None = None
    league_id: str | None = None
    draft_epoch: int | None = None


def _numeric_query_value(url: str, names: set[str], maximum: int) -> int | None:
    parsed = urlparse(url)
    query = parsed.query
    if "?" in parsed.fragment:
        query += "&" + parsed.fragment.split("?", 1)[1]
    values = parse_qs(query, keep_blank_values=False)
    for name, candidates in values.items():
        if name.lower() not in names:
            continue
        for candidate in candidates:
            if candidate.isascii() and candidate.isdigit() and 1 <= int(candidate) <= maximum:
                return int(candidate)
    return None


def draft_room_identity(url: str) -> DraftRoomIdentity | None:
    """Extract only bounded public draft identifiers; never retain the source URL."""
    parsed = urlparse(url)
    if parsed.scheme not in {"https", "wss"} or parsed.hostname not in {
        "fantasy.espn.com",
        "fantasydraft.espn.com",
    }:
        return None
    league_id = _numeric_query_value(url, {"league", "leagueid", "league_id"}, 10**12)
    season = _numeric_query_value(url, {"season", "seasonid", "season_id"}, 2200)
    draft_epoch = _numeric_query_value(
        url, {"draft", "draftid", "draftepoch", "draft_epoch"}, 10**15
    )
    if league_id is None and season is None and draft_epoch is None:
        return None
    return DraftRoomIdentity(
        season=season,
        league_id=str(league_id) if league_id is not None else None,
        draft_epoch=draft_epoch,
    )


def identity_matches(identity: DraftRoomIdentity | None, draft: DraftRoomIdentity | None) -> bool:
    if identity is None or draft is None:
        return False
    if identity.league_id is not None and draft.league_id is not None:
        if identity.league_id != draft.league_id:
            return False
        return identity.season is None or draft.season is None or identity.season == draft.season
    return (
        identity.draft_epoch is not None
        and draft.draft_epoch is not None
        and identity.draft_epoch == draft.draft_epoch
    )


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
    executable: str, profile: Path, port: int, start_url: str
) -> subprocess.Popen[Any]:
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(profile, 0o700)
    return subprocess.Popen(
        [
            executable,
            f"--remote-debugging-port={port}",
            "--remote-debugging-address=127.0.0.1",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            start_url,
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
        preferred_identity: DraftRoomIdentity | None = None,
        tabs_loader=list_tabs,
        connector=websocket.create_connection,
    ):
        tabs = tabs_loader(port)
        candidates = [tab for tab in tabs if str(tab.get("url", "")).startswith(draft_url)]
        if not candidates:
            raise DraftRoomNotFoundError("ESPN draft-room tab not found")
        identities = [draft_room_identity(str(tab.get("url", ""))) for tab in candidates]
        if preferred_identity is not None:
            matching = [
                tab
                for tab, identity in zip(candidates, identities, strict=True)
                if identity_matches(identity, preferred_identity)
            ]
            if not matching and len(candidates) == 1 and identities[0] is None:
                matching = candidates
            if not matching:
                raise DraftRoomNotFoundError("selected ESPN draft-room tab not found")
            target = matching[0]
            self.room_identity = preferred_identity
        else:
            distinct = {identity for identity in identities if identity is not None}
            if len(candidates) > 1 and (len(distinct) > 1 or any(i is None for i in identities)):
                raise DraftRoomAmbiguousError(identities)
            target = candidates[0]
            self.room_identity = identities[0]
        debugger_endpoint = target.get("webSocketDebuggerUrl")
        if not isinstance(debugger_endpoint, str):
            raise TypeError("CDP target is unavailable")
        self.socket = connector(debugger_endpoint, timeout=5, suppress_origin=True)
        self.request_id, self.frames = 0, []
        self.tracked_requests: set[str] = set()
        self.last_dom_poll = 0.0
        self.last_dom_signature: tuple[tuple[int, int, int, int], ...] | None = None
        self._command("Network.enable")
        if reload_page:
            self._command("Page.reload", {"ignoreCache": False})

    def _command(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.request_id += 1
        request_id = self.request_id
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            response = json.loads(self.socket.recv())
            if response.get("id") == request_id:
                return response
            self._record(response)

    def _poll_dom_board(self) -> None:
        now = time.monotonic()
        if now - self.last_dom_poll < 0.75:
            return
        self.last_dom_poll = now
        try:
            response = self._command(
                "Runtime.evaluate",
                {"expression": DOM_BOARD_EXPRESSION, "returnByValue": True},
            )
        except websocket.WebSocketTimeoutException:
            return
        value = (
            response.get("result", {}).get("result", {}).get("value")
        )
        picks = validated_dom_picks(value)
        if picks is None:
            return
        signature = tuple(
            (
                pick["pickNumber"],
                pick["teamId"],
                pick["playerId"],
                pick["slotId"],
            )
            for pick in picks
        )
        if signature == self.last_dom_signature:
            return
        self.last_dom_signature = signature
        self.frames.append({"at": round(time.time() * 1000), "picks": picks})

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
                socket_identity = draft_room_identity(socket_url)
                if self.room_identity is None:
                    self.room_identity = socket_identity
                elif socket_identity is not None:
                    if (
                        self.room_identity.league_id is not None
                        and socket_identity.league_id is not None
                        and self.room_identity.league_id != socket_identity.league_id
                    ) or (
                        self.room_identity.season is not None
                        and socket_identity.season is not None
                        and self.room_identity.season != socket_identity.season
                    ):
                        raise RuntimeError("ESPN draft-room identity changed")
                    self.room_identity = DraftRoomIdentity(
                        season=self.room_identity.season or socket_identity.season,
                        league_id=self.room_identity.league_id or socket_identity.league_id,
                        draft_epoch=(self.room_identity.draft_epoch or socket_identity.draft_epoch),
                    )
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
        self._poll_dom_board()
        frames, self.frames = self.frames, []
        return frames

    def wait_for_identity(self, wait_seconds: float) -> DraftRoomIdentity | None:
        deadline = time.monotonic() + wait_seconds
        self.socket.settimeout(max(0.05, min(wait_seconds, 0.25)))
        while self.room_identity is None and time.monotonic() < deadline:
            try:
                response = json.loads(self.socket.recv())
            except websocket.WebSocketTimeoutException:
                continue
            self._record(response)
        return self.room_identity

    def close(self) -> None:
        self.socket.close()
