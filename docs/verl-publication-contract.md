# Verl Player Research Publication Contract

Status: implemented shared contract

## Ownership

Verl publishes conclusions by completing the reviewed Sheet rows and requesting a release.
Draftside mechanically converts those final cells into the runtime object, validates identity and
shape, stores one atomic publication, emits non-authoritative warnings, and presents the result.
Verl does not construct JSON. Software never derives a role from Sheet cells, changes Verl's role,
manufactures a midpoint, or feeds research into `pickNowScore`.

`player_key` is `espn:<signed integer>`. The exact `espn:-1` ESPN sentinel is invalid; legitimate
signed D/ST IDs remain valid.

## Research profile v2

Every published player has the shared profile below plus a small position-specific findings object.

| Field group | Required meaning |
| --- | --- |
| Identity | `profileId`, `researchRunId`, `position` |
| Conclusion | `researchedRole`, `researchState`, `taxonomyState`, `publicationStatus` |
| Draft display | headline plus current-role, opportunity, competition, availability, and draft-implication summaries |
| Contingency | a distinct future `researchedRole`, named trigger, and summary; never blended into the present role |
| Judgment | confidence and reason, alternatives considered, unresolved questions |
| Evidence | supporting/contradicting observation IDs and direct HTTPS source URLs |
| Findings | the position's structured core plus open-ended `additionalFindings` |
| Freshness | evidence cutoff, researched, classified, optional review-exception expiration, and `classifiedBy` |

No row means **unresearched**. A row that could not reach a definitive answer uses one of these
research states: `insufficient-evidence`, `conflicting-evidence`, or `stale`. Put the useful
explanation in `unresolvedQuestions`; `role-unknown` is not a role.

The normal publishable state is:

- `researchState = complete`;
- `taxonomyState = matched`;
- a valid position role; and
- `publicationStatus = published`.

An uncertain or exceptional conclusion uses `publicationStatus = needs-review`. When evidence
supports a role the vocabulary cannot express, use `researchedRole = taxonomy-gap` and
`taxonomyState = taxonomy-gap`; explain the proposed concept in the prose and additional findings.

## Minimal structured core

Ranges contain only `low` and `high`; omit a range when evidence does not support one.

| Position | Structured findings |
| --- | --- |
| QB | Week 1 start-probability range, designed-rush range, pass-attempt range, starter leash, competition status |
| RB | carry-share range, target-share range, route-share range, goal-line role, backfield rank, handcuff type, competition status |
| WR | team target rank, target-share range, route-share range, red-zone role, competition status |
| TE | route-share range, target-share range, TE-room rank, team target rank, red-zone role, blocking load |
| K | job-security range and competition status |
| D/ST | pressure, sack, takeaway, points-prevention, and Week 1 matchup percentiles |

Unknown or novel useful answers belong in `additionalFindings`; they do not require a new column or
application release before Verl can preserve them.

## Team closure

A publication includes a `TeamResearchSnapshotV1` for each team it covers. It carries the research
run ID and team-level offense scoring band. Team-relative ranks must not be treated as ready before
that team's snapshot is complete. A complete snapshot lists every covered player key. This allows
Draftside to warn about missing profiles and impossible team-level share floors without
reclassifying anyone.

## Atomic publication

The Draftside publisher builds one `ResearchPublicationV1` object from final Sheet rows:

- publication schema `1`;
- profile schema `2`;
- role vocabulary `2026.3`;
- rubric `2026.1-draft` (or `null`);
- publication identity, author, and timestamp;
- team snapshots; and
- one unique profile per ESPN player key.

Verl triggers the release by setting a new request ID, timestamp, and actor in `Publish Control`,
then setting `request_state` to `REQUESTED` last. The automatic Apps Script trigger and the manual
**Draftside → Publish research now** menu item invoke the same importer.

The local operator fallback is:

```bash
DRAFTSIDE_PUBLISH_TRIGGER_TOKEN='<secret>' python scripts/trigger_research_publish.py \
  --spreadsheet-id '<sheet-id>' \
  --account '<google-account>' \
  --requested-by 'Fred/manual' \
  --publisher-url https://publisher.example/api/research/publish
```

The importer copies exact fields and parses declared JSON, lists, booleans, numbers, and ranges. It
does not infer missing values, normalize unsupported labels, or classify players. The signing relay
holds the Worker secret; Apps Script and Verl hold only the narrower trigger capability. The Worker
verifies a research-specific HMAC, validates the whole batch, matches profiles to the pinned ESPN
catalog, and commits all or none. A failed batch preserves the last valid publication. An identical
replay is idempotent; reusing a publication ID with different content is a conflict.

Invalid identity, unknown fields, invalid bounds, and malformed timestamps reject the whole batch.
Warnings can flag staleness, incomplete team closure, taxonomy gaps, needs-review rows,
overallocated share floors, research-run mismatches, or a definite role/metric contradiction.
Warnings never rewrite Verl's answer.

## Sheet-only workflow fields

The Sheet separates `workflow_status` (`working`, `superseded`) from deployable
`publication_status` (`needs-review`, `published`). Clear `workflow_status` when a current row is
final; use `working` only while drafting and `superseded` only for retained history. The importer
rejects deployable rows still marked `working` and ignores superseded rows. Profile `player_name`,
Team Snapshot `team_context_json`, and verification metadata are research conveniences and never
enter the runtime contract. The read-only Sheet contract check rejects header or vocabulary drift
before publication.
