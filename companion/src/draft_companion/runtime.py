from __future__ import annotations

import json
import os
import platform
import signal
import tempfile
import time
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import urlencode

from . import __version__
from .cdp import (
    DraftRoomAmbiguousError,
    DraftRoomIdentity,
    DraftRoomNotFoundError,
    FrameSource,
    discover_chrome,
    launch_chrome,
    list_tabs,
)
from .config import Config
from .credentials import load_credentials, load_or_create_device
from .frames import DecodeError, decode_init_picks, selected_frame
from .worker import DeviceWorkerClient, WorkerClient, WorkerError, utc_now


def atomic_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            if hasattr(os, "fchmod"):
                os.fchmod(handle.fileno(), 0o600)
            json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def append_evidence(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        os.write(fd, (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode())
        os.fsync(fd)
    finally:
        os.close(fd)


def load_initializer(path: Path, draft_key: str) -> dict[str, Any]:
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("initializer exceeds 2 MiB")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if (
        not isinstance(payload, dict)
        or payload.get("schemaVersion") != 1
        or payload.get("draftKey") != draft_key
    ):
        raise ValueError("invalid or mismatched draft initializer")
    teams, total, count = (
        payload.get("draftSlotTeamIds"),
        payload.get("totalPickSlots"),
        payload.get("expectedTeams"),
    )
    if (
        not isinstance(teams, list)
        or len(teams) != total
        or not isinstance(count, int)
        or count < 2
    ):
        raise ValueError("initializer draft order is invalid")
    return payload


def _draft_identity(draft: Mapping[str, Any]) -> DraftRoomIdentity:
    return DraftRoomIdentity(
        season=int(draft["season"]),
        league_id=str(draft["leagueId"]),
        draft_epoch=int(draft["draftEpoch"]),
    )


def _canonical_dom_picks(
    dom_picks: list[dict[str, int]], draft_slot_team_ids: list[str]
) -> dict[int, dict[str, int]]:
    recovered: dict[int, dict[str, int]] = {}
    for pick in dom_picks:
        overall = int(pick["pickNumber"])
        if overall > len(draft_slot_team_ids):
            raise ValueError("DOM pick exceeds initialized draft order")
        recovered[overall] = {
            **pick,
            "teamId": int(draft_slot_team_ids[overall - 1]),
        }
    return recovered


def _draft_options(drafts: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "draftKey": str(draft["draftKey"]),
            "displayName": str(draft["displayName"]),
            "season": int(draft["season"]),
            "leagueId": str(draft["leagueId"]),
            "draftEpoch": int(draft["draftEpoch"]),
        }
        for draft in drafts
    ]


def _selection_key(path: Path) -> str | None:
    try:
        if path.stat().st_size > 1024:
            raise ValueError("draft selection is too large")
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, json.JSONDecodeError):
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return None
    draft_key = value.get("draftKey") if isinstance(value, dict) else None
    return draft_key if isinstance(draft_key, str) and 1 <= len(draft_key) <= 240 else None


def _room_payload(identities: list[DraftRoomIdentity | None]) -> list[dict[str, Any]]:
    rooms: dict[tuple[int | None, str], dict[str, Any]] = {}
    for identity in identities:
        if identity is None or identity.league_id is None:
            continue
        key = (identity.season, identity.league_id)
        rooms[key] = {"season": identity.season, "leagueId": identity.league_id}
    return list(rooms.values())[:8]


def _contiguous_pick_cursor(picks: Mapping[int, object]) -> int:
    cursor = 0
    while cursor + 1 in picks:
        cursor += 1
    return cursor


def _accepted_recovery(
    existing: Mapping[int, Mapping[str, int]],
    recovered: dict[int, dict[str, int]],
    source: str,
) -> dict[int, dict[str, int]] | None:
    if len(recovered) < len(existing):
        return None
    for overall, pick in existing.items():
        if recovered.get(overall) != pick:
            raise RuntimeError(f"{source} draft board conflicts with prior picks")
    return recovered


class Companion:
    def __init__(
        self,
        config: Config,
        *,
        frame_factory=FrameSource,
        worker_factory=WorkerClient,
        credential_loader=load_credentials,
        device_loader=load_or_create_device,
        sleeper=time.sleep,
    ):
        self.config, self.frame_factory, self.worker_factory = config, frame_factory, worker_factory
        self.credential_loader, self.device_loader, self.sleeper = (
            credential_loader,
            device_loader,
            sleeper,
        )
        self.stopping = False
        self.last_logged_status: tuple[str, object] | None = None
        self.picks: dict[int, dict[str, int]] = {}
        self.draft_key = config.draft_key
        self.dashboard_url = config.worker_base

    def _health(self, state: str, **fields: Any) -> None:
        allowed = {
            "filledPicks",
            "totalPicks",
            "lastCommitMs",
            "reconnects",
            "reason",
            "workerRevision",
            "dashboardUrl",
            "message",
            "draftOptions",
            "selectedDraft",
        }
        value = {"schemaVersion": 1, "state": state, "updatedAt": utc_now(), "pid": os.getpid()}
        value.update({k: v for k, v in fields.items() if k in allowed})
        atomic_json(self.config.health_file, value)
        status_key = (state, value.get("reason"))
        if status_key != self.last_logged_status:
            safe_log_fields = {
                key: value[key]
                for key in ("state", "reason", "filledPicks", "totalPicks", "reconnects")
                if key in value
            }
            print(json.dumps({"event": "status", **safe_log_fields}, sort_keys=True), flush=True)
            self.last_logged_status = status_key

    def _checkpoint(self) -> None:
        atomic_json(
            self.config.checkpoint_file,
            {
                "schemaVersion": 1,
                "draftKey": self.draft_key,
                "picks": [self.picks[k] for k in sorted(self.picks)],
            },
        )

    def stop(self, *_args: Any) -> None:
        self.stopping = True

    def _connect_device_draft(
        self, worker: DeviceWorkerClient
    ) -> tuple[Mapping[str, Any], Any, Mapping[str, Any], list[dict[str, Any]]] | None:
        while not self.stopping:
            try:
                worker.enroll(platform.node() or "Draft laptop", __version__)
                break
            except WorkerError as error:
                reason = str(error)
                if reason == "device_revoked":
                    raise
                self._health(
                    "dashboard_unreachable",
                    reason=reason,
                    dashboardUrl=self.dashboard_url,
                )
                self.sleeper(self.config.runtime.reconnect_seconds)
        if self.stopping:
            return None
        # Attaching must never disturb the user's live ESPN room. The rendered
        # board snapshot provides catch-up without a page refresh.
        reload_page = False
        while not self.stopping:
            source = None
            try:
                preferred = None
                bootstrap = None
                selection_key = _selection_key(self.config.selection_file)
                if selection_key is not None:
                    bootstrap, preferred = worker.select_draft(selection_key)
                preferred_identity = _draft_identity(preferred) if preferred is not None else None
                source = self.frame_factory(
                    self.config.chrome.debug_port,
                    self.config.draft_url,
                    reload_page,
                    preferred_identity=preferred_identity,
                )
                reload_page = False
                if preferred is not None and bootstrap is not None:
                    try:
                        self.config.selection_file.unlink()
                    except FileNotFoundError:
                        pass
                    connected_source, source = source, None
                    return bootstrap, connected_source, preferred, [_draft_options([preferred])[0]]
                room_identity = getattr(source, "room_identity", None)
                if room_identity is None and hasattr(source, "wait_for_identity"):
                    room_identity = source.wait_for_identity(1.0)
                rooms = _room_payload([room_identity])
                if not rooms:
                    self._health(
                        "draft_room_unidentified",
                        reason="draft_room_unidentified",
                        dashboardUrl=self.dashboard_url,
                    )
                    source.close()
                    source = None
                    self.sleeper(self.config.runtime.reconnect_seconds)
                    continue
                drafts = worker.resolve_drafts(rooms)
                options = _draft_options(drafts)
                if len(drafts) != 1:
                    state = "draft_selection_required" if drafts else "draft_not_initialized"
                    self._health(
                        state,
                        reason=state,
                        dashboardUrl=self.dashboard_url,
                        draftOptions=options,
                    )
                    source.close()
                    source = None
                    self.sleeper(self.config.runtime.reconnect_seconds)
                    continue
                bootstrap, selected = worker.select_draft(str(drafts[0]["draftKey"]))
                try:
                    self.config.selection_file.unlink()
                except FileNotFoundError:
                    pass
                connected_source, source = source, None
                return bootstrap, connected_source, selected, options
            except WorkerError as error:
                reason = str(error)
                if reason == "device_revoked":
                    raise
                if reason == "device_selection_draft_not_found":
                    try:
                        self.config.selection_file.unlink()
                    except FileNotFoundError:
                        pass
                self._health(
                    "dashboard_unreachable",
                    reason=reason,
                    dashboardUrl=self.dashboard_url,
                )
                self.sleeper(self.config.runtime.reconnect_seconds)
            except DraftRoomAmbiguousError as error:
                rooms = _room_payload(error.identities)
                try:
                    drafts = worker.resolve_drafts(rooms) if rooms else []
                except WorkerError as worker_error:
                    reason = str(worker_error)
                    if reason == "device_revoked":
                        raise
                    self._health(
                        "dashboard_unreachable",
                        reason=reason,
                        dashboardUrl=self.dashboard_url,
                    )
                    self.sleeper(self.config.runtime.reconnect_seconds)
                    continue
                if len(drafts) == 1:
                    selected = drafts[0]
                    source = self.frame_factory(
                        self.config.chrome.debug_port,
                        self.config.draft_url,
                        reload_page,
                        preferred_identity=_draft_identity(selected),
                    )
                    reload_page = False
                    try:
                        bootstrap, selected = worker.select_draft(str(selected["draftKey"]))
                    except WorkerError as worker_error:
                        reason = str(worker_error)
                        if reason == "device_revoked":
                            raise
                        self._health(
                            "dashboard_unreachable",
                            reason=reason,
                            dashboardUrl=self.dashboard_url,
                        )
                        self.sleeper(self.config.runtime.reconnect_seconds)
                        continue
                    connected_source, source = source, None
                    return bootstrap, connected_source, selected, _draft_options(drafts)
                state = (
                    "draft_room_unidentified"
                    if not rooms
                    else "draft_selection_required"
                    if drafts
                    else "draft_not_initialized"
                )
                self._health(
                    state,
                    reason=(
                        "multiple_draft_rooms_open"
                        if state == "draft_selection_required"
                        else state
                    ),
                    dashboardUrl=self.dashboard_url,
                    draftOptions=_draft_options(drafts),
                )
                self.sleeper(self.config.runtime.reconnect_seconds)
            except DraftRoomNotFoundError:
                self._health(
                    "waiting_for_draft_room",
                    reason="draft_room_not_open",
                    dashboardUrl=self.dashboard_url,
                )
                self.sleeper(self.config.runtime.reconnect_seconds)
            except URLError:
                self._health(
                    "chrome_unavailable",
                    reason="chrome_debugging_unavailable",
                    dashboardUrl=self.dashboard_url,
                )
                try:
                    ensure_chrome(self.config, sleeper=self.sleeper)
                except (OSError, RuntimeError, ValueError):
                    pass
                self.sleeper(self.config.runtime.reconnect_seconds)
            finally:
                if source is not None:
                    try:
                        source.close()
                    except OSError:
                        pass
        return None

    def run(self) -> None:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        pending_source = None
        selected_draft = None
        draft_options: list[dict[str, Any]] = []
        if self.config.runtime.credential_source == "device":
            device = self.device_loader(self.config.runtime.keyring_service)
            worker = DeviceWorkerClient(
                self.config.worker_base,
                device,
                self.config.runtime.request_timeout_seconds,
            )
            self._health("connecting_dashboard", dashboardUrl=self.dashboard_url)
            try:
                connection = self._connect_device_draft(worker)
            except WorkerError as error:
                reason = str(error)
                state = "revoked" if reason == "device_revoked" else "dashboard_unreachable"
                self._health(state, reason=reason, dashboardUrl=self.dashboard_url)
                raise
            if connection is None:
                self._health("stopped", dashboardUrl=self.dashboard_url)
                return
            bootstrap, pending_source, selected_draft, draft_options = connection
            self.draft_key = str(bootstrap["draftKey"])
            draft_url = str(bootstrap["draftUrl"])
            init = {
                "schemaVersion": 1,
                "draftKey": self.draft_key,
                "expectedTeams": int(bootstrap["expectedTeams"]),
                "totalPickSlots": int(bootstrap["totalPickSlots"]),
                "draftSlotTeamIds": bootstrap["draftSlotTeamIds"],
                "prefilledPickNumbers": bootstrap["prefilledPickNumbers"],
            }
            self.dashboard_url = (
                f"{self.config.worker_base}/?{urlencode({'draft': self.draft_key})}"
            )
        else:
            if self.config.init_file is None or self.config.draft_key is None:
                raise ValueError("legacy credentials require draft_key and init_file")
            init = load_initializer(self.config.init_file, self.config.draft_key)
            creds = self.credential_loader(
                self.config.runtime.credential_source, self.config.runtime.keyring_service
            )
            worker = self.worker_factory(
                self.config.worker_base,
                self.config.draft_key,
                creds,
                self.config.runtime.request_timeout_seconds,
            )
            worker.initialize(init)
            draft_url = self.config.draft_url
        if self.config.checkpoint_file.exists():
            stored = json.loads(self.config.checkpoint_file.read_text(encoding="utf-8"))
            if stored.get("draftKey") == self.draft_key:
                self.picks = {int(p["pickNumber"]): p for p in stored.get("picks", [])}
        reconnects = 0
        reload_draft_room = pending_source is None
        self._health(
            "waiting_for_draft_room",
            filledPicks=len(self.picks),
            totalPicks=init["totalPickSlots"],
            reason="draft_room_not_open",
            dashboardUrl=self.dashboard_url,
            selectedDraft=selected_draft,
            draftOptions=draft_options,
        )
        while not self.stopping:
            source = None
            try:
                if pending_source is not None:
                    source, pending_source = pending_source, None
                elif selected_draft is not None:
                    source = self.frame_factory(
                        self.config.chrome.debug_port,
                        draft_url,
                        reload_draft_room,
                        preferred_identity=_draft_identity(selected_draft),
                    )
                else:
                    source = self.frame_factory(
                        self.config.chrome.debug_port,
                        draft_url,
                        reload_draft_room,
                    )
                reload_draft_room = False
                last_delivery = time.monotonic()
                worker.heartbeat(_contiguous_pick_cursor(self.picks), init["totalPickSlots"])
                self._health(
                    "live",
                    filledPicks=len(self.picks),
                    totalPicks=init["totalPickSlots"],
                    reconnects=reconnects,
                    dashboardUrl=self.dashboard_url,
                    selectedDraft=selected_draft,
                    draftOptions=draft_options,
                )
                while not self.stopping:
                    changed_at = None
                    recovered = False
                    for frame in source.read(0.25):
                        dom_picks = frame.get("picks")
                        if isinstance(dom_picks, list):
                            recovered_picks = _canonical_dom_picks(
                                dom_picks, init["draftSlotTeamIds"]
                            )
                            accepted = _accepted_recovery(self.picks, recovered_picks, "DOM")
                            if accepted is None:
                                continue
                            self.picks = accepted
                            recovered = True
                            changed_at = frame.get("at")
                            continue
                        message = frame.get("data")
                        if not isinstance(message, str):
                            continue
                        if message.startswith("INIT "):
                            decoded = decode_init_picks(message)
                            recovered_picks = {p["pickNumber"]: p for p in decoded}
                            accepted = _accepted_recovery(self.picks, recovered_picks, "INIT")
                            if accepted is None:
                                continue
                            self.picks = accepted
                            recovered = True
                        else:
                            selected = selected_frame(message)
                            if selected is None:
                                continue
                            overall = _contiguous_pick_cursor(self.picks) + 1
                            team, player, slot = selected
                            if overall > init["totalPickSlots"] or str(team) != str(
                                init["draftSlotTeamIds"][overall - 1]
                            ):
                                raise RuntimeError(
                                    "live pick does not match initialized draft order"
                                )
                            self.picks[overall] = {
                                "teamId": team,
                                "pickNumber": overall,
                                "playerId": player,
                                "slotId": slot,
                            }
                        changed_at = frame.get("at")
                    if changed_at is None:
                        if (
                            time.monotonic() - last_delivery
                            >= self.config.runtime.heartbeat_seconds
                        ):
                            ack = worker.heartbeat(
                                _contiguous_pick_cursor(self.picks), init["totalPickSlots"]
                            )
                            last_delivery = time.monotonic()
                            self._health(
                                "live",
                                filledPicks=len(self.picks),
                                totalPicks=init["totalPickSlots"],
                                reconnects=reconnects,
                                workerRevision=ack["revision"],
                                dashboardUrl=self.dashboard_url,
                                selectedDraft=selected_draft,
                                draftOptions=draft_options,
                            )
                        continue
                    observed = (
                        datetime.fromtimestamp(float(changed_at) / 1000, UTC)
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z")
                    )
                    normalized = {
                        overall: {
                            **pick,
                            "round": (overall - 1) // init["expectedTeams"] + 1,
                            "roundPick": (overall - 1) % init["expectedTeams"] + 1,
                        }
                        for overall, pick in self.picks.items()
                    }
                    complete = len(self.picks) == init["totalPickSlots"]
                    started = time.monotonic()
                    ack = worker.ingest(normalized, init["totalPickSlots"], complete, observed)
                    last_delivery = time.monotonic()
                    self._checkpoint()
                    duration = round((time.monotonic() - started) * 1000, 1)
                    event = {
                        "at": utc_now(),
                        "event": "board_committed",
                        "filledPicks": len(self.picks),
                        "recoveredFromInit": recovered,
                        "commitDurationMs": duration,
                    }
                    append_evidence(self.config.evidence_file, event)
                    self._health(
                        "complete" if complete else "live",
                        filledPicks=len(self.picks),
                        totalPicks=init["totalPickSlots"],
                        reconnects=reconnects,
                        lastCommitMs=duration,
                        workerRevision=ack["revision"],
                        dashboardUrl=self.dashboard_url,
                        selectedDraft=selected_draft,
                        draftOptions=draft_options,
                    )
                    if complete:
                        self.stopping = True
            except DraftRoomNotFoundError:
                self._health(
                    "waiting_for_draft_room",
                    filledPicks=len(self.picks),
                    totalPicks=init["totalPickSlots"],
                    reason="draft_room_not_open",
                    dashboardUrl=self.dashboard_url,
                    selectedDraft=selected_draft,
                    draftOptions=draft_options,
                )
                if not self.stopping:
                    self.sleeper(self.config.runtime.reconnect_seconds)
            except URLError:
                reconnects += 1
                reload_draft_room = True
                self._health(
                    "chrome_unavailable",
                    filledPicks=len(self.picks),
                    totalPicks=init["totalPickSlots"],
                    reconnects=reconnects,
                    reason="chrome_debugging_unavailable",
                    dashboardUrl=self.dashboard_url,
                    selectedDraft=selected_draft,
                    draftOptions=draft_options,
                )
                if not self.stopping:
                    try:
                        ensure_chrome(self.config, sleeper=self.sleeper)
                    except (OSError, RuntimeError, ValueError):
                        pass
                    self.sleeper(self.config.runtime.reconnect_seconds)
            except WorkerError as error:
                reconnects += 1
                reason = str(error)
                if reason == "device_revoked":
                    state = "revoked"
                elif reason.startswith(
                    ("worker_ingest_invalid_", "worker_ingest_unsupported_")
                ) or reason in {
                    "worker_ingest_events_not_strictly_ordered",
                    "worker_ingest_pick_conflict",
                    "worker_ingest_event_id_conflict",
                    "worker_ingest_draft_identity_conflict",
                }:
                    state = "delivery_rejected"
                else:
                    state = "dashboard_unreachable"
                self._health(
                    state,
                    filledPicks=len(self.picks),
                    totalPicks=init["totalPickSlots"],
                    reconnects=reconnects,
                    reason=reason,
                    dashboardUrl=self.dashboard_url,
                    selectedDraft=selected_draft,
                    draftOptions=draft_options,
                )
                if not self.stopping:
                    self.sleeper(self.config.runtime.reconnect_seconds)
            except (OSError, RuntimeError, DecodeError, ValueError):
                reconnects += 1
                # Reattach to the read-only page after stream/DOM failures. A
                # reload is disruptive during a live pick and cannot repair a
                # bad board identity; the DOM snapshot will recover any gap.
                reload_draft_room = False
                self._health(
                    "reconnecting",
                    filledPicks=len(self.picks),
                    totalPicks=init["totalPickSlots"],
                    reconnects=reconnects,
                    reason="draft_stream_error",
                    dashboardUrl=self.dashboard_url,
                    selectedDraft=selected_draft,
                    draftOptions=draft_options,
                )
                if not self.stopping:
                    self.sleeper(self.config.runtime.reconnect_seconds)
            finally:
                if source is not None:
                    try:
                        source.close()
                    except OSError:
                        pass
        self._health(
            "stopped" if len(self.picks) < init["totalPickSlots"] else "complete",
            filledPicks=len(self.picks),
            totalPicks=init["totalPickSlots"],
            reconnects=reconnects,
            dashboardUrl=self.dashboard_url,
            selectedDraft=selected_draft,
            draftOptions=draft_options,
        )


def ensure_chrome(
    config: Config,
    *,
    tabs_loader=list_tabs,
    launcher=launch_chrome,
    discover=discover_chrome,
    sleeper=time.sleep,
) -> None:
    try:
        tabs_loader(config.chrome.debug_port)
        return
    except Exception:
        if not config.chrome.launch:
            raise RuntimeError("Chrome CDP is not reachable") from None
    launcher(
        discover(config.chrome.executable),
        config.chrome.profile_directory,
        config.chrome.debug_port,
        config.chrome.start_url,
    )
    for _ in range(30):
        try:
            tabs_loader(config.chrome.debug_port)
            return
        except Exception:
            sleeper(0.25)
    raise RuntimeError("Chrome did not expose its local debugging endpoint")


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
