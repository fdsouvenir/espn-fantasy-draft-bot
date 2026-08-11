from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from .cdp import discover_chrome, list_tabs
from .config import Config, load_config
from .credentials import load_credentials
from .runtime import Companion, atomic_json, ensure_chrome, load_initializer, process_alive
from .worker import WorkerClient


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
        "initializer": "valid",
        "credentials": "available",
        "backend": "healthy",
        "stateDirectory": str(config.runtime.state_directory),
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
    parser.add_argument("--config", type=Path, default=Path("companion.toml"))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("preflight")
    sub.add_parser("start")
    sub.add_parser("run")
    sub.add_parser("status")
    sub.add_parser("stop")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}))
        return 2
    try:
        if args.command == "preflight":
            result = preflight(config)
        elif args.command == "status":
            result = _status(config)
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
