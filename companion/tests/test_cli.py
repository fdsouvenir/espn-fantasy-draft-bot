import os
from pathlib import Path

from draft_companion.cli import configure, main


def test_cli_rejects_missing_config(capsys, tmp_path: Path):
    assert main(["--config", str(tmp_path / "missing.toml"), "status"]) == 2
    assert '"ok": false' in capsys.readouterr().out


def test_dashboard_url_encodes_draft_key(capsys, tmp_path: Path):
    config = tmp_path / "companion.toml"
    initializer = tmp_path / "draft-init.json"
    initializer.write_text("{}")
    config.write_text(
        f'''worker_base = "https://draftside.example.com"
draft_key = "season:league:Fred's team"
    init_file = "{initializer.as_posix()}"
draft_url = "https://fantasy.espn.com/football/draft"

[chrome]
    profile_directory = "{(tmp_path / "chrome").as_posix()}"

[runtime]
    state_directory = "{(tmp_path / "state").as_posix()}"
'''
    )

    assert main(["--config", str(config), "dashboard"]) == 0
    assert (
        '"url": "https://draftside.example.com/?draft=season%3Aleague%3AFred%27s+team"'
        in capsys.readouterr().out
    )


def test_configure_installs_owner_only_routing_initializer_and_keyring_values(
    tmp_path: Path, monkeypatch
):
    config_path = tmp_path / "config/draftside-companion/companion.toml"
    initializer = tmp_path / "source-init.json"
    initializer.write_text(
        '{"schemaVersion":1,"draftKey":"draft:test","draftSlotTeamIds":["1","2"],'
        '"expectedTeams":2,"totalPickSlots":2}'
    )
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    supplied = iter(["h" * 32, "client", "secret"])
    stored = {}

    result = configure(
        config_path,
        worker_base="https://draftside.example.com",
        draft_key="draft:test",
        initializer=initializer,
        draft_url="https://fantasy.espn.com/football/draft",
        force=False,
        secret_reader=lambda _prompt: next(supplied),
        credential_storer=lambda service, values: stored.update({"service": service, **values}),
    )

    assert result["credentials"] == "stored_in_keyring"
    if os.name != "nt":
        assert config_path.stat().st_mode & 0o077 == 0
        assert (config_path.parent / "draft-init.json").stat().st_mode & 0o077 == 0
    assert "secret" not in config_path.read_text()
    assert stored == {
        "service": "draftside-companion",
        "INGEST_HMAC_CURRENT": "h" * 32,
        "CF_ACCESS_CLIENT_ID": "client",
        "CF_ACCESS_CLIENT_SECRET": "secret",
    }


def test_configure_does_not_publish_files_when_keyring_storage_fails(tmp_path: Path):
    config_path = tmp_path / "config/draftside-companion/companion.toml"
    initializer = tmp_path / "source-init.json"
    initializer.write_text(
        '{"schemaVersion":1,"draftKey":"draft:test","draftSlotTeamIds":["1","2"],'
        '"expectedTeams":2,"totalPickSlots":2}'
    )

    def fail_storage(_service, _values):
        raise RuntimeError("keyring unavailable")

    supplied = iter(["h" * 32, "client", "secret"])
    try:
        configure(
            config_path,
            worker_base="https://draftside.example.com",
            draft_key="draft:test",
            initializer=initializer,
            draft_url="https://fantasy.espn.com/football/draft",
            force=False,
            secret_reader=lambda _prompt: next(supplied),
            credential_storer=fail_storage,
        )
    except RuntimeError as error:
        assert str(error) == "keyring unavailable"
    else:
        raise AssertionError("configuration unexpectedly succeeded")

    assert not config_path.exists()
    assert not (config_path.parent / "draft-init.json").exists()
