import type { ResearchPublicationV1 } from "./contracts.js";
import { RESEARCH_PUBLICATION_STATUSES, ROLE_VOCABULARY_VERSION } from "./research.js";
import { validateResearchPublication } from "./validation.js";
import vocabulary from "../config/research-vocabulary.json" with { type: "json" };

export type ResearchSheetImportV1 = {
  schemaVersion: 1;
  spreadsheetId: string;
  requestId: string;
  requestedAt: string;
  requestedBy: string;
  ranges: Record<string, unknown[][]>;
};

const PROFILE_TABS: Record<string, string> = {
  QB: "QB Profiles",
  RB: "RB Profiles",
  WR: "WR Profiles",
  TE: "TE Profiles",
  K: "K Profiles",
  "D/ST": "DST Profiles",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,118}[A-Za-z0-9]$/;
const COMPETITION_STATUSES = ["settled", "leaning", "open", "unknown"] as const;
const HIGH_VALUE_ROLES = ["primary", "shared", "secondary", "none", "unknown"] as const;
const RESEARCH_CONFIDENCES = ["high", "medium", "low", "unknown"] as const;

export class ResearchSheetImportError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super("invalid_research_sheet_import");
    this.name = "ResearchSheetImportError";
    this.problems = problems;
  }
}

type SheetRow = Record<string, unknown>;

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function rowLabel(tab: string, rowNumber: number, field?: string): string {
  return field ? `${tab} row ${rowNumber} ${field}` : `${tab} row ${rowNumber}`;
}

function rowsFor(
  ranges: Record<string, unknown[][]>,
  tab: string,
  expectedHeaders: readonly string[],
  problems: string[],
): Array<{ row: SheetRow; rowNumber: number }> {
  const values = ranges[tab];
  if (!Array.isArray(values) || !Array.isArray(values[0])) {
    problems.push(`${tab} is missing`);
    return [];
  }
  const headers = values[0].map(text);
  if (
    headers.length !== expectedHeaders.length ||
    headers.some((header, index) => header !== expectedHeaders[index])
  ) {
    problems.push(`${tab} headers differ from the checked-in contract`);
    return [];
  }
  return values.slice(1).map((valuesRow, index) => ({
    row: Object.fromEntries(headers.map((header, column) => [header, valuesRow[column] ?? ""])),
    rowNumber: index + 2,
  }));
}

function splitList(value: unknown, delimiter: RegExp = /\s*;\s*/): string[] {
  const raw = text(value);
  return raw ? raw.split(delimiter).map((item) => item.trim()).filter(Boolean) : [];
}

function parseJsonObject(value: unknown, label: string, problems: string[]): Record<string, unknown> {
  const raw = text(value);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
    return parsed as Record<string, unknown>;
  } catch {
    problems.push(`${label} must be a JSON object`);
    return {};
  }
}

function parseNumber(value: unknown, label: string, problems: string[], percentage = false): number | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const hasPercent = raw.endsWith("%");
  const normalized = raw.replaceAll(",", "").replace(/%$/, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    problems.push(`${label} must be numeric`);
    return undefined;
  }
  return hasPercent && percentage ? parsed / 100 : parsed;
}

function parseRange(
  row: SheetRow,
  lowField: string,
  highField: string,
  label: string,
  problems: string[],
  percentage = false,
): { low: number; high: number } | undefined {
  const lowRaw = text(row[lowField]);
  const highRaw = text(row[highField]);
  if (!lowRaw && !highRaw) return undefined;
  if (!lowRaw || !highRaw) {
    problems.push(`${label} requires both low and high`);
    return undefined;
  }
  const low = parseNumber(lowRaw, `${label} low`, problems, percentage);
  const high = parseNumber(highRaw, `${label} high`, problems, percentage);
  return low === undefined || high === undefined ? undefined : { low, high };
}

function parseRank(value: unknown, label: string, problems: string[]): number | string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (raw === "tied-1" || raw === "unknown") return raw;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    problems.push(`${label} must be an integer, tied-1, or unknown`);
    return undefined;
  }
  return parsed;
}

function setIfPresent(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== "") target[key] = value;
}

function controlledValue(
  value: unknown,
  label: string,
  allowed: readonly string[],
  problems: string[],
): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (!allowed.includes(raw)) {
    problems.push(`${label} has unsupported value ${JSON.stringify(raw)}`);
    return undefined;
  }
  return raw;
}

function structuredFindings(
  position: string,
  row: SheetRow,
  label: string,
  problems: string[],
): Record<string, unknown> {
  const findings: Record<string, unknown> = { position };
  if (position === "QB") {
    setIfPresent(findings, "week1StartProbability", parseRange(row, "week1_start_probability_low", "week1_start_probability_high", `${label} week1_start_probability`, problems, true));
    setIfPresent(findings, "designedRushesPerGame", parseRange(row, "designed_rushes_per_game_low", "designed_rushes_per_game_high", `${label} designed_rushes_per_game`, problems));
    setIfPresent(findings, "passAttemptsPerGame", parseRange(row, "pass_attempts_per_game_low", "pass_attempts_per_game_high", `${label} pass_attempts_per_game`, problems));
    setIfPresent(findings, "starterLeash", controlledValue(row.starter_leash, `${label} starter_leash`, ["stable", "moderate", "fragile", "unknown"], problems));
    setIfPresent(findings, "competitionStatus", controlledValue(row.competition_status, `${label} competition_status`, COMPETITION_STATUSES, problems));
  } else if (position === "RB") {
    setIfPresent(findings, "carryShare", parseRange(row, "carry_share_low", "carry_share_high", `${label} carry_share`, problems, true));
    setIfPresent(findings, "targetShare", parseRange(row, "target_share_low", "target_share_high", `${label} target_share`, problems, true));
    setIfPresent(findings, "routeShare", parseRange(row, "route_share_low", "route_share_high", `${label} route_share`, problems, true));
    setIfPresent(findings, "goalLineRole", controlledValue(row.goal_line_role, `${label} goal_line_role`, HIGH_VALUE_ROLES, problems));
    setIfPresent(findings, "backfieldRank", parseRank(row.backfield_rank, `${label} backfield_rank`, problems));
    setIfPresent(findings, "handcuffType", controlledValue(row.handcuff_type, `${label} handcuff_type`, ["direct", "ambiguous", "none", "unknown"], problems));
    setIfPresent(findings, "competitionStatus", controlledValue(row.competition_status, `${label} competition_status`, COMPETITION_STATUSES, problems));
  } else if (position === "WR") {
    setIfPresent(findings, "teamTargetRank", parseRank(row.team_target_rank, `${label} team_target_rank`, problems));
    setIfPresent(findings, "targetShare", parseRange(row, "target_share_low", "target_share_high", `${label} target_share`, problems, true));
    setIfPresent(findings, "routeShare", parseRange(row, "route_share_low", "route_share_high", `${label} route_share`, problems, true));
    setIfPresent(findings, "redZoneTargetRole", controlledValue(row.red_zone_target_role, `${label} red_zone_target_role`, HIGH_VALUE_ROLES, problems));
    setIfPresent(findings, "competitionStatus", controlledValue(row.competition_status, `${label} competition_status`, COMPETITION_STATUSES, problems));
  } else if (position === "TE") {
    setIfPresent(findings, "routeShare", parseRange(row, "route_share_low", "route_share_high", `${label} route_share`, problems, true));
    setIfPresent(findings, "targetShare", parseRange(row, "target_share_low", "target_share_high", `${label} target_share`, problems, true));
    setIfPresent(findings, "teRoomRank", parseRank(row.te_room_rank, `${label} te_room_rank`, problems));
    setIfPresent(findings, "teamTargetRank", parseRank(row.team_target_rank, `${label} team_target_rank`, problems));
    setIfPresent(findings, "redZoneTargetRole", controlledValue(row.red_zone_target_role, `${label} red_zone_target_role`, HIGH_VALUE_ROLES, problems));
    setIfPresent(findings, "blockingLoad", controlledValue(row.blocking_load, `${label} blocking_load`, ["heavy", "balanced", "light", "unknown"], problems));
  } else if (position === "K") {
    setIfPresent(findings, "jobSecurityProbability", parseRange(row, "job_security_probability_low", "job_security_probability_high", `${label} job_security_probability`, problems, true));
    setIfPresent(findings, "competitionStatus", controlledValue(row.competition_status, `${label} competition_status`, COMPETITION_STATUSES, problems));
  } else if (position === "D/ST") {
    for (const [sheetField, contractField] of [
      ["pressure_percentile", "pressurePercentile"],
      ["sack_percentile", "sackPercentile"],
      ["takeaway_percentile", "takeawayPercentile"],
      ["points_prevention_percentile", "pointsPreventionPercentile"],
      ["week1_matchup_percentile", "week1MatchupPercentile"],
    ] as const) {
      setIfPresent(findings, contractField, parseNumber(row[sheetField], `${label} ${sheetField}`, problems));
    }
  }
  return findings;
}

function booleanValue(value: unknown, label: string, problems: string[]): boolean {
  const normalized = text(value).toLowerCase();
  if (["yes", "true", "1"].includes(normalized)) return true;
  if (["no", "false", "0"].includes(normalized)) return false;
  problems.push(`${label} must be yes or no`);
  return false;
}

function validateImportEnvelope(value: unknown): ResearchSheetImportV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchSheetImportError(["request must be an object"]);
  }
  const request = value as Partial<ResearchSheetImportV1>;
  const problems: string[] = [];
  if (request.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (!text(request.spreadsheetId) || text(request.spreadsheetId).length > 160) problems.push("spreadsheetId is invalid");
  if (!REQUEST_ID.test(text(request.requestId))) problems.push("requestId is invalid");
  if (!ISO_DATE.test(text(request.requestedAt)) || !Number.isFinite(Date.parse(text(request.requestedAt)))) problems.push("requestedAt is invalid");
  if (!text(request.requestedBy) || text(request.requestedBy).length > 120) problems.push("requestedBy is invalid");
  if (!request.ranges || typeof request.ranges !== "object" || Array.isArray(request.ranges)) problems.push("ranges are invalid");
  if (problems.length) throw new ResearchSheetImportError(problems);
  return request as ResearchSheetImportV1;
}

export function buildResearchPublication(value: unknown, draftKey: string): ResearchPublicationV1 {
  const request = validateImportEnvelope(value);
  const problems: string[] = [];
  const sheet = vocabulary.sheet;
  const snapshots = rowsFor(request.ranges, "Team Snapshots", sheet.teamSnapshotHeaders, problems)
    .filter(({ row }) => text(row.research_run_id) || text(row.snapshot_complete))
    .map(({ row, rowNumber }) => ({
      nflTeam: text(row.nfl_team),
      researchRunId: text(row.research_run_id),
      complete: booleanValue(row.snapshot_complete, rowLabel("Team Snapshots", rowNumber, "snapshot_complete"), problems),
      coveredPlayerKeys: splitList(row.covered_player_keys),
      offenseScoringBand: text(row.offense_scoring_band),
      notes: text(row.coverage_notes),
    }));

  const profileEntries: Array<{ label: string; value: unknown }> = [];
  for (const [position, tab] of Object.entries(PROFILE_TABS)) {
    const headers = [...sheet.profileCommonHeaders, ...sheet.positionFindingHeaders[position as keyof typeof sheet.positionFindingHeaders]];
    for (const { row, rowNumber } of rowsFor(request.ranges, tab, headers, problems)) {
      const playerKey = text(row.player_key);
      const publicationStatus = text(row.publication_status);
      const workflowStatus = text(row.workflow_status);
      if (!playerKey && !publicationStatus) continue;
      if (workflowStatus === "superseded") continue;
      if (!RESEARCH_PUBLICATION_STATUSES.includes(publicationStatus)) {
        problems.push(`${rowLabel(tab, rowNumber)} has invalid publication_status`);
        continue;
      }
      if (workflowStatus) {
        problems.push(`${rowLabel(tab, rowNumber)} is still marked ${workflowStatus}`);
        continue;
      }
      const label = rowLabel(tab, rowNumber);
      const rowPosition = text(row.position);
      if (rowPosition !== position) problems.push(`${label} position must be ${position}`);
      controlledValue(row.research_state, `${label} research_state`, vocabulary.researchStates, problems);
      controlledValue(row.taxonomy_state, `${label} taxonomy_state`, vocabulary.taxonomyStates, problems);
      controlledValue(row.confidence, `${label} confidence`, RESEARCH_CONFIDENCES, problems);
      const researchedRole = text(row.researched_role);
      const approvedRoles = [
        ...vocabulary.rolesByPosition[position as keyof typeof vocabulary.rolesByPosition],
        "taxonomy-gap",
      ];
      if (researchedRole && !approvedRoles.includes(researchedRole)) {
        problems.push(`${label} researched_role has unsupported value ${JSON.stringify(researchedRole)}`);
      }
      const contingentRole = text(row.contingent_researched_role);
      const contingencyTrigger = text(row.contingency_trigger);
      const contingencySummary = text(row.contingency_summary);
      const contingency = contingentRole || contingencyTrigger || contingencySummary
        ? {
            researchedRole: contingentRole || null,
            trigger: contingencyTrigger,
            summary: contingencySummary,
          }
        : null;
      profileEntries.push({
        label,
        value: {
          playerKey,
          nflTeam: text(row.nfl_team),
          profile: {
            schemaVersion: 2,
            profileId: text(row.profile_id),
            researchRunId: text(row.research_run_id),
            evidenceCutoffAt: text(row.evidence_cutoff_at),
            position,
            researchedRole: researchedRole || null,
            researchState: text(row.research_state),
            taxonomyState: text(row.taxonomy_state),
            publicationStatus,
            warRoomHeadline: text(row.war_room_headline),
            currentRoleSummary: text(row.current_role_summary),
            opportunitySummary: text(row.opportunity_summary),
            competitionSummary: text(row.competition_summary),
            availabilitySummary: text(row.availability_summary),
            draftImplication: text(row.draft_implication),
            contingency,
            confidence: text(row.confidence),
            confidenceReason: text(row.confidence_reason),
            alternativesConsidered: splitList(row.alternatives_considered, /\s*(?:;|\|)\s*/),
            unresolvedQuestions: splitList(row.unresolved_questions),
            supportingObservationIds: splitList(row.supporting_observation_ids),
            contradictingObservationIds: splitList(row.contradicting_observation_ids),
            sourceUrls: splitList(row.source_refs),
            structuredFindings: structuredFindings(position, row, label, problems),
            additionalFindings: parseJsonObject(row.additional_findings_json, `${label} additional_findings_json`, problems),
            researchedAt: text(row.researched_at),
            classifiedAt: text(row.classified_at),
            expiresAt: text(row.expires_at) || null,
            classifiedBy: text(row.classified_by),
          },
        },
      });
    }
  }

  if (problems.length) throw new ResearchSheetImportError(problems);
  const publicationBase = {
    schemaVersion: 1,
    draftKey,
    publicationId: `sheet-${request.requestId}`,
    roleVocabularyVersion: ROLE_VOCABULARY_VERSION,
    rubricVersion: vocabulary.rubricVersion,
    publishedAt: request.requestedAt,
    publishedBy: request.requestedBy,
    teamSnapshots: snapshots,
  };
  try {
    validateResearchPublication({ ...publicationBase, profiles: [] });
  } catch (error) {
    throw new ResearchSheetImportError([
      `Team Snapshots: ${error instanceof Error ? error.message : "invalid snapshots"}`,
    ]);
  }
  for (const entry of profileEntries) {
    try {
      validateResearchPublication({ ...publicationBase, profiles: [entry.value] });
    } catch (error) {
      problems.push(`${entry.label}: ${error instanceof Error ? error.message : "invalid profile"}`);
    }
  }
  if (problems.length) throw new ResearchSheetImportError(problems);
  const profiles = profileEntries.map((entry) => entry.value);
  try {
    return validateResearchPublication({
      ...publicationBase,
      profiles,
    });
  } catch (error) {
    throw new ResearchSheetImportError([
      error instanceof Error ? error.message : "publication failed contract validation",
    ]);
  }
}

export const RESEARCH_SHEET_IMPORT_TABS = ["Team Snapshots", ...Object.values(PROFILE_TABS)] as const;
