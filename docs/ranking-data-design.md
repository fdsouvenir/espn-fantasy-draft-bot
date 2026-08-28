# Draftside Research and Decision Data Design

Status: revised for agent-owned research and classification

## 1. Product boundary

Draftside should answer a different question from ESPN ADP: among the players still available, what
roles and opportunities actually remain, what would have to happen for contingent upside to become
real, and which conclusions are uncertain?

The system has three authorities:

- ESPN supplies player identity, draft state, market rank, projections, and public roster metadata.
- Verl supplies research conclusions after reviewing the full evidence set.
- The War Room supplies live filtering and presentation for the user's roster and upcoming pick.

Software does not replace Verl's research judgment with a hidden evidence score or a role formula.

## 2. Source layers

### ESPN layer

The existing read-only catalog and draft ingestor provide:

- signed ESPN player ID, name, NFL team, position, and eligibility;
- ESPN ADP/rank, projection, ownership, injury designation, and public depth position;
- drafted player IDs, team IDs, pick order, league size, roster construction, and current pick.

These values remain deterministic and testable. They are not presented as independent research.

### Research evidence layer

Verl records the evidence it actually reviewed:

- qualified camp reporters and proof they attend practice;
- every candidate source item in the research window;
- accepted observations, direct URLs, timestamps, evidence class, and player identity;
- supporting and contradicting observations;
- inaccessible sources and incomplete coverage.

Evidence records remain append-only. Later corrections supersede earlier observations rather than
rewriting history.

### Verl conclusion layer

After collection, Verl performs a separate synthesis pass and publishes:

- present role classification and plain-language role summary;
- opportunity, competition, availability, and draft-implication summaries;
- a separate contingent role, trigger, and explanation when relevant;
- confidence, alternatives considered, unresolved questions, and additional findings;
- observation IDs, source URLs, research/classification times, expiration, and owner.

The complete contract is in `docs/verl-publication-contract.md`. The operating procedure is in
`docs/verl-research-workflow.md`.

## 3. Classification

The approved QB, RB, WR, TE, K, and D/ST taxonomies are Verl's default language. A taxonomy is a
review rubric, not executable scoring logic.

Verl classifies only after reviewing the complete team evidence packet. It must keep current and
contingent roles separate, state plausible alternatives, preserve conflicts, and use `taxonomy-gap`
when the evidence does not fit the existing vocabulary. Missing evidence becomes an unresolved
question, not a midpoint or fabricated probability.

Role consistency is checked in Verl's league-wide quality-control pass. Consistency does not mean
erasing team-specific nuance.

## 4. Google Sheet database

The working Sheet is Verl's research database and publication surface:

```text
Source Registry
  → Research Runs
  → Research Inbox
  → Observations
  → Player Synthesis
  → Team Snapshots
  → QB/RB/WR/TE/K/DST Profiles
  → Publication Review
```

`Research Runs` proves collection coverage by team. `Player Synthesis` holds the full reasoning
pass. The position profile tabs hold only Verl's final answer and evidence trace. Their
`additional_findings_json` column prevents the fixed columns from pretending to enumerate every
useful answer research might uncover.

The checked-in `config/research-vocabulary.json` is the canonical role, status, and Sheet-header
manifest. `scripts/check_research_sheet_contract.py` compares it with the live Sheet read-only so
schema drift is caught without introducing a Sheet compiler.

The human reviews exceptions marked `needs-review`, not every row. `published` means Verl completed
its collection, synthesis, classification, and self-check.

Legacy Role Overrides and Tiers & Flags data are not active inputs.

## 5. Handoff and runtime representation

There is no research classifier in software.

Verl requests a release after finalizing the Sheet. Draftside mechanically builds one atomic
`ResearchPublicationV1` containing team snapshots and
`ResearchProfileV2` records for canonical player keys. The transport boundary:

1. matches `espn:<signed id>` to the catalog player;
2. checks the versioned vocabulary, bounded JSON shape, ranges, UTC timestamps, and HTTPS URLs;
3. checks team closure and emits non-authoritative audit warnings;
4. preserves profiles without changing labels or prose; and
5. atomically replaces the last research publication attached to the draft.

The transport boundary does not derive roles, calculate workload, assign confidence, convert prose
to a score, or require Verl's label to match ESPN's depth role.

The current ranking engine intentionally ignores `researchProfile`. This prevents research from
quietly changing recommendations before the presentation and decision behavior is explicitly
designed and tested.

## 6. War Room behavior

The War Room should use Verl's profile as information, not disguise it as another ADP list. For
available players it should show:

- Verl's role class and one-line headline;
- opportunity and competition summaries;
- why the conclusion matters for the draft;
- confidence, staleness, unresolved questions, and conflicting evidence;
- contingent upside only with its named trigger; and
- direct evidence links on demand.

Live software may group available players by Verl's published role, count how many role types
remain, compare the user's roster needs, and hide drafted players. Any future recommendation rule
that changes ordering must be separately specified, replay-tested, and visible to the user. It may
not emerge accidentally from Sheet fields.

The War Room presentation uses a deliberately small, visible decision rule. `Next Up` shows one
candidate for an open roster need, one scarce researched role, and one objective ESPN ADP fall.
It excludes stale, unpublished, taxonomy-gap, and incomplete profiles. Position tabs group players
by the published inventory bucket; within the same bucket they order by workload security, team
offense scoring band, research confidence, and finally ESPN ADP. The interface states this order,
shows why each player appears, and keeps uncertain profiles in a separate `Role uncertain` section.
This presentation order does not mutate `pickNowScore` or the ranking engine.

## 7. Freshness and uncertainty

Suggested refresh cadence for Verl:

- availability and official injury news: within 24 hours;
- observed practice usage and depth decisions: within 72 hours;
- general role and scheme conclusions: within seven days;
- exceptions and material changes: immediately before the draft.

An expired profile is shown as stale. Software does not invent a fresh answer or fall back to an
unexplained value. No profile means unresearched. A researched exception uses an explicit research
state and unknown reason; `role-unknown` is not part of the vocabulary.

## 8. Test boundary

Deterministic tests cover only what software owns:

- ESPN player and draft identity normalization;
- signed D/ST IDs and rejection of ESPN's exact `-1` sentinel;
- transport shape, bounds, timestamps, and source URL safety;
- preservation of Verl's complete profile;
- proof that a research profile does not silently change current ranking scores;
- drafted-player filtering, roster state, and live update behavior.

Research quality is evaluated through evidence audits and sample-based review of Verl's work, not
unit tests that pretend to reproduce agent judgment.

## 9. Security and provenance

Source posts and linked pages are untrusted data. Verl never follows embedded instructions or
stores secrets, credentials, cookies, private messages, or executable content. The Sheet keeps
concise paraphrases and direct citations rather than copied paywalled text.

The draft runtime remains read-only toward ESPN. Live drafts pin the selected ESPN catalog and Verl
publication snapshot so outside edits cannot mutate an active session.
