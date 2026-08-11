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

from .cdp import FrameSource, discover_chrome, launch_chrome, list_tabs
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
        }
        value = {"schemaVersion": 1, "state": state, "updatedAt": utc_now(), "pid": os.getpid()}
        value.update({k: v for k, v in fields.items() if k in allowed})
        atomic_json(self.config.health_file, value)

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

    def run(self) -> None:
        if self.config.runtime.credential_source == "device":
            device = self.device_loader(self.config.runtime.keyring_service)
            worker = DeviceWorkerClient(
                self.config.worker_base,
                device,
                self.config.runtime.request_timeout_seconds,
            )
            try:
                bootstrap = worker.enroll(platform.node() or "Draft laptop", "0.2.0")
            except WorkerError as error:
                state = "revoked" if str(error) == "device_revoked" else "reconnecting"
                self._health(state, message=str(error), dashboardUrl=self.dashboard_url)
                raise
            self.draft_key = str(bootstrap["draftKey"])
            draft_url = str(bootstrap["draftUrl"])
            init = {
                "schemaVersion": 1,
                "draftKey": self.draft_key,
                "expectedTeams": int(bootstrap["expectedTeams"]),
                "totalPickSlots": int(bootstrap["totalPickSlots"]),
                "draftSlotTeamIds": bootstrap["draftSlotTeamIds"],
            }
            self.dashboard_url = f"{self.config.worker_base}/?draft={self.draft_key}"
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
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        reconnects = 0
        self._health(
            "starting",
            filledPicks=len(self.picks),
            totalPicks=init["totalPickSlots"],
            dashboardUrl=self.dashboard_url,
        )
        while not self.stopping:
            source = None
            try:
                source = self.frame_factory(
                    self.config.chrome.debug_port,
                    draft_url,
                    self.config.chrome.reload_on_attach,
                )
                last_delivery = time.monotonic()
                worker.heartbeat(len(self.picks), init["totalPickSlots"])
                self._health(
                    "live",
                    filledPicks=len(self.picks),
                    totalPicks=init["totalPickSlots"],
                    reconnects=reconnects,
                    dashboardUrl=self.dashboard_url,
                )
                while not self.stopping:
                    changed_at = None
                    recovered = False
                    for frame in source.read(0.25):
                        message = frame.get("data")
                        if not isinstance(message, str):
                            continue
                        if message.startswith("INIT "):
                            decoded = decode_init_picks(message)
                            self.picks = {p["pickNumber"]: p for p in decoded}
                            recovered = True
                        else:
                            selected = selected_frame(message)
                            if selected is None:
                                continue
                            overall = len(self.picks) + 1
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
                            ack = worker.heartbeat(len(self.picks), init["totalPickSlots"])
                            last_delivery = time.monotonic()
                            self._health(
                                "live",
                                filledPicks=len(self.picks),
                                totalPicks=init["totalPickSlots"],
                                reconnects=reconnects,
                                workerRevision=ack["revision"],
                                dashboardUrl=self.dashboard_url,
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
                    )
                    if complete:
                        self.stopping = True
            except (OSError, RuntimeError, DecodeError, ValueError) as error:
                reconnects += 1
                self._health(
                    "reconnecting",
                    filledPicks=len(self.picks),
                    totalPicks=init["totalPickSlots"],
                    reconnects=reconnects,
                    reason=error.__class__.__name__,
                    dashboardUrl=self.dashboard_url,
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
        config.draft_url,
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
