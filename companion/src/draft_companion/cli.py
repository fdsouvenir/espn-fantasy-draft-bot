from __future__ import annotations

import argparse
import getpass
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import time
import webbrowser
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode

from . import __version__
from .cdp import discover_chrome, list_tabs
from .config import Config, SetupRequiredError, load_config
from .credentials import load_credentials, load_or_create_device, store_credentials
from .runtime import Companion, atomic_json, ensure_chrome, load_initializer, process_alive
from .worker import DeviceWorkerClient, WorkerClient


def _pid(config: Config) -> int | None:
    try:
        return int(config.pid_file.read_text(encoding="ascii").strip())
    except (FileNotFoundError, ValueError):
        return None


def _status(config: Config) -> dict[str, object]:
    pid = _pid(config)
    alive = bool(pid and process_alive(pid))
    try:
        health = json.loads(config.health_file.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        health = {"state": "not_started"}
    fresh = False
    try:
        updated = datetime.fromisoformat(str(health["updatedAt"]))
        fresh = (datetime.now(UTC) - updated).total_seconds() <= config.runtime.health_stale_seconds
    except (KeyError, TypeError, ValueError):
        pass
    return {
        **health,
        "running": alive,
        "pid": pid if alive else None,
        "fresh": fresh,
        "checkpoint": str(config.checkpoint_file),
        "evidence": str(config.evidence_file),
    }


def preflight(
    config: Config, *, credential_loader=load_credentials, worker_factory=WorkerClient
) -> dict[str, object]:
    if config.runtime.credential_source == "device":
        device = load_or_create_device(config.runtime.keyring_service)
        worker = DeviceWorkerClient(
            config.worker_base, device, config.runtime.request_timeout_seconds
        )
        bootstrap = worker.enroll(platform.node() or "Draft laptop", __version__)
        initializer = f"automatic:{bootstrap['draftKey']}"
        credential_status = "device_enrolled"
    else:
        if config.init_file is None or config.draft_key is None:
            raise ValueError("legacy credentials require draft_key and init_file")
        load_initializer(config.init_file, config.draft_key)
        credentials = credential_loader(
            config.runtime.credential_source, config.runtime.keyring_service
        )
        worker = worker_factory(
            config.worker_base,
            config.draft_key,
            credentials,
            config.runtime.request_timeout_seconds,
        )
        worker.health()
        initializer = "valid"
        credential_status = "available"
    executable = discover_chrome(config.chrome.executable)
    config.runtime.state_directory.mkdir(parents=True, exist_ok=True)
    os.chmod(config.runtime.state_directory, 0o700)
    cdp = "ready"
    try:
        list_tabs(config.chrome.debug_port)
    except Exception:
        cdp = "will_launch" if config.chrome.launch else "unavailable"
    if cdp == "unavailable":
        raise RuntimeError("Chrome CDP is unavailable and launch=false")
    return {
        "ok": True,
        "chrome": Path(executable).name,
        "cdp": cdp,
        "initializer": initializer,
        "credentials": credential_status,
        "backend": "healthy",
        "stateDirectory": str(config.runtime.state_directory),
    }


def configure(
    config_path: Path,
    *,
    worker_base: str,
    draft_key: str,
    initializer: Path,
    draft_url: str,
    force: bool,
    secret_reader=getpass.getpass,
    credential_storer=store_credentials,
) -> dict[str, object]:
    config_path = config_path.expanduser().resolve()
    initializer = initializer.expanduser().resolve()
    load_initializer(initializer, draft_key)
    if config_path.exists() and not force:
        existing = config_path.read_text(encoding="utf-8")
        if "REPLACE_ME" not in existing and "example.com" not in existing:
            raise FileExistsError("configuration already exists; use --force to replace routing")
    config_parent_created = not config_path.parent.exists()
    config_path.parent.mkdir(parents=True, exist_ok=True)
    if config_parent_created:
        os.chmod(config_path.parent, 0o700)
    state_home = Path(os.environ.get("XDG_STATE_HOME", "~/.local/state")).expanduser()
    data_home = Path(os.environ.get("XDG_DATA_HOME", "~/.local/share")).expanduser()
    state_directory = state_home / "draftside-companion"
    profile_directory = data_home / "draftside-companion/chrome-profile"
    installed_initializer = config_path.parent / "draft-init.json"
    routing = "\n".join(
        [
            "config_version = 1",
            "dashboard_configured_by_user = true",
            f"worker_base = {json.dumps(worker_base)}",
            f"draft_key = {json.dumps(draft_key)}",
            f"init_file = {json.dumps(str(installed_initializer))}",
            f"draft_url = {json.dumps(draft_url)}",
            "",
            "[chrome]",
            'executable = ""',
            f"profile_directory = {json.dumps(str(profile_directory))}",
            'start_url = "https://www.espn.com/fantasy/football/"',
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
            'credential_source = "keyring"',
            'keyring_service = "draftside-companion"',
            "",
        ]
    )
    temporary = config_path.with_name(f".{config_path.name}.{os.getpid()}.tmp")
    temporary_initializer = installed_initializer.with_name(
        f".{installed_initializer.name}.{os.getpid()}.tmp"
    )
    try:
        temporary.write_text(routing, encoding="utf-8")
        os.chmod(temporary, 0o600)
        shutil.copyfile(initializer, temporary_initializer)
        os.chmod(temporary_initializer, 0o600)
        load_config(temporary)
        values = {
            "INGEST_HMAC_CURRENT": secret_reader("Ingest signing key: "),
            "CF_ACCESS_CLIENT_ID": secret_reader("Cloudflare Access client ID: "),
            "CF_ACCESS_CLIENT_SECRET": secret_reader("Cloudflare Access client secret: "),
        }
        credential_storer("draftside-companion", values)
        state_directory.mkdir(parents=True, exist_ok=True)
        profile_directory.mkdir(parents=True, exist_ok=True)
        os.chmod(state_directory, 0o700)
        os.chmod(profile_directory.parent, 0o700)
        os.chmod(profile_directory, 0o700)
        os.replace(temporary_initializer, installed_initializer)
        os.replace(temporary, config_path)
    finally:
        for staged_path in (temporary, temporary_initializer):
            try:
                staged_path.unlink()
            except FileNotFoundError:
                pass
    return {
        "ok": True,
        "config": str(config_path),
        "initializer": str(installed_initializer),
        "credentials": "stored_in_keyring",
    }


def run_foreground(config: Config) -> int:
    ensure_chrome(config)
    config.runtime.state_directory.mkdir(parents=True, exist_ok=True)
    os.chmod(config.runtime.state_directory, 0o700)
    atomic_json(config.pid_file.with_suffix(".json"), {"pid": os.getpid()})
    config.pid_file.write_text(str(os.getpid()), encoding="ascii")
    os.chmod(config.pid_file, 0o600)
    try:
        Companion(config).run()
        return 0
    finally:
        try:
            config.pid_file.unlink()
        except FileNotFoundError:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="draft-companion", description="Read-only ESPN draft laptop companion"
    )
    default_config = Path(
        os.environ.get(
            "DRAFTSIDE_CONFIG",
            "~/.config/draftside-companion/companion.toml",
        )
    ).expanduser()
    parser.add_argument("--config", type=Path, default=default_config)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("preflight")
    sub.add_parser("start")
    sub.add_parser("run")
    sub.add_parser("status")
    sub.add_parser("stop")
    setup = sub.add_parser("configure")
    setup.add_argument("--worker-base", required=True)
    setup.add_argument("--draft-key", required=True)
    setup.add_argument("--initializer", required=True, type=Path)
    setup.add_argument("--draft-url", default="https://fantasy.espn.com/football/draft")
    setup.add_argument("--force", action="store_true")
    dashboard = sub.add_parser("dashboard")
    dashboard.add_argument("--open", action="store_true", dest="open_browser")
    args = parser.parse_args(argv)
    if args.command == "configure":
        try:
            result = configure(
                args.config,
                worker_base=args.worker_base,
                draft_key=args.draft_key,
                initializer=args.initializer,
                draft_url=args.draft_url,
                force=args.force,
            )
            print(json.dumps(result, sort_keys=True))
            return 0
        except Exception as error:
            print(json.dumps({"ok": False, "error": str(error)}))
            return 1
    try:
        config = load_config(args.config)
    except SetupRequiredError as error:
        if args.command in {"run", "status"}:
            print(json.dumps({"ok": True, "state": "setup_required", "message": str(error)}))
            return 0
        print(json.dumps({"ok": False, "error": str(error)}))
        return 2
    except FileNotFoundError as error:
        if args.command in {"run", "status"}:
            print(
                json.dumps(
                    {
                        "ok": True,
                        "state": "setup_required",
                        "message": "enter the private dashboard URL in Draftside Companion",
                    }
                )
            )
            return 0
        print(json.dumps({"ok": False, "error": str(error)}))
        return 2
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 2
    try:
        if args.command == "preflight":
            result = preflight(config)
        elif args.command == "status":
            result = _status(config)
        elif args.command == "dashboard":
            try:
                health = json.loads(config.health_file.read_text(encoding="utf-8"))
            except (FileNotFoundError, ValueError):
                health = {}
            enrolled_url = health.get("dashboardUrl") if isinstance(health, dict) else None
            url = (
                enrolled_url
                if isinstance(enrolled_url, str) and enrolled_url.startswith("https://")
                else (
                    f"{config.worker_base}/?{urlencode({'draft': config.draft_key})}"
                    if config.draft_key
                    else config.worker_base
                )
            )
            if args.open_browser and not webbrowser.open(url):
                raise RuntimeError("dashboard could not be opened")
            result = {"ok": True, "opened": args.open_browser, "url": url}
        elif args.command == "run":
            return run_foreground(config)
        elif args.command == "start":
            existing = _pid(config)
            if existing and process_alive(existing):
                raise RuntimeError("companion is already running")
            preflight(config)
            with open(config.runtime.state_directory / "companion.log", "ab", buffering=0) as log:
                kwargs = {
                    "stdin": subprocess.DEVNULL,
                    "stdout": log,
                    "stderr": log,
                    "start_new_session": True,
                }
                if os.name == "nt":
                    kwargs = {
                        **kwargs,
                        "creationflags": subprocess.DETACHED_PROCESS
                        | subprocess.CREATE_NEW_PROCESS_GROUP,
                        "start_new_session": False,
                    }
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "draft_companion.cli",
                        "--config",
                        str(args.config.resolve()),
                        "run",
                    ],
                    **kwargs,
                )
            result = {"ok": True, "state": "starting", "pid": process.pid}
        else:
            pid = _pid(config)
            if not pid or not process_alive(pid):
                result = {"ok": True, "state": "not_running"}
            else:
                os.kill(pid, signal.SIGTERM)
                deadline = time.time() + 10
                while process_alive(pid) and time.time() < deadline:
                    time.sleep(0.1)
                result = {
                    "ok": True,
                    "state": "stopped" if not process_alive(pid) else "stop_pending",
                }
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
