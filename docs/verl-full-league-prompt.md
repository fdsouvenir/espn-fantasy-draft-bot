# Verl full-league research prompt

Copy everything inside the code block to Verl.

```text
Complete the full 2026 Draftside research pass for all 32 NFL teams in the working Google Sheet:
https://docs.google.com/spreadsheets/d/1sOvP2Nyo6SF9L9xK0Mw0VwAt9-8egbF7fwIfPcudqKI/edit

Use the current contract and workflow from GitHub branch fix/companion-runtime-dashboard-url:
https://github.com/fdsouvenir/espn-fantasy-draft-bot/blob/fix/companion-runtime-dashboard-url/docs/verl-research-workflow.md
https://github.com/fdsouvenir/espn-fantasy-draft-bot/blob/fix/companion-runtime-dashboard-url/docs/verl-publication-contract.md
https://github.com/fdsouvenir/espn-fantasy-draft-bot/blob/fix/companion-runtime-dashboard-url/config/research-vocabulary.json

Objective:
- Complete the documented four-pass workflow for every NFL team.
- Research the 29 untouched teams.
- Refresh CLE, JAX, and NE from new evidence; do not treat the pilot results as current enough for the full release.
- Produce useful present-role conclusions without inventing unsupported values.
- Trigger Draftside's Sheet importer when the league pass is complete. Do not create publication JSON yourself.

Immediate release-blocker repair:
- Before the full pass, review the currently unsupported controlled values reported by the importer.
- QB competition_status must be exactly settled, leaning, open, or unknown. Current invalid values include "depth competition" and "closed-fragile".
- WR competition_status must be exactly settled, leaning, open, or unknown. Current invalid value: "active hierarchy".
- TE blocking_load must be exactly heavy, balanced, light, or unknown. Current invalid value: "medium".
- Choose replacements from the underlying evidence. Do not use a blind text substitution.
- Tell Fred when these pilot rows are repaired so the local War Room rehearsal can continue.

Per-team requirements:
1. Select three eligible camp-attending primary reporters with the approved deterministic rubric. Preserve hard-gate evidence and scoring rationale.
2. Declare a fresh evidence window and enumerate the accessible material for all three selected reporters plus official transactions, injuries, depth charts, and team announcements.
3. Append every candidate item to Research Inbox and every accepted item to Observations. Preserve rejected and duplicate records; do not overwrite append-only history.
4. Synthesize the complete team packet before classifying any player.
5. Cover every fantasy-relevant QB, RB, WR, TE, K, and D/ST or name the player explicitly as a coverage gap.
6. Close one complete Team Snapshot with the same research_run_id used by the team's current profiles.
7. Use only player-relevant supporting observation IDs and direct source URLs.
8. Leave unsupported ranges blank. Do not create midpoints or translate prose into numbers.
9. Use publication_status=published only when the evidence gate passes. Use needs-review for genuine uncertainty, conflicts, taxonomy gaps, or consequential availability questions.

Mandatory CLE/JAX/NE refresh:
- Create new research_run_id values and new evidence cutoffs for all three teams.
- Recheck current injuries, transactions, depth decisions, practice usage, and official announcements.
- Append new Inbox and Observation rows; preserve the pilot history.
- Create current synthesis, Team Snapshot, and profile conclusions from the refreshed evidence.
- Mark the prior pilot profile rows superseded after their replacements are complete so duplicate player keys cannot enter publication.
- Revisit Brian Thomas Jr., TreVeyon Henderson, Travis Hunter, Michael Burton, and the unresolved JAX backfield explicitly.

Final-row rules:
- Use workflow_status=working only while drafting.
- Clear workflow_status when a current row is final.
- Use workflow_status=superseded only for retained historical profile rows.
- Use only exact vocabulary values from config/research-vocabulary.json.
- Do not silently normalize a value that fails the contract; correct the Sheet conclusion or preserve the uncertainty.

Release request:
- Complete the league audit and resolve or explicitly retain every exception.
- In Publish Control, write a new unique request_id, current UTC requested_at, and requested_by=Verl.
- Set request_state=REQUESTED last, after every other Sheet write is complete.
- Do not construct JSON, sign a payload, or call the Worker directly.
- If the request fails, read last_error, correct only the identified Sheet problems, create a new request_id, and request again.

Final report to Fred:
- Evidence window by team.
- Selected reporters and enumerated-item counts.
- Inbox, Observation, Synthesis, Snapshot, and profile totals.
- Published and needs-review totals by position.
- Taxonomy gaps, access gaps, stale data, and unresolved consequential questions.
- CLE/JAX/NE refresh results, including whether the JAX RB room now supports an actual-starter or committee classification.
- Publish Control request_id, final state, publication ID, profile count, warning count, and any rejected rows.
```
