import type {
  DraftInitV1,
  DraftPickEventV1,
  IngestBatchV1,
  OffenseScoringBand,
  PositionResearchFindings,
  ResearchProfileV2,
  ResearchPublicationV1,
  ResearchRange,
} from "./contracts";
import {
  normalizeResearchPosition,
  RESEARCH_PUBLICATION_STATUSES,
  ROLE_VOCABULARY_VERSION,
  roleAllowed,
} from "./research";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const RESEARCH_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const RESEARCH_CONFIDENCES = new Set(["high", "medium", "low", "unknown"]);
const RESEARCH_STATES = new Set(["complete", "insufficient-evidence", "conflicting-evidence", "stale"]);
const PUBLICATION_STATUSES = new Set(RESEARCH_PUBLICATION_STATUSES);
const COMPETITION_STATUSES = new Set(["settled", "leaning", "open", "unknown"]);
const HIGH_VALUE_ROLES = new Set(["primary", "shared", "secondary", "none", "unknown"]);
const OFFENSE_SCORING_BANDS = new Set(["strong", "average", "weak", "unknown"]);
const RESEARCH_PROFILE_KEYS = [
  "schemaVersion",
  "profileId",
  "researchRunId",
  "evidenceCutoffAt",
  "position",
  "researchedRole",
  "researchState",
  "taxonomyState",
  "publicationStatus",
  "warRoomHeadline",
  "currentRoleSummary",
  "opportunitySummary",
  "competitionSummary",
  "availabilitySummary",
  "draftImplication",
  "contingency",
  "confidence",
  "confidenceReason",
  "alternativesConsidered",
  "unresolvedQuestions",
  "supportingObservationIds",
  "contradictingObservationIds",
  "sourceUrls",
  "structuredFindings",
  "additionalFindings",
  "researchedAt",
  "classifiedAt",
  "expiresAt",
  "classifiedBy",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function finiteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function stringArray(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => boundedString(item, maxLength));
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value) && Number.isFinite(Date.parse(value));
}

function validResearchFindings(value: unknown): value is ResearchProfileV2["additionalFindings"] {
  if (!isRecord(value) || Object.keys(value).length > 128) return false;
  return Object.entries(value).every(([key, fieldValue]) => {
    if (!RESEARCH_FIELD.test(key)) return false;
    if (fieldValue === null || typeof fieldValue === "boolean") return true;
    if (typeof fieldValue === "number") return finiteNumber(fieldValue, -1_000_000, 1_000_000);
    if (typeof fieldValue === "string") return boundedString(fieldValue, 1_000);
    return stringArray(fieldValue, 32, 160);
  });
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function validRange(value: unknown, min: number, max: number): value is ResearchRange {
  return isRecord(value) && exactKeys(value, ["low", "high"]) &&
    finiteNumber(value.low, min, max) && finiteNumber(value.high, min, max) && value.low <= value.high;
}

function validRank(value: unknown): boolean {
  return value === "tied-1" || value === "unknown" || integer(value, 1, 100);
}

function optionalEnum(value: unknown, allowed: Set<string>): boolean {
  return value === undefined || (typeof value === "string" && allowed.has(value));
}

function optionalRange(value: unknown, min: number, max: number): boolean {
  return value === undefined || validRange(value, min, max);
}

function validOffenseScoringBand(value: unknown): value is OffenseScoringBand {
  return typeof value === "string" && OFFENSE_SCORING_BANDS.has(value);
}

function validStructuredFindings(value: unknown, position: string): value is PositionResearchFindings {
  if (!isRecord(value) || value.position !== position) return false;
  if (position === "RB") {
    return exactKeys(value, ["position", "carryShare", "targetShare", "routeShare", "goalLineRole", "backfieldRank", "handcuffType", "competitionStatus"]) &&
      optionalRange(value.carryShare, 0, 1) && optionalRange(value.targetShare, 0, 1) &&
      optionalRange(value.routeShare, 0, 1) &&
      optionalEnum(value.goalLineRole, HIGH_VALUE_ROLES) &&
      (value.backfieldRank === undefined || validRank(value.backfieldRank)) &&
      optionalEnum(value.handcuffType, new Set(["direct", "ambiguous", "none", "unknown"])) &&
      optionalEnum(value.competitionStatus, COMPETITION_STATUSES);
  }
  if (position === "WR") {
    return exactKeys(value, ["position", "teamTargetRank", "targetShare", "routeShare", "redZoneTargetRole", "competitionStatus"]) &&
      (value.teamTargetRank === undefined || validRank(value.teamTargetRank)) &&
      optionalRange(value.targetShare, 0, 1) && optionalRange(value.routeShare, 0, 1) &&
      optionalEnum(value.redZoneTargetRole, HIGH_VALUE_ROLES) &&
      optionalEnum(value.competitionStatus, COMPETITION_STATUSES);
  }
  if (position === "TE") {
    return exactKeys(value, ["position", "routeShare", "targetShare", "teRoomRank", "teamTargetRank", "redZoneTargetRole", "blockingLoad"]) &&
      optionalRange(value.routeShare, 0, 1) && optionalRange(value.targetShare, 0, 1) &&
      (value.teRoomRank === undefined || validRank(value.teRoomRank)) &&
      (value.teamTargetRank === undefined || validRank(value.teamTargetRank)) &&
      optionalEnum(value.redZoneTargetRole, HIGH_VALUE_ROLES) &&
      optionalEnum(value.blockingLoad, new Set(["heavy", "balanced", "light", "unknown"]));
  }
  if (position === "QB") {
    return exactKeys(value, ["position", "week1StartProbability", "designedRushesPerGame", "passAttemptsPerGame", "starterLeash", "competitionStatus"]) &&
      optionalRange(value.week1StartProbability, 0, 1) &&
      optionalRange(value.designedRushesPerGame, 0, 100) && optionalRange(value.passAttemptsPerGame, 0, 100) &&
      optionalEnum(value.starterLeash, new Set(["stable", "moderate", "fragile", "unknown"])) &&
      optionalEnum(value.competitionStatus, COMPETITION_STATUSES);
  }
  if (position === "K") {
    return exactKeys(value, ["position", "jobSecurityProbability", "competitionStatus"]) &&
      optionalRange(value.jobSecurityProbability, 0, 1) &&
      optionalEnum(value.competitionStatus, COMPETITION_STATUSES);
  }
  if (position === "D/ST") {
    return exactKeys(value, ["position", "pressurePercentile", "sackPercentile", "takeawayPercentile", "pointsPreventionPercentile", "week1MatchupPercentile"]) &&
      ["pressurePercentile", "sackPercentile", "takeawayPercentile", "pointsPreventionPercentile", "week1MatchupPercentile"]
        .every((field) => value[field] === undefined || finiteNumber(value[field], 0, 100));
  }
  return false;
}

function validResearchProfile(value: unknown): value is ResearchProfileV2 {
  if (
    !isRecord(value) ||
    !exactKeys(value, RESEARCH_PROFILE_KEYS) ||
    value.schemaVersion !== 2 ||
    !boundedString(value.profileId, 120) ||
    !boundedString(value.researchRunId, 160) ||
    !validDate(value.evidenceCutoffAt)
  ) {
    return false;
  }
  const position = typeof value.position === "string" ? normalizeResearchPosition(value.position) : null;
  if (!position || position !== value.position || !RESEARCH_STATES.has(String(value.researchState))) return false;
  const researchedRole = value.researchedRole;
  if (researchedRole !== null && (!boundedString(researchedRole, 80) || !roleAllowed(position, researchedRole))) return false;
  if (value.researchState === "complete" && researchedRole === null) return false;
  if (value.taxonomyState !== "matched" && value.taxonomyState !== "taxonomy-gap") return false;
  if (value.taxonomyState === "taxonomy-gap" && researchedRole !== "taxonomy-gap") return false;
  if (value.taxonomyState === "matched" && researchedRole === "taxonomy-gap") return false;
  if (typeof value.publicationStatus !== "string" || !PUBLICATION_STATUSES.has(value.publicationStatus)) return false;
  if (
    value.publicationStatus === "published" &&
    (value.researchState !== "complete" || value.taxonomyState !== "matched" || researchedRole === null)
  ) {
    return false;
  }
  if (!boundedString(value.warRoomHeadline, 240)) {
    return false;
  }
  for (const field of [
    "currentRoleSummary",
    "opportunitySummary",
    "competitionSummary",
    "availabilitySummary",
    "draftImplication",
    "confidenceReason",
  ]) {
    if (!boundedString(value[field], 2_000)) return false;
  }
  if (typeof value.confidence !== "string" || !RESEARCH_CONFIDENCES.has(value.confidence)) {
    return false;
  }
  if (
    !stringArray(value.alternativesConsidered, 20, 500) ||
    !stringArray(value.unresolvedQuestions, 20, 500) ||
    !stringArray(value.supportingObservationIds, 100, 120) ||
    !stringArray(value.contradictingObservationIds, 100, 120) ||
    !stringArray(value.sourceUrls, 100, 1_000) ||
    (value.publicationStatus === "published" && value.sourceUrls.length === 0) ||
    !value.sourceUrls.every((url) => url.startsWith("https://")) ||
    !validStructuredFindings(value.structuredFindings, position) ||
    !validResearchFindings(value.additionalFindings)
  ) {
    return false;
  }
  if (
    !validDate(value.researchedAt) ||
    !validDate(value.classifiedAt) ||
    (value.expiresAt !== null && !validDate(value.expiresAt)) ||
    (value.publicationStatus === "published" && value.expiresAt === null) ||
    !boundedString(value.classifiedBy, 120)
  ) {
    return false;
  }
  if (
    Date.parse(value.evidenceCutoffAt) > Date.parse(value.researchedAt) ||
    Date.parse(value.researchedAt) > Date.parse(value.classifiedAt) ||
    (value.expiresAt !== null && Date.parse(value.classifiedAt) >= Date.parse(value.expiresAt))
  ) {
    return false;
  }
  if (value.contingency === null) return true;
  return (
    isRecord(value.contingency) &&
    exactKeys(value.contingency, ["researchedRole", "trigger", "summary"]) &&
    (value.contingency.researchedRole === null ||
      (boundedString(value.contingency.researchedRole, 80) && roleAllowed(position, value.contingency.researchedRole))) &&
    boundedString(value.contingency.trigger, 1_000) &&
    boundedString(value.contingency.summary, 2_000)
  );
}

export function validateResearchPublication(value: unknown): ResearchPublicationV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("invalid_research_publication");
  if (!boundedString(value.draftKey, 240) || !boundedString(value.publicationId, 160)) {
    throw new Error("invalid_research_publication_identity");
  }
  if (value.roleVocabularyVersion !== ROLE_VOCABULARY_VERSION) {
    throw new Error("unsupported_role_vocabulary");
  }
  if (value.rubricVersion !== null && !boundedString(value.rubricVersion, 80)) {
    throw new Error("invalid_research_rubric_version");
  }
  if (!validDate(value.publishedAt) || !boundedString(value.publishedBy, 120)) {
    throw new Error("invalid_research_publication_metadata");
  }
  const publishedAt = value.publishedAt;
  if (!Array.isArray(value.teamSnapshots) || value.teamSnapshots.length > 32) {
    throw new Error("invalid_research_team_snapshots");
  }
  const teams = new Set<string>();
  const teamSnapshots = value.teamSnapshots.map((item) => {
    if (
      !isRecord(item) ||
      !exactKeys(item, ["nflTeam", "researchRunId", "complete", "coveredPlayerKeys", "offenseScoringBand", "notes"]) ||
      !boundedString(item.nflTeam, 8) ||
      !boundedString(item.researchRunId, 160) ||
      teams.has(item.nflTeam)
    ) {
      throw new Error("invalid_research_team_snapshot");
    }
    teams.add(item.nflTeam);
    if (typeof item.complete !== "boolean" || !stringArray(item.coveredPlayerKeys, 100, 32)) {
      throw new Error("invalid_research_team_snapshot");
    }
    if (typeof item.notes !== "string" || item.notes.length > 2_000) {
      throw new Error("invalid_research_team_snapshot");
    }
    if (!validOffenseScoringBand(item.offenseScoringBand)) {
      throw new Error("invalid_research_team_snapshot");
    }
    if (!item.coveredPlayerKeys.every((key) => /^espn:-?\d{1,18}$/.test(key) && key !== "espn:-1")) {
      throw new Error("invalid_research_player_key");
    }
    return {
      nflTeam: item.nflTeam,
      researchRunId: item.researchRunId,
      complete: item.complete,
      coveredPlayerKeys: item.coveredPlayerKeys,
      offenseScoringBand: item.offenseScoringBand,
      notes: item.notes,
    };
  });
  if (!Array.isArray(value.profiles) || value.profiles.length > 1_000) {
    throw new Error("invalid_research_profiles");
  }
  const playerKeys = new Set<string>();
  const profiles = value.profiles.map((item) => {
    if (!isRecord(item) || !boundedString(item.playerKey, 32) || !/^espn:-?\d{1,18}$/.test(item.playerKey) || item.playerKey === "espn:-1") {
      throw new Error("invalid_research_player_key");
    }
    if (playerKeys.has(item.playerKey)) throw new Error("duplicate_research_player_key");
    playerKeys.add(item.playerKey);
    if (!boundedString(item.nflTeam, 8) || !validResearchProfile(item.profile)) {
      throw new Error("invalid_research_profile");
    }
    if (Date.parse(item.profile.classifiedAt) > Date.parse(publishedAt)) {
      throw new Error("invalid_research_publication_time");
    }
    return { playerKey: item.playerKey, nflTeam: item.nflTeam, profile: item.profile };
  });
  return {
    schemaVersion: 1,
    draftKey: value.draftKey,
    publicationId: value.publicationId,
    roleVocabularyVersion: value.roleVocabularyVersion,
    rubricVersion: value.rubricVersion,
    publishedAt,
    publishedBy: value.publishedBy,
    teamSnapshots,
    profiles,
  };
}

export function validatePick(value: unknown): DraftPickEventV1 {
  if (!isRecord(value)) throw new Error("invalid_pick");
  if (value.schemaVersion !== 1) throw new Error("unsupported_pick_schema");
  if (!boundedString(value.eventId, 64) || !HEX_64.test(value.eventId)) throw new Error("invalid_event_id");
  if (!integer(value.overallPick, 1, 1000)) throw new Error("invalid_overall_pick");
  if (!integer(value.round, 1, 100)) throw new Error("invalid_round");
  if (!integer(value.roundPick, 1, 100)) throw new Error("invalid_round_pick");
  if (!boundedString(value.teamId, 80)) throw new Error("invalid_team_id");
  if (!boundedString(value.playerId, 80)) throw new Error("invalid_player_id");
  if (value.source !== "espn" && value.source !== "manual") throw new Error("invalid_source");
  if (value.providerObservedAt !== null && !validDate(value.providerObservedAt)) throw new Error("invalid_provider_time");
  if (!validDate(value.ingestorObservedAt)) throw new Error("invalid_ingestor_time");
  return value as DraftPickEventV1;
}

export function validateIngest(value: unknown): IngestBatchV1 {
  if (!isRecord(value)) throw new Error("invalid_envelope");
  if (value.schemaVersion !== 1) throw new Error("unsupported_schema");
  if (!boundedString(value.draftKey, 240)) throw new Error("invalid_draft_key");
  if (!boundedString(value.ingestorInstanceId, 120)) throw new Error("invalid_ingestor_id");
  if (!validDate(value.capturedAt)) throw new Error("invalid_capture_time");
  if (!isRecord(value.cursor)) throw new Error("invalid_cursor");
  const cursor = value.cursor;
  const lastOverallPick = cursor.lastOverallPick;
  if (!integer(lastOverallPick, 0, 1000)) throw new Error("invalid_cursor");
  if (!isRecord(value.draftState)) throw new Error("invalid_draft_state");
  const draftState = value.draftState;
  const inProgress = draftState.inProgress;
  const drafted = draftState.drafted;
  const totalPickSlots = draftState.totalPickSlots;
  if (typeof inProgress !== "boolean" || typeof drafted !== "boolean") throw new Error("invalid_phase_flags");
  if (inProgress && drafted) throw new Error("invalid_phase_flags");
  if (!integer(totalPickSlots, 1, 1000)) throw new Error("invalid_total_picks");
  if (!Array.isArray(value.events) || value.events.length > 100) throw new Error("invalid_events");
  const events = value.events.map(validatePick);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1]!.overallPick >= events[index]!.overallPick) throw new Error("events_not_strictly_ordered");
  }
  if (events.some((event) => event.overallPick > totalPickSlots)) {
    throw new Error("invalid_overall_pick");
  }
  if (events.some((event) => event.overallPick > lastOverallPick)) {
    throw new Error("invalid_cursor");
  }
  return {
    schemaVersion: 1,
    draftKey: value.draftKey,
    ingestorInstanceId: value.ingestorInstanceId,
    capturedAt: value.capturedAt,
    cursor: { lastOverallPick },
    draftState: {
      inProgress,
      drafted,
      totalPickSlots,
    },
    events,
  };
}

export function validateInit(value: unknown): DraftInitV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("invalid_init");
  if (!boundedString(value.draftKey, 240)) throw new Error("invalid_draft_key");
  if (value.displayName !== undefined && !boundedString(value.displayName, 120)) {
    throw new Error("invalid_draft_display_name");
  }
  if (!integer(value.expectedTeams, 2, 32) || !integer(value.expectedRounds, 1, 40)) throw new Error("invalid_draft_shape");
  if (!integer(value.totalPickSlots, 1, 1000)) throw new Error("invalid_total_picks");
  if (value.totalPickSlots !== Number(value.expectedTeams) * Number(value.expectedRounds)) {
    throw new Error("invalid_draft_shape");
  }
  if (!boundedString(value.pinnedCatalogVersion, 120)) throw new Error("invalid_catalog_version");
  if (!Array.isArray(value.catalog) || value.catalog.length > 5000) throw new Error("invalid_catalog");
  const playerIds = new Set<string>();
  const catalog: DraftInitV1["catalog"] = [];
  for (const player of value.catalog) {
    if (!isRecord(player)) throw new Error("invalid_catalog_player");
    if (!boundedString(player.playerId, 80) || player.playerId === "-1") throw new Error("invalid_catalog_player_id");
    if (playerIds.has(player.playerId)) throw new Error("duplicate_catalog_player_id");
    playerIds.add(player.playerId);
    if (!boundedString(player.name, 160)) throw new Error("invalid_catalog_player_name");
    if (!boundedString(player.position, 16) || !boundedString(player.nflTeam, 16)) throw new Error("invalid_catalog_player_team");
    if (!boundedString(player.tier, 32) || !boundedString(player.roleClass, 64)) throw new Error("invalid_catalog_player_role");
    if (!finiteNumber(player.opportunityScore, 0, 100) || !finiteNumber(player.intrinsicScore, 0, 100) || !finiteNumber(player.pickNowScore, 0, 100)) {
      throw new Error("invalid_catalog_player_score");
    }
    if (player.returnProbability !== null && !finiteNumber(player.returnProbability, 0, 1)) {
      throw new Error("invalid_catalog_return_probability");
    }
    if (!stringArray(player.reasons, 12, 240) || !stringArray(player.risks, 12, 240)) {
      throw new Error("invalid_catalog_player_explanation");
    }
    if (player.adp !== undefined && !finiteNumber(player.adp, 0, 1000)) throw new Error("invalid_catalog_player_adp");
    if (player.projectedPoints !== undefined && !finiteNumber(player.projectedPoints, -100, 1000)) {
      throw new Error("invalid_catalog_player_projection");
    }
    if (player.percentOwned !== undefined && !finiteNumber(player.percentOwned, 0, 100)) {
      throw new Error("invalid_catalog_player_percent_owned");
    }
    if (player.auctionValue !== undefined && !finiteNumber(player.auctionValue, 0, 1000)) {
      throw new Error("invalid_catalog_player_auction_value");
    }
    if (player.byeWeek !== undefined && !integer(player.byeWeek, 0, 25)) throw new Error("invalid_catalog_player_bye_week");
    if (
      player.eligibleSlots !== undefined &&
      (!Array.isArray(player.eligibleSlots) ||
        player.eligibleSlots.length > 32 ||
        !player.eligibleSlots.every((slot) => integer(slot, 0, 99)))
    ) {
      throw new Error("invalid_catalog_player_eligible_slots");
    }
    if (player.injuryStatus !== undefined && !boundedString(player.injuryStatus, 64)) {
      throw new Error("invalid_catalog_player_injury_status");
    }
    if (player.depthPosition !== undefined && !boundedString(player.depthPosition, 32)) {
      throw new Error("invalid_catalog_player_depth_position");
    }
    if (player.depthOrdinal !== undefined && !integer(player.depthOrdinal, 0, 20)) {
      throw new Error("invalid_catalog_player_depth_ordinal");
    }
    if (player.researchProfile !== undefined && !validResearchProfile(player.researchProfile)) {
      throw new Error("invalid_catalog_player_research_profile");
    }
    catalog.push({
      playerId: player.playerId,
      name: player.name,
      position: player.position,
      nflTeam: player.nflTeam,
      tier: player.tier,
      roleClass: player.roleClass,
      opportunityScore: player.opportunityScore,
      intrinsicScore: player.intrinsicScore,
      pickNowScore: player.pickNowScore,
      returnProbability: player.returnProbability,
      reasons: player.reasons,
      risks: player.risks,
      ...(player.adp === undefined ? {} : { adp: player.adp }),
      ...(player.projectedPoints === undefined ? {} : { projectedPoints: player.projectedPoints }),
      ...(player.percentOwned === undefined ? {} : { percentOwned: player.percentOwned }),
      ...(player.auctionValue === undefined ? {} : { auctionValue: player.auctionValue }),
      ...(player.byeWeek === undefined ? {} : { byeWeek: player.byeWeek }),
      ...(player.eligibleSlots === undefined ? {} : { eligibleSlots: player.eligibleSlots }),
      ...(player.injuryStatus === undefined ? {} : { injuryStatus: player.injuryStatus }),
      ...(player.depthPosition === undefined ? {} : { depthPosition: player.depthPosition }),
      ...(player.depthOrdinal === undefined ? {} : { depthOrdinal: player.depthOrdinal }),
      ...(player.researchProfile === undefined ? {} : { researchProfile: player.researchProfile }),
    });
  }
  if (!boundedString(value.managedTeamId, 80)) throw new Error("invalid_managed_team_id");
  if (
    !Array.isArray(value.draftSlotTeamIds) ||
    value.draftSlotTeamIds.length !== value.totalPickSlots ||
    !value.draftSlotTeamIds.every((teamId) => boundedString(teamId, 80))
  ) {
    throw new Error("invalid_draft_slot_team_ids");
  }
  if (!value.draftSlotTeamIds.includes(value.managedTeamId)) throw new Error("managed_team_not_in_draft_slots");
  if (!isRecord(value.rosterTargets)) throw new Error("invalid_roster_targets");
  const rosterTargets = value.rosterTargets;
  const normalizedTargets: Partial<DraftInitV1["rosterTargets"]> = {};
  for (const position of ["QB", "RB", "WR", "TE", "FLEX"] as const) {
    const target = rosterTargets[position];
    if (!integer(target, 0, 20)) throw new Error("invalid_roster_targets");
    normalizedTargets[position] = target;
  }
  return {
    schemaVersion: 1,
    draftKey: value.draftKey,
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    expectedTeams: value.expectedTeams,
    expectedRounds: value.expectedRounds,
    totalPickSlots: value.totalPickSlots,
    managedTeamId: value.managedTeamId,
    draftSlotTeamIds: value.draftSlotTeamIds,
    rosterTargets: {
      QB: normalizedTargets.QB!,
      RB: normalizedTargets.RB!,
      WR: normalizedTargets.WR!,
      TE: normalizedTargets.TE!,
      FLEX: normalizedTargets.FLEX!,
    },
    pinnedCatalogVersion: value.pinnedCatalogVersion,
    catalog,
  };
}
