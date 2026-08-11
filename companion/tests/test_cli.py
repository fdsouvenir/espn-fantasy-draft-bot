from pathlib import Path

from draft_companion.cli import main


def test_cli_rejects_missing_config(capsys, tmp_path: Path):
    assert main(["--config", str(tmp_path / "missing.toml"), "status"]) == 2
    assert '"ok": false' in capsys.readouterr().out
