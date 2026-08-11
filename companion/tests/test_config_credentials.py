from __future__ import annotations

import os
from pathlib import Path

import pytest

from draft_companion.config import (
    DEFAULT_ESPN_START_URL,
    SetupRequiredError,
    dashboard_candidate,
    dashboard_setup_required,
    load_config,
    write_device_config,
)
from draft_companion.credentials import (
    Credentials,
    load_credentials,
    load_or_create_device,
    store_credentials,
)


def write_config(
    tmp_path: Path, *, worker: str = "https://worker.example.com", source: str = "environment"
) -> Path:
    path = tmp_path / "companion.toml"
    path.write_text(f'''dashboard_configured_by_user = true
worker_base = "{worker}"
draft_key = "draft:test"
init_file = "init.json"
draft_url = "https://fantasy.espn.com/football/draft"
[chrome]
profile_directory = "profile"
debug_port = 9222
[runtime]
state_directory = "state"
credential_source = "{source}"
''')
    return path


def test_config_resolves_relative_paths(tmp_path: Path):
    config = load_config(write_config(tmp_path))
    assert config.init_file == tmp_path / "init.json"
    assert config.chrome.profile_directory == tmp_path / "profile"
    assert config.runtime.state_directory == tmp_path / "state"


def test_config_rejects_non_https_worker(tmp_path: Path):
    with pytest.raises(ValueError, match="https"):
        load_config(write_config(tmp_path, worker="http://worker.example.com"))


@pytest.mark.parametrize(
    "worker",
    [
        "https://worker.example.com/api",
        "https://worker.example.com?token=nope",
        "https://user:secret@worker.example.com",
    ],
)
def test_config_rejects_worker_urls_with_embedded_coordinates(tmp_path: Path, worker: str):
    with pytest.raises(ValueError, match="https URL"):
        load_config(write_config(tmp_path, worker=worker))


def test_config_rejects_non_espn_draft_url(tmp_path: Path):
    path = write_config(tmp_path)
    path.write_text(
        path.read_text().replace(
            "https://fantasy.espn.com/football/draft", "https://example.com/football/draft"
        )
    )
    with pytest.raises(ValueError, match="ESPN"):
        load_config(path)


def test_auto_config_needs_only_private_endpoint_and_local_paths(tmp_path: Path):
    path = tmp_path / "companion.toml"
    path.write_text(
        f'''dashboard_configured_by_user = true
worker_base = "https://draftside.example.com"
[chrome]
profile_directory = "{(tmp_path / "profile").as_posix()}"
[runtime]
state_directory = "{(tmp_path / "state").as_posix()}"
credential_source = "device"
'''
    )

    config = load_config(path)
    assert config.draft_key is None
    assert config.init_file is None
    assert config.draft_url == "https://fantasy.espn.com/football/draft"
    assert config.chrome.start_url == DEFAULT_ESPN_START_URL


def test_legacy_config_requires_user_confirmation(tmp_path: Path):
    path = tmp_path / "companion.toml"
    path.write_text(
        f'''worker_base = "https://old-build.example.com"
[chrome]
profile_directory = "{(tmp_path / "profile").as_posix()}"
[runtime]
state_directory = "{(tmp_path / "state").as_posix()}"
credential_source = "keyring"
'''
    )

    assert dashboard_setup_required(path)
    assert dashboard_candidate(path) == "https://old-build.example.com"
    with pytest.raises(SetupRequiredError, match="confirm"):
        load_config(path)


def test_user_dashboard_config_is_saved_owner_only(tmp_path: Path, monkeypatch):
    config_path = tmp_path / "config/draftside-companion/companion.toml"
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))

    assert write_device_config(config_path, " https://private.example.com/ ") == (
        "https://private.example.com"
    )

    config = load_config(config_path)
    assert config.worker_base == "https://private.example.com"
    assert config.chrome.start_url == DEFAULT_ESPN_START_URL
    assert config.runtime.credential_source == "device"
    assert not dashboard_setup_required(config_path)
    if os.name != "nt":
        assert config_path.stat().st_mode & 0o077 == 0


def test_confirming_upgrade_keeps_a_backup(tmp_path: Path, monkeypatch):
    config_path = tmp_path / "config/draftside-companion/companion.toml"
    config_path.parent.mkdir(parents=True)
    config_path.write_text('worker_base = "https://old-build.example.com"\n')
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))

    write_device_config(config_path, "https://user-entered.example.com")

    backup = config_path.with_name("companion.toml.pre-0.3.0")
    assert "old-build.example.com" in backup.read_text()
    assert load_config(config_path).worker_base == "https://user-entered.example.com"


def test_environment_credentials_are_loaded_without_transformation():
    env = {
        "INGEST_HMAC_CURRENT": "h" * 32,
        "CF_ACCESS_CLIENT_ID": "id",
        "CF_ACCESS_CLIENT_SECRET": "secret",
    }
    credentials = load_credentials("environment", "unused", environ=env)
    assert credentials.ingest_hmac == "h" * 32
    assert credentials.access_client_id == "id"


def test_missing_credentials_reports_names_not_values():
    with pytest.raises(RuntimeError) as raised:
        load_credentials("environment", "unused", environ={"INGEST_HMAC_CURRENT": "h" * 32})
    assert "CF_ACCESS_CLIENT_ID" in str(raised.value)
    assert "h" * 32 not in str(raised.value)


def test_keyring_abstraction_uses_fixed_nonsecret_usernames():
    class FakeKeyring:
        def __init__(self):
            self.calls = []

        def get_password(self, service, username):
            self.calls.append((service, username))
            return {
                "INGEST_HMAC_CURRENT": "x" * 32,
                "CF_ACCESS_CLIENT_ID": "id",
                "CF_ACCESS_CLIENT_SECRET": "secret",
            }[username]

    keyring = FakeKeyring()
    credentials = load_credentials("keyring", "draft-helper", keyring=keyring)
    assert credentials.access_client_secret == "secret"
    assert keyring.calls == [
        ("draft-helper", "INGEST_HMAC_CURRENT"),
        ("draft-helper", "CF_ACCESS_CLIENT_ID"),
        ("draft-helper", "CF_ACCESS_CLIENT_SECRET"),
    ]


def test_credentials_are_stored_under_expected_names():
    class Ring:
        def __init__(self):
            self.values = {}

        def get_password(self, service, username):
            return self.values.get((service, username))

        def set_password(self, service, username, password):
            self.values[(service, username)] = password

        def delete_password(self, service, username):
            self.values.pop((service, username), None)

    ring = Ring()
    result = store_credentials(
        "draftside-companion",
        {
            "INGEST_HMAC_CURRENT": "h" * 32,
            "CF_ACCESS_CLIENT_ID": "client",
            "CF_ACCESS_CLIENT_SECRET": "secret",
        },
        keyring=ring,
    )
    assert result == Credentials("h" * 32, "client", "secret")
    assert ring.values == {
        ("draftside-companion", "INGEST_HMAC_CURRENT"): "h" * 32,
        ("draftside-companion", "CF_ACCESS_CLIENT_ID"): "client",
        ("draftside-companion", "CF_ACCESS_CLIENT_SECRET"): "secret",
    }


@pytest.mark.parametrize("failure_number", [1, 2, 3])
def test_credential_storage_rolls_back_every_partial_failure(failure_number: int):
    class Ring:
        def __init__(self):
            self.values = {
                ("draftside-companion", name): f"old-{name}"
                for name in (
                    "INGEST_HMAC_CURRENT",
                    "CF_ACCESS_CLIENT_ID",
                    "CF_ACCESS_CLIENT_SECRET",
                )
            }
            self.calls = 0
            self.failed = False

        def get_password(self, service, username):
            return self.values.get((service, username))

        def set_password(self, service, username, password):
            self.calls += 1
            if self.calls == failure_number and not self.failed:
                self.failed = True
                raise RuntimeError("keyring unavailable")
            self.values[(service, username)] = password

        def delete_password(self, service, username):
            self.values.pop((service, username), None)

    ring = Ring()
    original = dict(ring.values)
    new_values = {
        "INGEST_HMAC_CURRENT": "h" * 32,
        "CF_ACCESS_CLIENT_ID": "client",
        "CF_ACCESS_CLIENT_SECRET": "secret",
    }
    with pytest.raises(RuntimeError, match="previous values were restored") as raised:
        store_credentials("draftside-companion", new_values, keyring=ring)
    assert ring.values == original
    assert all(value not in str(raised.value) for value in new_values.values())


def test_device_identity_is_created_once_and_reused():
    class Ring:
        def __init__(self):
            self.values = {}

        def get_password(self, service, username):
            return self.values.get((service, username))

        def set_password(self, service, username, password):
            self.values[(service, username)] = password

        def delete_password(self, service, username):
            self.values.pop((service, username), None)

    ring = Ring()
    first = load_or_create_device("draftside-companion", keyring=ring)
    second = load_or_create_device("draftside-companion", keyring=ring)

    assert first == second
    assert len(first.device_token) >= 32
    assert ring.values[("draftside-companion", "DEVICE_ID")] == first.device_id
    assert ring.values[("draftside-companion", "DEVICE_TOKEN")] == first.device_token


def test_incomplete_device_identity_fails_closed():
    class Ring:
        def get_password(self, _service, username):
            return "00000000-0000-4000-8000-000000000001" if username == "DEVICE_ID" else None

        def set_password(self, _service, _username, _password):
            raise AssertionError("must not write")

        def delete_password(self, _service, _username):
            raise AssertionError("must not delete")

    with pytest.raises(RuntimeError, match="incomplete"):
        load_or_create_device("draftside-companion", keyring=Ring())
