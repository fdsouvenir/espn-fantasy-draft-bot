import type { DraftInitV1, DraftPickEventV1, IngestBatchV1 } from "./contracts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const HEX_64 = /^[a-f0-9]{64}$/;

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
