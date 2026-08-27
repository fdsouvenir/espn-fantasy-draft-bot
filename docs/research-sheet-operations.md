# Research Sheet Operations

The live Sheet is Verl's research database. These commands maintain identity and contract shape;
they do not compile conclusions or assign roles.

Working Sheet:
`1sOvP2Nyo6SF9L9xK0Mw0VwAt9-8egbF7fwIfPcudqKI`

## Refresh Player Directory

Build and freeze the current public ESPN catalog:

```bash
python scripts/build_catalog.py \
  --output catalogs/espn-2026.json
```

Project its canonical identities into Sheet rows:

```bash
python scripts/export_player_directory.py \
  --catalog catalogs/espn-2026.json \
  --output sheet-exports/player-directory.json
```

The projection contains all supported catalog players. `active = true` means the player currently
belongs to an NFL team; free agents remain addressable but inactive. `notes` records the exact
catalog version. Draftside owns this import, and Verl must never substitute a name for
`player_key = espn:<signed id>`.

Use `gog sheets update` to replace `Player Directory!A1:J...` with the generated 2-D values array.
Clear stale rows from an older, longer import after verifying the new row count. This operation is
an identity refresh, not research publication.

## Check contract drift

Run before every pilot or signed publication:

```bash
python scripts/check_research_sheet_contract.py \
  --spreadsheet-id 1sOvP2Nyo6SF9L9xK0Mw0VwAt9-8egbF7fwIfPcudqKI \
  --account fdsouvenir@gmail.com
```

The check invokes `gog` in read-only mode. It compares profile headers, Team Snapshot and Player
Directory headers, all research-workflow headers, role vocabulary, workflow statuses, and
publication statuses with `config/research-vocabulary.json`. A mismatch exits nonzero. It never
reads evidence prose to make a decision and never creates publication JSON.

## Three-team pilot

The pilot is scoped research, not a shortcut to a full release. Populate only the three selected
teams and set each `Research Runs.research_scope` to the case it covers. The full-league rows in
`Publication Review` must remain `NEEDS WORK` until all 32 teams are genuinely complete. A pilot
publication may contain only the three completed team snapshots and their covered player profiles.

Keep any generated pilot publication under the ignored `artifacts/` directory. Contract checking
is read-only, and publication remains a separate, explicit operator action after human review.

`Source Registry.weighted_score` is a Sheet formula implementing the approved `2026.1` source
rubric. Verl supplies the four evidence-backed 0–5 component scores; the Sheet performs only the
published arithmetic and does not judge source quality or player roles.

## Column ownership

These profile columns are Sheet-only: `player_name` and `workflow_status`. The workflow status is
either `working` or `superseded`; those rows do not enter publication JSON.

These Team Snapshot columns are Sheet-only: `team_context_json`, `verified_at`, and `verified_by`.
They support research review but do not enter the Worker. `coverage_notes` maps to runtime `notes`.

These provenance fields are publishable and required: profile `research_run_id`, profile
`evidence_cutoff_at`, and Team Snapshot `research_run_id`. The profile and team run IDs should
match; a mismatch produces an audit warning.

Only `needs-review` and `published` are deployable publication statuses. A published profile must
also have complete research, matched taxonomy, and an approved role. `working` and `superseded` are
deliberately not accepted by the Worker.

`offense_scoring_band` belongs only to Team Snapshots. RB target allocation includes receiving-back
`target_share`; WR, TE, and RB target-share floors are audited together when the team closes.
