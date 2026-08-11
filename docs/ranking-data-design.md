# Player Data and Deterministic Ranking Design

Status: reference design and implemented-model notes  
Scope: player/scouting data, league context, ranking, likely-to-return simulation, explainability, and validation  
Non-goals: ESPN authentication, live transport, UI implementation, deployment, and any write to a production league

## 1. Evidence boundary

### Confirmed from the workspace

- The approved goal is a live, opportunity-aware assistant that uses role, workload, depth chart, roster construction, and return probability.
- Production leagues are read-only. The system must not draft, queue players, or change league settings.
- The preserved probe reads the ESPN `mDraftDetail` view for a season and league.
- The recovered completed draft confirms that `draftDetail.picks` uses `playerId = -1` only for an unfilled slot. Filled D/ST selections use negative ESPN IDs (for example `-16007`), so sign-based filtering is invalid. The probe also observes the draft-level `inProgress` and `drafted` flags.
- The probe has not established the full schema, semantics, stability, or completeness of ESPN league, player, keeper, roster, and pick fields. Those must be captured and validated in the evidence/API lane before being accepted as facts.
- Google Sheets is the intended editorial control panel. The approved plan calls for a validated, frozen snapshot to feed the live application rather than querying the Sheet in the draft-critical path.

### Design assumptions to validate

- ESPN athlete IDs are stable enough within a season to be the ESPN-side player key.
- ESPN exposes sufficient league settings, teams, rosters, keepers, and player-pool data through read-only views. Exact view names and field paths are deliberately not specified here until fixtures prove them.
- ADP/projection/depth-chart data will come from permitted sources with provenance and usage rights appropriate to this private application.
- The live draft is a snake draft unless the validated league settings say otherwise. Auction support is out of scope for the first release.
- A deterministic seeded Monte Carlo model is acceptable for “likely to return”; it is a probability estimate, not a promise.

Any implementation field beginning with `source.*` below must be populated from a captured fixture or explicitly marked `unknown`. No silent defaults for league rules are allowed in draft-night mode.

## 2. Canonical identifiers and versioning

Identifiers must remain provider-qualified so an ESPN ID is never confused with a third-party source ID.

### Core keys

- `player_key`: internal immutable key, recommended format `nfl:<gsis_id>` when a verified crosswalk exists; otherwise `espn:ffl:<season>:<espn_player_id>`.
- `espn_player_id`: signed integer from validated ESPN player/pick payloads. Positive IDs cover ordinary players; recovered evidence confirms negative IDs for D/ST. Exactly `-1` is reserved for an unfilled draft slot.
- `source_player_id`: `(source_name, source_player_id, source_season)` mapping to `player_key`, with match method and confidence.
- `league_key`: `espn:ffl:<season>:<league_id>`.
- `fantasy_team_key`: provider team ID qualified by `league_key`.
- `nfl_team_key`: canonical team abbreviation plus season; retain ESPN pro-team ID as a mapped source identifier, not as the canonical value.
- `draft_pick_key`: `league_key + overall_pick_number`. Preserve source pick ID if ESPN supplies one.
- `snapshot_id`: content-addressed or UUID identifier for an immutable data release.
- `editorial_row_id`: stable UUID stored in the Sheet; never use row number as identity.

### Crosswalk rules

- Automated exact matches require a verified source ID mapping or a unique normalized tuple of full name, NFL team, position, and season.
- Name-only matching is forbidden for production imports.
- Ambiguous, traded, free-agent, rookie, suffix, and duplicate-name cases enter a reconciliation queue.
- Crosswalks record `match_method`, `match_confidence`, `matched_at`, and `reviewed_by`.
- Once a draft snapshot is frozen, its crosswalks cannot change. Corrections produce a new snapshot.

## 3. Data domains

### 3.1 Player identity and availability

`Player`

- `player_key`, `espn_player_id`, source-ID mappings
- display name, normalized name, position, NFL team, eligible fantasy slots
- status: active, injured, suspended, PUP/NFI, free agent, retired, unknown
- rookie flag and experience years when sourced
- ESPN draftability/availability flags when fixture-proven
- identity provenance and last validation time

`DraftAvailability`

- `snapshot_id`, `league_key`, `player_key`
- state: available, drafted, keeper, unavailable, unknown
- selected by fantasy team, overall pick, round, pick in round, observed time
- event source and event sequence

The live board derives availability from the ordered pick event stream. A UI cache must never independently mark a player drafted without the corresponding canonical pick event.

### 3.2 League settings, rosters, and keepers

`LeagueSnapshot`

- league and season identifiers
- scoring type and normalized scoring rules
- team count
- draft type, draft order, round count, pick clock when available
- roster slot counts and starting-lineup requirements
- position eligibility rules
- transaction/keeper rules relevant to the draft
- source capture time, payload hash, and schema version

`FantasyTeamSnapshot`

- fantasy team key, display label, draft slot
- pre-draft roster
- rostered players by normalized slot
- keeper assignments
- acquired/traded draft picks if present

`KeeperAssignment`

- player, fantasy team, keeper status
- charged round/pick when the platform exposes it
- occupied roster slot
- source location and confidence

Keeper normalization rules:

1. A keeper is unavailable before live ranking begins.
2. A keeper occupies the appropriate roster/position count immediately.
3. A charged pick is represented as a prefilled draft-pick event if ESPN models it that way; otherwise it remains a keeper assignment linked to the charged round.
4. Keepers must not be double-counted when both roster and draft payloads include them.
5. Unknown keeper cost or draft-order implications block production readiness rather than being guessed.

### 3.3 Source observations and provenance

Every non-ESPN scouting fact is an observation, not an overwritten global truth.

`SourceObservation`

- `observation_id`, `player_key`
- source name, source player ID, source URL/reference, publisher
- source class: projection, ADP, depth chart, injury, beat report, official team report, analyst grade, manual editorial
- field name and typed value
- `observed_at`, `published_at`, `effective_from`, optional `expires_at`
- confidence from 0 to 1
- freshness state: fresh, aging, stale, expired
- rights/usage note and import batch
- raw-record hash; raw licensed content is not copied into the public/client bundle

Freshness is field-class-specific and configurable. Initial assumptions for preseason testing are: injury/news 24 hours, depth-chart designation 72 hours, workload/editorial estimate 7 days, ADP/projection 24 hours, and team environment 7 days. These are defaults to validate, not facts. Expired data remains auditable but contributes zero unless a reviewed manual override explicitly extends it.

For conflicting observations, deterministic precedence is:

1. Active manual override with author, reason, and expiration.
2. Higher source-class authority configured for that field.
3. Higher confidence.
4. Newer effective/published time.
5. Stable source-name and observation-ID tie-break.

The resolved value retains all contributing observation IDs.

## 4. Google Sheets editorial control panel

The Sheet is for human review and overrides. The draft helper reads only an exported, validated snapshot. Imports and exports must select the Google account and spreadsheet explicitly; no live Sheet mutation occurs from the draft runtime.

### Tabs

#### `Players`

Read-mostly source inventory:

- `editorial_row_id` (protected)
- `player_key` (protected)
- `espn_player_id` (protected)
- `name`, `position`, `nfl_team`
- `espn_rank`, consensus rank, projection points, ADP, ADP deviation
- resolved depth role, workload fields, injury/status
- resolved source dates, confidence, freshness warning
- current tier and computed intrinsic rank

#### `Role Overrides`

Human-editable opportunity model:

- `editorial_row_id`, `player_key`, display name
- `role_class`: starter, lead-committee, committee, passing-down, goal-line, backup, specialist, unknown
- `snap_share_low`, `snap_share_mid`, `snap_share_high`
- `carry_share_low`, `carry_share_mid`, `carry_share_high`
- `route_share_low`, `route_share_mid`, `route_share_high`
- `target_share_low`, `target_share_mid`, `target_share_high`
- `goal_line_share_low`, `goal_line_share_mid`, `goal_line_share_high`
- `contingent_role`: none, committee-gain, lead-if-one-injury, lead-if-multiple-injuries
- `contingent_probability`, `contingent_value`
- `role_certainty`, `offense_environment`, `injury_risk`
- `override_reason`, `source_refs`, `effective_at`, `expires_at`, `reviewed_by`

#### `Tiers & Flags`

- `player_key`, position, tier
- `target_flag`: target, neutral, avoid
- `target_adjustment` constrained to a small configured range
- `max_pick` / “do not take before” and `min_pick` / “do not pass after” optional guardrails
- notes, reason, expiration, reviewer

#### `Sources`

- source observation fields from Section 3.3
- validation status and rights/usage note
- only citations or concise structured facts, not copied paywalled prose

#### `League Review`

- normalized league settings, roster slots, teams, keepers, and draft order
- source value, normalized value, validation status
- protected during normal editing; unresolved/unknown cells are visibly flagged

#### `Release`

- semantic schema version
- snapshot label and generated snapshot ID
- source batch IDs and maximum data age
- validation status, error count, warning count
- prepared/reviewed times and approver
- export hash

### Sheet validation

- Dropdown validation for enumerations; numeric bounds for all shares/confidence fields.
- Enforce `0 <= low <= mid <= high <= 1` for share ranges.
- Unique, nonblank `editorial_row_id` and `player_key`.
- Override requires reason, source reference, reviewer, and expiration.
- Conditional formatting highlights expired sources, unresolved IDs, impossible workloads, and required unknown league settings.
- Protected identifier/formula columns; editorial input columns visually distinct.
- Freeze headers, enable filters, and keep one logical record per row.
- Export is rejected on any error. Warnings require an explicit release acknowledgment.

## 5. Opportunity feature model

All component scores use a 0–100 scale and retain their raw inputs. Missing inputs do not become zero; they reduce confidence and use a position-specific baseline only when the release policy explicitly permits it.

### Role classification

- `starter`: expected to lead the position group in relevant snaps and opportunities.
- `lead-committee`: expected lead but not dominant workload.
- `committee`: meaningful work without a stable lead.
- `passing-down`: route/target specialist.
- `goal-line`: short-yardage/touchdown specialist.
- `backup`: limited base workload with a plausible promotion path.
- `specialist`: defined narrow role not captured above.
- `unknown`: evidence insufficient.

Role labels describe the present. Contingent upside is modeled separately so a famous backup does not outrank a lesser-known starter merely because the backup has name value.

### Position-specific opportunity scores

Initial weights are design parameters and must be backtested before release.

- RB: 30% carry share, 20% snap share, 20% route/target opportunity, 20% goal-line share, 10% role classification.
- WR/TE: 35% target share, 30% route share, 15% snap share, 10% high-value/red-zone opportunity, 10% role classification.
- QB: 35% starting certainty/dropback share, 25% passing volume, 15% designed rushing, 15% offense environment, 10% goal-line/rushing role.
- K/DST: separate later-round models; they must not inherit offensive-skill weights.

For an interval feature, use the confidence-adjusted midpoint:

`adjusted = confidence * mid + (1 - confidence) * position_baseline`

Interval width contributes to uncertainty/risk; it does not automatically lower expected opportunity twice.

`role_certainty` combines evidence agreement, workload interval width, depth-chart stability, and injury/news freshness. `contingent_upside` combines the probability of promotion and the value in the promoted role. Probability and value remain separate in explanations.

## 6. Deterministic ranking engine

### 6.1 Normalization

Raw projection points, value over replacement, ADP, and environment metrics are converted to 0–100 empirical percentile scores within the draftable pool and position. Fixed transforms and input snapshot make results reproducible. Stable ties resolve by:

1. higher opportunity score;
2. higher role certainty;
3. lower consensus/market rank number;
4. lower `player_key` lexical value.

### 6.2 Intrinsic player score

Initial formula:

```text
intrinsic =
  0.35 * projection_value_over_replacement
+ 0.30 * opportunity
+ 0.10 * role_certainty
+ 0.10 * contingent_upside
+ 0.05 * offense_environment
+ 0.10 * editorial_quality
```

`editorial_quality` is not fame or narrative. It is a constrained synthesis of reviewed film/analyst evidence and target/avoid adjustments. Manual changes are capped, sourced, expiring, and visible.

Risk is separate:

```text
risk_penalty =
  0.40 * injury_risk
+ 0.25 * workload_uncertainty
+ 0.20 * source_staleness
+ 0.15 * role_instability
```

The risk penalty is scaled to a maximum configurable deduction of 12 ranking points. Unknown critical status may instead make a player “review required.”

### 6.3 Pick-now score

```text
pick_now = clamp(
    intrinsic
  - risk_deduction
  + tier_scarcity_delta
  + roster_fit_delta
  + market_value_delta
  + return_urgency_delta,
  0, 120
)
```

Initial contextual bounds:

- tier scarcity: 0 to +8
- roster fit: -8 to +10
- market value versus ADP: -6 to +6
- return urgency: 0 to +12

All bounds and weights live in a versioned policy object, not code constants scattered across modules. The UI shows intrinsic rank as well as pick-now rank so context-driven movement is obvious.

### 6.4 Roster fit

Roster fit is computed from the validated league rules and the managed team’s roster at the current pick:

- largest positive adjustment for an unfilled required starter slot with a closing tier;
- smaller positive adjustment for depth below a configured minimum;
- neutral treatment of flex-eligible depth until starter floors are covered;
- penalty for exceeding position depth targets while required starters remain open;
- penalty for concentrated bye-week exposure only when a plausible near-equal alternative exists;
- no hard “must fill” behavior for K/DST early; their timing is policy-controlled.

Roster fit may reorder close players but must not conceal a large intrinsic-value gap. A configurable dominance rule (initially 12 intrinsic points) prevents need from forcing an objectively much weaker selection.

### 6.5 Tier scarcity

Scarcity is driven by remaining players in the candidate’s tier and projected picks before the managed team selects again. It is higher when the tier is unlikely to survive and the next tier has a material intrinsic-value drop. It is zero if the next tier is effectively equivalent.

### 6.6 Market value

Market value compares current overall pick to the player’s ADP distribution, not a single rank. Reaching ahead of market is a bounded penalty, never an absolute prohibition. Falling materially past the distribution is a bounded bonus. This component is disabled when ADP is stale or the source sample is inadequate.

## 7. Likely-to-return simulation

The return model estimates whether a player remains available at the managed team’s next owned pick.

### Inputs

- current ordered draft state and actual future pick owners;
- every team’s roster, keepers, and unfilled slots;
- validated draft order, roster/scoring settings, and traded picks;
- available player intrinsic scores, positions, tiers, and ADP distributions;
- synthetic manager strategy profiles;
- deterministic simulation seed derived from `snapshot_id`, draft state hash, and candidate player key.

### Algorithm

1. Determine the next pick owned by the managed team. If none exists, return `not_applicable`.
2. For each simulation, process intervening picks in actual order.
3. Each synthetic team chooses from a bounded top candidate set using intrinsic value, team need, tier scarcity, ADP tendency, position-run sensitivity, and seeded random utility noise.
4. Enforce roster feasibility but permit realistic bench choices and reaches.
5. Record whether the candidate survives to the managed team’s next pick.
6. Report `survivals / simulations`, a confidence interval, simulation count, policy version, and dominant reasons for removal.

Initial production target is at least 5,000 simulations per material board state, reduced only if latency tests demand it. Cache by draft-state hash and invalidate on every pick or scouting snapshot change.

### Calibration

- Fit ADP uncertainty and manager-noise parameters against historical drafts of comparable size/scoring when licensed data is available.
- Backtest probability buckets: candidates labeled 70–80% should return approximately 70–80% of the time.
- Report Brier score and calibration error, not just pick accuracy.
- If calibration data is inadequate, label results `experimental` and widen confidence intervals.

`return_urgency_delta` increases as return probability falls, but only for players already near the top of the intrinsic board. Initial mapping: zero above 75%, gradual rise from 75% to 25%, maximum below 25%. Exact curve is a versioned design parameter.

## 8. Explainability contract

Every recommended player returns:

- player identity, availability, intrinsic rank, and pick-now rank;
- total score and every raw/weighted component;
- present role and projected workload intervals;
- role certainty, contingent upside trigger, injury/status, and freshness;
- roster-fit reason and affected slot;
- tier name, players left in tier, and drop to next tier;
- ADP distribution and current-pick comparison;
- probability of returning, confidence interval, simulations, and next owned pick;
- top three positive factors and top two risks;
- source references, observation dates, snapshot ID, ranking-policy version, and draft-state hash.

Explanation text is generated from fixed templates and structured reason codes. A language model may summarize those fields later, but it cannot alter scores, invent evidence, or become the ranking authority.

Example reason codes:

- `ROLE_STARTER_HIGH_CONFIDENCE`
- `RB_GOAL_LINE_LEAD`
- `TARGET_SHARE_RISING`
- `CONTINGENT_LEAD_ONE_INJURY`
- `LAST_PLAYER_IN_TIER`
- `REQUIRED_STARTER_SLOT_OPEN`
- `UNLIKELY_TO_RETURN`
- `SOURCE_STALE`
- `WORKLOAD_RANGE_WIDE`
- `INJURY_STATUS_REVIEW`

## 9. Snapshot pipeline and runtime contract

1. Ingest permitted source batches into observations.
2. Resolve identities and conflicts deterministically.
3. Import/review editorial overrides from the Sheet.
4. Fetch and normalize the read-only league snapshot.
5. Validate all schemas and business rules.
6. Generate immutable `scouting_snapshot`, `league_snapshot`, `ranking_policy`, and crosswalk artifacts.
7. Hash and store the release manifest.
8. Load the validated release into the runtime datastore.
9. Rank against the current canonical draft-state hash.

The release manifest includes input hashes, source timestamps, crosswalk version, policy version, validation results, and generated time. Draft-night scoring never changes merely because a Sheet cell changed; a new reviewed release must be produced.

## 10. Validation rules

Release-blocking errors:

- duplicate or missing canonical keys;
- ambiguous source identity;
- drafted/keeper player also marked available;
- duplicate overall pick or conflicting player selection;
- unknown team count, draft order, scoring, or required roster slots;
- keeper counted twice or keeper ownership mismatch;
- share outside 0–1 or `low > mid > high` ordering violation;
- expired manual override;
- missing provenance for a non-ESPN editorial value;
- stale critical injury/status data at release threshold;
- non-finite score, score outside bounds, or nondeterministic ordering;
- source data whose permitted-use status is unresolved.

Warnings requiring acknowledgment:

- optional workload input imputed from a position baseline;
- aging but not expired data;
- low-confidence contingent-upside estimate;
- ADP sample too small, causing market and return components to be disabled;
- unusually concentrated bye weeks;
- player eligible at an unexpected slot.

Runtime invariants:

- applying the same ordered pick event twice is idempotent;
- every newly drafted player disappears from recommendations exactly once;
- snapshot and policy versions remain fixed through one live draft unless an explicit controlled release occurs;
- equal inputs, seed, and state hash produce byte-equivalent ranking output;
- an unknown critical input produces a visible degraded state, not a fabricated value.

## 11. Test cases

### Identity and ingestion

1. Two players with the same normalized name but different teams do not auto-merge.
2. A traded player maps consistently despite stale source team metadata.
3. An unknown ESPN `playerId` enters reconciliation and is excluded from production recommendations.
4. Reimporting the same source batch is idempotent.
5. Conflicting observations resolve by the documented precedence and retain both source IDs.

### League, keepers, and draft state

6. A keeper is unavailable and occupies the correct roster slot before pick one.
7. A keeper represented in both roster and draft payloads is counted once.
8. A traded future pick causes the simulator to use the actual owner.
9. Duplicate, missing, and out-of-order pick events converge to one correct ordered state or raise a visible gap.
10. A league with unknown scoring or roster requirements cannot enter ready state.

### Opportunity and ranking

11. With projections otherwise equal, a high-confidence starting RB outranks a low-workload famous backup.
12. A backup with strong contingent value rises when promotion probability increases but does not receive starter workload before the trigger.
13. A passing-down RB gains appropriately in PPR and less in non-PPR scoring.
14. A goal-line role increases RB value without inflating route/target opportunity.
15. Wider workload intervals increase risk while preserving the same midpoint expectation.
16. An expired override contributes nothing and blocks release if marked required.
17. Changing row order in the Sheet does not change rankings.
18. Equal inputs produce identical scores, tie-breaks, explanations, and hashes.

### Roster fit and scarcity

19. An open required RB slot boosts a close RB candidate but cannot overcome the intrinsic dominance threshold.
20. A final player in a strong tier gains scarcity value; a final player in a flat tier does not.
21. Bye-week concentration only breaks a close choice and never becomes a hidden hard exclusion.
22. K/DST do not rise early because skill-position starter slots remain open.

### Likely to return

23. A candidate with no intervening picks returns 100% subject to current-state consistency.
24. A candidate removed in every simulation reports 0% with the correct removal reasons.
25. The same snapshot, state, candidate, and seed produce identical probability output.
26. A positional run lowers relevant return probabilities after the triggering picks.
27. A keeper-heavy roster changes synthetic team needs and selection behavior.
28. Probability buckets pass calibration thresholds on historical holdout drafts before the `experimental` label is removed.

### Explainability and safety

29. Every score change maps to a changed component and source-backed reason code.
30. Missing/stale evidence appears in risks and cannot generate positive narrative.
31. Client output contains no cookies, credentials, private source payloads, or unapproved raw licensed content.
32. A drafted player can never appear in the best-three response for the same state hash.

## 12. Acceptance gate for implementation

This design is ready to implement only after the evidence/API lane supplies sanitized fixtures proving:

- exact ESPN player, pick, team, roster, settings, keeper, and draft-order field paths;
- player ID and pick-order behavior across pre-draft, live, completed, duplicate, and reconnect states;
- how keepers and traded picks appear for this league type;
- scoring and roster settings needed by the ranking policy;
- a safe crosswalk path from ESPN players to permitted scouting/ADP sources.

After fixture validation, replace assumptions with fixture citations, lock schema version `1.0.0`, and record every initial weight/threshold as a tunable policy value requiring backtest evidence before it is called calibrated.
