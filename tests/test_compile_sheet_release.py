import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "compile_sheet_release.py"
SPEC = importlib.util.spec_from_file_location("compile_sheet_release", SCRIPT)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)

NOW = "2026-08-11T12:00:00Z"
FUTURE = "2026-08-20T00:00:00Z"


def base_catalog():
    catalog = [
        {"playerId": "100", "name": "Running Back", "position": "RB", "nflTeam": "ATL",
         "tier": "T2", "roleClass": "RB1", "opportunityScore": 100.0,
         "intrinsicScore": 84.0, "pickNowScore": 86.4, "returnProbability": None,
         "reasons": ["Base"], "risks": []},
        {"playerId": "200", "name": "Receiver", "position": "WR", "nflTeam": "BUF",
         "tier": "T3", "roleClass": "WR2", "opportunityScore": 50.0,
         "intrinsicScore": 75.0, "pickNowScore": 71.25, "returnProbability": None,
         "reasons": [], "risks": []},
        {"playerId": "-16034", "name": "Detroit D/ST", "position": "D/ST", "nflTeam": "DET",
         "tier": "T12", "roleClass": "D/ST", "opportunityScore": 0.0,
         "intrinsicScore": 20.0, "pickNowScore": 17.0, "returnProbability": None,
         "reasons": [], "risks": []},
    ]
    return {"schemaVersion": 1, "catalogVersion": "espn-test", "catalogSha256": module.digest(catalog),
            "catalog": catalog, "provenance": {"provider": "fixture"}}


def export(role_rows=None, tier_rows=None):
    return {"spreadsheetId": "sheet-test", "tabs": {
        module.ROLE_TAB: role_rows or [], module.TIER_TAB: tier_rows or [],
    }}


def role(player="espn:100", **changes):
    value = {"editorial_row_id": "role-1", "player_key": player,
             "role_class": "lead-committee", "override_reason": "Reviewed workload",
             "expires_at": FUTURE}
    value.update(changes)
    return value


def tier(player="espn:100", **changes):
    value = {"player_key": player, "position": "RB", "tier": "RB-A",
             "target_flag": "target", "target_adjustment": "2.5",
             "reason": "Tier break", "expires_at": FUTURE}
    value.update(changes)
    return value


class SheetReleaseTests(unittest.TestCase):
    def compile(self, sheet):
        return module.compile_release(base_catalog(), sheet, generated_at=NOW)

    def test_applies_role_workload_tier_and_bounded_adjustment(self):
        release = self.compile(export(
            [role(snap_share_low="0.40", snap_share_mid="0.50", snap_share_high="0.60",
                  carry_share_mid="0.55")], [tier()],
        ))
        player = next(item for item in release["catalog"] if item["playerId"] == "100")
        self.assertEqual(player["roleClass"], "lead-committee")
        self.assertEqual(player["tier"], "RB-A")
        # .20 * .50 + .30 * .55, with absent fields neither inferred nor normalized.
        self.assertEqual(player["opportunityScore"], 26.5)
        self.assertEqual(player["editorialOpportunityEvidenceCoverage"], .5)
        self.assertEqual(player["pickNowScore"], 77.88)
        self.assertEqual(player["targetAdjustment"], 2.5)
        self.assertIn("Editorial role", player["reasons"][1])
        self.assertEqual(release["provenance"]["editorialRelease"]["roleOverrideCount"], 1)

    def test_negative_dst_key_is_valid_and_preserved(self):
        release = self.compile(export(
            [role("espn:-16034", editorial_row_id="dst", role_class="specialist")],
            [tier("espn:-16034", position="D/ST", tier="DST-1", target_adjustment="0")],
        ))
        player = next(item for item in release["catalog"] if item["playerId"] == "-16034")
        self.assertEqual(player["tier"], "DST-1")
        self.assertEqual(player["roleClass"], "specialist")

    def test_dst_rejects_offensive_workload(self):
        with self.assertRaisesRegex(module.ReleaseError, "unsupported for D/ST"):
            self.compile(export([role("espn:-16034", editorial_row_id="dst", snap_share_mid="0.5")]))

    def test_expired_row_fails_closed(self):
        with self.assertRaisesRegex(module.ReleaseError, "expired"):
            self.compile(export([role(expires_at="2026-08-01T00:00:00Z")]))

    def test_unknown_and_duplicate_players_fail_closed(self):
        with self.assertRaisesRegex(module.ReleaseError, "unknown player"):
            self.compile(export([role("espn:999")]))
        with self.assertRaisesRegex(module.ReleaseError, "duplicate role override"):
            self.compile(export([role(), role(editorial_row_id="role-2")]))
        with self.assertRaisesRegex(module.ReleaseError, "duplicate tier/flag"):
            self.compile(export([], [tier(), tier(reason="Second")]))

    def test_ranges_and_adjustment_bounds_fail_closed(self):
        with self.assertRaisesRegex(module.ReleaseError, "between 0 and 1"):
            self.compile(export([role(snap_share_mid="1.01")]))
        with self.assertRaisesRegex(module.ReleaseError, "low <= mid <= high"):
            self.compile(export([role(snap_share_low="0.8", snap_share_mid="0.5")]))
        with self.assertRaisesRegex(module.ReleaseError, "between -6 and 6"):
            self.compile(export([], [tier(target_adjustment="6.01")]))
        with self.assertRaisesRegex(module.ReleaseError, "guardrails"):
            self.compile(export([], [tier(do_not_take_before="50", do_not_pass_after="40")]))

    def test_unimplemented_editorial_signal_is_not_silently_ignored(self):
        with self.assertRaisesRegex(module.ReleaseError, "not implemented"):
            self.compile(export([role(contingent_probability="0.5")]))

    def test_output_is_deterministic_and_noop_keeps_catalog(self):
        first = self.compile(export())
        second = self.compile(export())
        self.assertEqual(first, second)
        self.assertEqual(first["catalog"], base_catalog()["catalog"])
        self.assertEqual(first["provenance"]["editorialRelease"]["roleOverrideCount"], 0)
        self.assertEqual(first["provenance"]["editorialRelease"]["tierFlagCount"], 0)

    def test_wrapped_gog_values_are_unwrapped_as_data(self):
        def wrapped(text, identity):
            return (f'<<<EXTERNAL_UNTRUSTED_CONTENT id="{identity}">>>\nSource: google_api\n---\n'
                    f'{text}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="{identity}">>>')
        values = [[wrapped("player_key", "a"), wrapped("position", "b"), wrapped("tier", "c"),
                   wrapped("target_flag", "d"), wrapped("target_adjustment", "e"),
                   wrapped("reason", "f"), wrapped("expires_at", "g")],
                  [wrapped("espn:200", "h"), "WR", "WR-A", "target", "1", "Review", FUTURE]]
        release = self.compile(export([], {"values": values}))
        player = next(item for item in release["catalog"] if item["playerId"] == "200")
        self.assertEqual(player["tier"], "WR-A")

    def test_gog_fetch_uses_readonly_no_input_and_no_shell(self):
        response = json.dumps({"values": []})
        with mock.patch.object(module.subprocess, "run", return_value=mock.Mock(stdout=response)) as run:
            result = module.fetch_sheet("operator@example.com", "sheet-id", "gog")
        self.assertEqual(run.call_count, 2)
        command = run.call_args_list[0].args[0]
        self.assertIn("--readonly", command)
        self.assertIn("--no-input", command)
        self.assertEqual(run.call_args_list[0].kwargs["check"], True)
        self.assertNotIn("shell", run.call_args_list[0].kwargs)
        self.assertEqual(result["spreadsheetId"], "sheet-id")

    def test_cli_failure_does_not_replace_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base = root / "base.json"
            sheet = root / "sheet.json"
            output = root / "release.json"
            base.write_text(json.dumps(base_catalog()), encoding="utf-8")
            sheet.write_text(json.dumps(export([role(expires_at="2020-01-01T00:00:00Z")])), encoding="utf-8")
            output.write_text("preserve", encoding="utf-8")
            with self.assertRaises(SystemExit):
                module.main(["--base", str(base), "--sheet-export", str(sheet),
                             "--output", str(output), "--now", NOW])
            self.assertEqual(output.read_text(encoding="utf-8"), "preserve")


if __name__ == "__main__":
    unittest.main()
