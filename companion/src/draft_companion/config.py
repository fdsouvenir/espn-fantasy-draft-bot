from __future__ import annotations

import json
import os
import shutil
import tempfile
import tomllib
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_ESPN_START_URL = "https://www.espn.com/fantasy/football/"


class SetupRequiredError(ValueError):
    """Raised when the desktop app still needs a user-confirmed dashboard URL."""


@dataclass(frozen=True)
class ChromeConfig:
    executable: str | None
    profile_directory: Path
    debug_port: int
    launch: bool
    reload_on_attach: bool
    start_url: str = DEFAULT_ESPN_START_URL


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
    draft_key: str | None
    init_file: Path | None
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


def normalize_worker_base(value: object) -> str:
    if not isinstance(value, str):
        raise TypeError("dashboard URL must be an https URL")
    worker_base = value.strip().rstrip("/")
    worker_url = urlparse(worker_base)
    try:
        port = worker_url.port
    except ValueError as error:
        raise ValueError("dashboard URL must be an https URL") from error
    if (
        worker_url.scheme != "https"
        or not worker_url.netloc
        or not worker_url.hostname
        or worker_url.username is not None
        or worker_url.password is not None
        or worker_url.query
        or worker_url.fragment
        or worker_url.path not in {"", "/"}
        or port is not None
        and not 1 <= port <= 65535
    ):
        raise ValueError("dashboard URL must be an https URL with no path or credentials")
    return worker_base


def _raw_config(path: Path) -> dict[str, object]:
    value = tomllib.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError("configuration must be a TOML table")
    return value


def dashboard_candidate(path: Path) -> str:
    """Return an existing endpoint for the first-launch form without trusting it."""
    try:
        return normalize_worker_base(_raw_config(Path(path).expanduser()).get("worker_base"))
    except (FileNotFoundError, OSError, TypeError, ValueError, tomllib.TOMLDecodeError):
        return ""


def dashboard_setup_required(path: Path) -> bool:
    try:
        raw = _raw_config(Path(path).expanduser())
        normalize_worker_base(raw.get("worker_base"))
    except (FileNotFoundError, OSError, TypeError, ValueError, tomllib.TOMLDecodeError):
        return True
    return raw.get("dashboard_configured_by_user") is not True


def write_device_config(path: Path, worker_base: str) -> str:
    """Write a user-confirmed, owner-only desktop configuration atomically."""
    path = Path(path).expanduser().resolve()
    worker_base = normalize_worker_base(worker_base)
    config_home = path.parent
    state_home = Path(os.environ.get("XDG_STATE_HOME", "~/.local/state")).expanduser()
    data_home = Path(os.environ.get("XDG_DATA_HOME", "~/.local/share")).expanduser()
    state_directory = state_home / "draftside-companion"
    profile_directory = data_home / "draftside-companion/chrome-profile"
    config_home.mkdir(parents=True, exist_ok=True)
    state_directory.mkdir(parents=True, exist_ok=True)
    profile_directory.mkdir(parents=True, exist_ok=True)
    for directory in (config_home, state_directory, profile_directory.parent, profile_directory):
        os.chmod(directory, 0o700)
    routing = "\n".join(
        [
            "config_version = 1",
            "dashboard_configured_by_user = true",
            f"worker_base = {json.dumps(worker_base)}",
            'draft_url = "https://fantasy.espn.com/football/draft"',
            "",
            "[chrome]",
            'executable = ""',
            f"profile_directory = {json.dumps(str(profile_directory))}",
            f"start_url = {json.dumps(DEFAULT_ESPN_START_URL)}",
            "debug_port = 9222",
            "launch = true",
            "reload_on_attach = true",
            "",
            "[runtime]",
            f"state_directory = {json.dumps(str(state_directory))}",
            "reconnect_seconds = 2.0",
            "heartbeat_seconds = 15.0",
            "health_stale_seconds = 45.0",
            "request_timeout_seconds = 10.0",
            'credential_source = "device"',
            'keyring_service = "draftside-companion"',
            "",
        ]
    )
    if path.exists() and dashboard_setup_required(path):
        backup = path.with_name(f"{path.name}.pre-0.3.0")
        if not backup.exists():
            shutil.copyfile(path, backup)
            os.chmod(backup, 0o600)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=config_home)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(routing)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        load_config(temporary)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return worker_base


def load_config(path: Path) -> Config:
    path = Path(path).resolve()
    raw = _raw_config(path)
    base = path.parent
    worker_base = normalize_worker_base(raw.get("worker_base"))
    draft_key = raw.get("draft_key") or None
    if draft_key is not None and (not isinstance(draft_key, str) or not draft_key.strip()):
        raise ValueError("draft_key must be a non-empty string")
    draft_url = raw.get("draft_url", "https://fantasy.espn.com/football/draft")
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
    start_url = chrome.get("start_url", DEFAULT_ESPN_START_URL)
    parsed_start_url = urlparse(start_url) if isinstance(start_url, str) else None
    if (
        parsed_start_url is None
        or parsed_start_url.scheme != "https"
        or parsed_start_url.hostname not in {"www.espn.com", "fantasy.espn.com"}
        or parsed_start_url.username is not None
        or parsed_start_url.password is not None
    ):
        raise ValueError("chrome.start_url must be an ESPN https URL")
    debug_port = int(chrome.get("debug_port", 9222))
    if not 1024 <= debug_port <= 65535:
        raise ValueError("chrome.debug_port must be between 1024 and 65535")
    credential_source = str(runtime.get("credential_source", "device"))
    if credential_source not in {"device", "environment", "keyring"}:
        raise ValueError("runtime.credential_source must be device, environment, or keyring")
    if raw.get("dashboard_configured_by_user") is not True:
        raise SetupRequiredError("confirm the private dashboard URL in Draftside Companion")
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
        init_file=(
            _path(base, raw.get("init_file"), "init_file")
            if raw.get("init_file") is not None
            else None
        ),
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
            start_url=start_url,
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
