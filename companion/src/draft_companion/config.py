from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


@dataclass(frozen=True)
class ChromeConfig:
    executable: str | None
    profile_directory: Path
    debug_port: int
    launch: bool
    reload_on_attach: bool


@dataclass(frozen=True)
class RuntimeConfig:
    state_directory: Path
    reconnect_seconds: float
    heartbeat_seconds: float
    health_stale_seconds: float
    request_timeout_seconds: float
    credential_source: str
    keyring_service: str


@dataclass(frozen=True)
class Config:
    worker_base: str
    draft_key: str
    init_file: Path
    draft_url: str
    chrome: ChromeConfig
    runtime: RuntimeConfig

    @property
    def checkpoint_file(self) -> Path:
        return self.runtime.state_directory / "checkpoint.json"

    @property
    def evidence_file(self) -> Path:
        return self.runtime.state_directory / "evidence.ndjson"

    @property
    def health_file(self) -> Path:
        return self.runtime.state_directory / "health.json"

    @property
    def pid_file(self) -> Path:
        return self.runtime.state_directory / "companion.pid"


def _path(base: Path, value: object, name: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} is required")
    result = Path(os.path.expandvars(os.path.expanduser(value)))
    return result if result.is_absolute() else (base / result).resolve()


def load_config(path: Path) -> Config:
    path = Path(path).resolve()
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    base = path.parent
    worker_base = str(raw.get("worker_base", "")).rstrip("/")
    worker_url = urlparse(worker_base)
    if (
        worker_url.scheme != "https"
        or not worker_url.netloc
        or worker_url.username is not None
        or worker_url.password is not None
        or worker_url.query
        or worker_url.fragment
        or worker_url.path not in {"", "/"}
    ):
        raise ValueError("worker_base must be an https URL")
    draft_key = raw.get("draft_key")
    if not isinstance(draft_key, str) or not draft_key.strip():
        raise ValueError("draft_key is required")
    draft_url = raw.get("draft_url")
    parsed_draft_url = urlparse(draft_url) if isinstance(draft_url, str) else None
    if (
        parsed_draft_url is None
        or parsed_draft_url.scheme != "https"
        or parsed_draft_url.hostname != "fantasy.espn.com"
        or not parsed_draft_url.path.startswith("/football/draft")
        or parsed_draft_url.username is not None
        or parsed_draft_url.password is not None
    ):
        raise ValueError("draft_url must be an ESPN fantasy football draft URL")
    chrome = raw.get("chrome", {})
    runtime = raw.get("runtime", {})
    debug_port = int(chrome.get("debug_port", 9222))
    if not 1024 <= debug_port <= 65535:
        raise ValueError("chrome.debug_port must be between 1024 and 65535")
    credential_source = str(runtime.get("credential_source", "environment"))
    if credential_source not in {"environment", "keyring"}:
        raise ValueError("runtime.credential_source must be environment or keyring")
    reconnect = float(runtime.get("reconnect_seconds", 2.0))
    heartbeat = float(runtime.get("heartbeat_seconds", 15.0))
    stale = float(runtime.get("health_stale_seconds", 45.0))
    timeout = float(runtime.get("request_timeout_seconds", 10.0))
    if reconnect < 0.25 or not 5 <= heartbeat <= 30 or stale < 2 or timeout <= 0:
        raise ValueError("runtime timing values are out of bounds")
    executable = chrome.get("executable") or None
    return Config(
        worker_base=worker_base,
        draft_key=draft_key,
        init_file=_path(base, raw.get("init_file"), "init_file"),
        draft_url=draft_url,
        chrome=ChromeConfig(
            executable=str(executable) if executable else None,
            profile_directory=_path(
                base,
                chrome.get("profile_directory", "./state/chrome-profile"),
                "chrome.profile_directory",
            ),
            debug_port=debug_port,
            launch=bool(chrome.get("launch", True)),
            reload_on_attach=bool(chrome.get("reload_on_attach", True)),
        ),
        runtime=RuntimeConfig(
            state_directory=_path(
                base, runtime.get("state_directory", "./state"), "runtime.state_directory"
            ),
            reconnect_seconds=reconnect,
            heartbeat_seconds=heartbeat,
            health_stale_seconds=stale,
            request_timeout_seconds=timeout,
            credential_source=credential_source,
            keyring_service=str(runtime.get("keyring_service", "draftside-companion")),
        ),
    )
