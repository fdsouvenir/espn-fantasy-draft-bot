import type {
  CatalogPlayerV1,
  PositionResearchFindings,
  ResearchAuditWarningV1,
  ResearchPosition,
  ResearchProfileV2,
  ResearchPublicationV1,
  ResearchRange,
  TeamResearchSnapshotV1,
} from "./contracts.js";
import vocabulary from "../config/research-vocabulary.json" with { type: "json" };

export const ROLE_VOCABULARY_VERSION = vocabulary.roleVocabularyVersion;
export const RESEARCH_PUBLICATION_STATUSES = vocabulary.publicationStatuses;

export const RESEARCHED_ROLES_BY_POSITION = vocabulary.rolesByPosition as Record<
  ResearchPosition,
  readonly string[]
>;

const INVENTORY_BUCKETS: Record<ResearchPosition, Record<string, string>> = {
  QB: {
    "locked-dual-threat": "Locked starter",
    "locked-mobile-starter": "Locked starter",
    "locked-volume-passer": "Locked starter",
    "locked-pocket-starter": "Locked starter",
    "bridge-starter": "Fragile starter",
    "competition-favorite": "Competition",
    "open-competition": "Competition",
    "contingent-backup": "Contingent",
    reserve: "Reserve",
  },
  RB: {
    "three-down-bellcow": "Actual starter",
    "clear-lead": "Actual starter",
    "early-down-lead": "Actual starter",
    "committee-1a": "Committee lead",
    "committee-1b": "Committee partner",
    "passing-down-specialist": "Specialist",
    "goal-line-specialist": "Specialist",
    "blocking-fullback-specialist": "Reserve",
    "contingent-backup": "Contingent",
    "reserve-change-of-pace": "Reserve",
  },
  WR: {
    "clear-target-leader": "Target leader",
    "co-target-leader": "Target leader",
    "slot-volume": "Volume role",
    "every-down-secondary": "Full-time secondary",
    "low-volume-full-time": "Full-time secondary",
    "field-stretcher": "Specialist",
    "red-zone-specialist": "Specialist",
    "rotational-receiver": "Rotation",
  },
  TE: {
    "passing-game-focal-point": "Receiving difference-maker",
    "every-down-receiving-te": "Receiving difference-maker",
    "route-heavy-starter": "Stable route volume",
    "committee-receiving-lead": "Committee lead",
    "red-zone-specialist": "Specialist",
    "inline-blocking-starter": "Blocking risk",
    "rotational-te": "Rotation",
    "contingent-backup": "Contingent",
  },
  K: {
    "locked-high-volume-kicker": "Secure job",
    "locked-average-volume-kicker": "Secure job",
    "locked-low-volume-kicker": "Secure job",
    "competition-favorite": "Competition",
    "open-competition": "Competition",
    "temporary-replacement": "Temporary",
    "reserve-or-unsigned": "No job",
  },
  "D/ST": {
    "every-week-disruptive-unit": "Every-week unit",
    "pressure-upside-unit": "Pressure upside",
    "turnover-volatile-unit": "Volatile",
    "opening-schedule-streamer": "Streamer",
    "week-one-streamer": "Streamer",
    "matchup-only-unit": "Matchup only",
    "low-ceiling-unit": "Low ceiling",
  },
};

export function normalizeResearchPosition(position: string): ResearchPosition | null {
  const normalized = position.trim().toUpperCase();
  if (normalized === "DST" || normalized === "D/ST") return "D/ST";
  return ["QB", "RB", "WR", "TE", "K"].includes(normalized)
    ? normalized as ResearchPosition
    : null;
}

export function researchInventoryBucket(position: string, researchedRole: string | null): string | null {
  const normalized = normalizeResearchPosition(position);
  if (!normalized || !researchedRole) return null;
  if (researchedRole === "taxonomy-gap") return "Taxonomy gap";
  return INVENTORY_BUCKETS[normalized][researchedRole] ?? null;
}

export function roleAllowed(position: ResearchPosition, role: string): boolean {
  return role === "taxonomy-gap" || RESEARCHED_ROLES_BY_POSITION[position].includes(role);
}

function playerIdFromKey(playerKey: string): string | null {
  const match = /^espn:(-?\d{1,18})$/.exec(playerKey);
  if (!match?.[1] || match[1] === "-1") return null;
  return match[1];
}

function rangeLow(value: ResearchRange | undefined): number | null {
  return value?.low ?? null;
}

function teamSnapshotByTeam(publication: ResearchPublicationV1): Map<string, TeamResearchSnapshotV1> {
  return new Map(publication.teamSnapshots.map((snapshot) => [snapshot.nflTeam, snapshot]));
}

function warning(
  code: string,
  message: string,
  playerKey: string | null = null,
  nflTeam: string | null = null,
): ResearchAuditWarningV1 {
  return { code, playerKey, nflTeam, message };
}

function findingsForTeam(
  publication: ResearchPublicationV1,
  nflTeam: string,
): Array<{ playerKey: string; profile: ResearchProfileV2; findings: PositionResearchFindings }> {
  return publication.profiles
    .filter((entry) => entry.nflTeam === nflTeam)
    .map((entry) => ({ playerKey: entry.playerKey, profile: entry.profile, findings: entry.profile.structuredFindings }));
}

function definiteRoleContradictions(publication: ResearchPublicationV1): ResearchAuditWarningV1[] {
  const warnings: ResearchAuditWarningV1[] = [];
  for (const entry of publication.profiles) {
    const { profile, playerKey, nflTeam } = entry;
    const role = profile.researchedRole;
    const findings = profile.structuredFindings;
    if (profile.taxonomyState === "taxonomy-gap") {
      warnings.push(warning("taxonomy-gap", "Verl found a role the current vocabulary cannot express.", playerKey, nflTeam));
    }
    if (profile.publicationStatus === "needs-review") {
      warnings.push(warning("needs-review", "Verl marked this conclusion for exception review.", playerKey, nflTeam));
    }
    if (profile.expiresAt !== null && Date.parse(profile.expiresAt) <= Date.parse(publication.publishedAt)) {
      warnings.push(warning("profile-stale", "The profile was already expired when this batch was published.", playerKey, nflTeam));
    }
    if (findings.position === "WR" && role === "clear-target-leader") {
      const rank = findings.teamTargetRank;
      if (rank !== undefined && rank !== 1 && rank !== "tied-1" && rank !== "unknown") {
        warnings.push(warning("role-metric-conflict", "Clear target leader conflicts with a team target rank below first.", playerKey, nflTeam));
      }
    }
    if (findings.position === "WR" && role === "co-target-leader") {
      const rank = findings.teamTargetRank;
      if (typeof rank === "number" && rank > 2) {
        warnings.push(warning("role-metric-conflict", "Co-target leader conflicts with a team target rank below second.", playerKey, nflTeam));
      }
    }
    if (findings.position === "TE" && role === "passing-game-focal-point") {
      const rank = findings.teamTargetRank;
      if (typeof rank === "number" && rank > 2) {
        warnings.push(warning("role-metric-conflict", "Passing-game focal point conflicts with a team target rank below second.", playerKey, nflTeam));
      }
    }
    if (findings.position === "TE" && role === "committee-receiving-lead") {
      const rank = findings.teRoomRank;
      if (rank !== undefined && rank !== 1 && rank !== "tied-1" && rank !== "unknown") {
        warnings.push(warning("role-metric-conflict", "Committee receiving lead conflicts with a TE-room rank below first.", playerKey, nflTeam));
      }
    }
    if (findings.position === "RB" && ["three-down-bellcow", "clear-lead", "early-down-lead"].includes(role ?? "")) {
      const rank = findings.backfieldRank;
      if (rank !== undefined && rank !== 1 && rank !== "tied-1" && rank !== "unknown") {
        warnings.push(warning("role-metric-conflict", "Starting-back role conflicts with a backfield rank below first.", playerKey, nflTeam));
      }
    }
    if (findings.position === "QB" && role?.startsWith("locked-")) {
      const probability = findings.week1StartProbability;
      if (probability && probability.high < 0.9) {
        warnings.push(warning("role-metric-conflict", "Locked starter conflicts with a Week 1 start range entirely below 0.90.", playerKey, nflTeam));
      }
    }
    if (findings.position === "K" && role?.startsWith("locked-")) {
      const probability = findings.jobSecurityProbability;
      if (probability && probability.high < 0.95) {
        warnings.push(warning("role-metric-conflict", "Locked kicker conflicts with a job-security range entirely below 0.95.", playerKey, nflTeam));
      }
    }
    if (findings.position === "D/ST" && role === "every-week-disruptive-unit") {
      if (
        (findings.pressurePercentile !== undefined && findings.pressurePercentile < 25) ||
        (findings.pointsPreventionPercentile !== undefined && findings.pointsPreventionPercentile < 25)
      ) {
        warnings.push(warning("role-metric-conflict", "Every-week disruptive unit conflicts with bottom-quartile pressure or points prevention.", playerKey, nflTeam));
      }
    }
    if (
      findings.position === "D/ST" &&
      role === "week-one-streamer" &&
      findings.week1MatchupPercentile !== undefined &&
      findings.week1MatchupPercentile < 25
    ) {
      warnings.push(warning("role-metric-conflict", "Week 1 streamer conflicts with a bottom-quartile Week 1 matchup.", playerKey, nflTeam));
    }
  }
  return warnings;
}

export function auditResearchPublication(
  publication: ResearchPublicationV1,
  catalog: CatalogPlayerV1[],
): ResearchAuditWarningV1[] {
  const warnings = definiteRoleContradictions(publication);
  const catalogById = new Map(catalog.map((player) => [player.playerId, player]));
  const snapshots = teamSnapshotByTeam(publication);

  for (const entry of publication.profiles) {
    const playerId = playerIdFromKey(entry.playerKey);
    const player = playerId ? catalogById.get(playerId) : undefined;
    if (!player) throw new Error("invalid_research_player_key");
    const catalogPosition = normalizeResearchPosition(player.position);
    if (catalogPosition !== entry.profile.position || player.nflTeam !== entry.nflTeam) {
      throw new Error("invalid_research_player_identity");
    }
    const findings = entry.profile.structuredFindings;
    const requiresWholeTeam =
      (findings.position === "WR" && findings.teamTargetRank !== undefined) ||
      (findings.position === "TE" && (findings.teamTargetRank !== undefined || findings.teRoomRank !== undefined)) ||
      (findings.position === "RB" && findings.backfieldRank !== undefined);
    if (requiresWholeTeam && !snapshots.get(entry.nflTeam)?.complete) {
      warnings.push(warning(
        "team-snapshot-incomplete",
        "A team-relative rank was published before the team snapshot was marked complete.",
        entry.playerKey,
        entry.nflTeam,
      ));
    }
    const teamSnapshot = snapshots.get(entry.nflTeam);
    if (teamSnapshot && teamSnapshot.researchRunId !== entry.profile.researchRunId) {
      warnings.push(warning(
        "research-run-mismatch",
        "The profile and its team snapshot were produced by different research runs.",
        entry.playerKey,
        entry.nflTeam,
      ));
    }
  }

  for (const snapshot of publication.teamSnapshots) {
    const teamEntries = findingsForTeam(publication, snapshot.nflTeam);
    if (snapshot.complete) {
      const publishedKeys = new Set(teamEntries.map((entry) => entry.playerKey));
      const missing = snapshot.coveredPlayerKeys.filter((playerKey) => !publishedKeys.has(playerKey));
      if (missing.length > 0) {
        warnings.push(warning(
          "team-coverage-incomplete",
          `The complete team snapshot names ${missing.length} player${missing.length === 1 ? "" : "s"} without a published profile.`,
          null,
          snapshot.nflTeam,
        ));
      }
    }
    const targetLow = teamEntries.reduce((sum, entry) => {
      const findings = entry.findings;
      if (findings.position === "RB" || findings.position === "WR" || findings.position === "TE") {
        return sum + (rangeLow(findings.targetShare) ?? 0);
      }
      return sum;
    }, 0);
    if (targetLow > 1.001) {
      warnings.push(warning("target-share-overallocated", "Published target-share floors exceed 100% for this team.", null, snapshot.nflTeam));
    }
    const carryLow = teamEntries.reduce((sum, entry) => {
      const findings = entry.findings;
      return findings.position === "RB" ? sum + (rangeLow(findings.carryShare) ?? 0) : sum;
    }, 0);
    if (carryLow > 1.001) {
      warnings.push(warning("rb-carry-share-overallocated", "Published RB carry-share floors exceed 100% for this team.", null, snapshot.nflTeam));
    }
  }
  return warnings;
}
