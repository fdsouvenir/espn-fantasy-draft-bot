export type DraftPickEventV1 = {
  schemaVersion: 1;
  eventId: string;
  overallPick: number;
  round: number;
  roundPick: number;
  teamId: string;
  playerId: string;
  source: "espn" | "manual";
  providerObservedAt: string | null;
  ingestorObservedAt: string;
};

export type DraftStateV1 = {
  inProgress: boolean;
  drafted: boolean;
  totalPickSlots: number;
};

export type IngestBatchV1 = {
  schemaVersion: 1;
  draftKey: string;
  ingestorInstanceId: string;
  capturedAt: string;
  cursor: { lastOverallPick: number };
  draftState: DraftStateV1;
  events: DraftPickEventV1[];
};

export type IngestAck = {
  revision: number;
  accepted: number;
  deduped: number;
  lastOverallPick: number;
  missingOverallPicks: number[];
  serverTime: string;
};

export type CatalogPlayerV1 = {
  playerId: string;
  name: string;
  position: string;
  nflTeam: string;
  tier: string;
  roleClass: string;
  opportunityScore: number;
  intrinsicScore: number;
  pickNowScore: number;
  returnProbability: number | null;
  reasons: string[];
  risks: string[];
  adp?: number;
  projectedPoints?: number;
  percentOwned?: number;
  auctionValue?: number;
  byeWeek?: number;
  eligibleSlots?: number[];
  injuryStatus?: string;
  depthPosition?: string;
  depthOrdinal?: number;
  /** Verl's conclusion. This never participates in ranking calculations. */
  researchProfile?: ResearchProfileV2;
  /** Presentation-only grouping derived from researchedRole. */
  researchInventoryBucket?: string;
};

export type ResearchFindingValue = string | number | boolean | null | string[];

export type ResearchPosition = "QB" | "RB" | "WR" | "TE" | "K" | "D/ST";
export type ResearchState =
  | "complete"
  | "insufficient-evidence"
  | "conflicting-evidence"
  | "stale";
export type TaxonomyState = "matched" | "taxonomy-gap";
export type ResearchConfidence = "high" | "medium" | "low" | "unknown";
export type ResearchPublicationStatus = "published" | "needs-review";
export type ResearchCompetitionStatus = "settled" | "leaning" | "open" | "unknown";
export type ResearchRank = number | "tied-1" | "unknown";
export type ResearchRange = { low: number; high: number };

export type RbResearchFindings = {
  position: "RB";
  carryShare?: ResearchRange;
  routeShare?: ResearchRange;
  goalLineRole?: "primary" | "shared" | "secondary" | "none" | "unknown";
  backfieldRank?: ResearchRank;
  handcuffType?: "direct" | "ambiguous" | "none" | "unknown";
  competitionStatus?: ResearchCompetitionStatus;
};

export type WrResearchFindings = {
  position: "WR";
  teamTargetRank?: ResearchRank;
  targetShare?: ResearchRange;
  routeShare?: ResearchRange;
  redZoneTargetRole?: "primary" | "shared" | "secondary" | "none" | "unknown";
  competitionStatus?: ResearchCompetitionStatus;
};

export type TeResearchFindings = {
  position: "TE";
  routeShare?: ResearchRange;
  targetShare?: ResearchRange;
  teRoomRank?: ResearchRank;
  teamTargetRank?: ResearchRank;
  redZoneTargetRole?: "primary" | "shared" | "secondary" | "none" | "unknown";
  blockingLoad?: "heavy" | "balanced" | "light" | "unknown";
};

export type QbResearchFindings = {
  position: "QB";
  week1StartProbability?: ResearchRange;
  designedRushesPerGame?: ResearchRange;
  passAttemptsPerGame?: ResearchRange;
  starterLeash?: "stable" | "moderate" | "fragile" | "unknown";
  competitionStatus?: ResearchCompetitionStatus;
};

export type KResearchFindings = {
  position: "K";
  jobSecurityProbability?: ResearchRange;
  offenseScoringBand?: "strong" | "average" | "weak" | "unknown";
  competitionStatus?: ResearchCompetitionStatus;
};

export type DstResearchFindings = {
  position: "D/ST";
  pressurePercentile?: number;
  sackPercentile?: number;
  takeawayPercentile?: number;
  pointsPreventionPercentile?: number;
  week1MatchupPercentile?: number;
};

export type PositionResearchFindings =
  | QbResearchFindings
  | RbResearchFindings
  | WrResearchFindings
  | TeResearchFindings
  | KResearchFindings
  | DstResearchFindings;

/**
 * Verl's published conclusion. The Worker transports this profile; it does not
 * derive, score, or reinterpret any of these fields.
 */
export type ResearchProfileV2 = {
  schemaVersion: 2;
  profileId: string;
  position: ResearchPosition;
  researchedRole: string | null;
  researchState: ResearchState;
  unknownReason: Exclude<ResearchState, "complete"> | null;
  taxonomyState: TaxonomyState;
  publicationStatus: ResearchPublicationStatus;
  warRoomHeadline: string;
  currentRoleSummary: string;
  opportunitySummary: string;
  competitionSummary: string;
  availabilitySummary: string;
  draftImplication: string;
  contingency: {
    researchedRole: string | null;
    trigger: string;
    summary: string;
  } | null;
  confidence: ResearchConfidence;
  confidenceReason: string;
  alternativesConsidered: string[];
  unresolvedQuestions: string[];
  supportingObservationIds: string[];
  contradictingObservationIds: string[];
  sourceUrls: string[];
  structuredFindings: PositionResearchFindings;
  additionalFindings: Record<string, ResearchFindingValue>;
  researchedAt: string;
  classifiedAt: string;
  expiresAt: string;
  classifiedBy: string;
};

export type TeamResearchSnapshotV1 = {
  nflTeam: string;
  complete: boolean;
  coveredPlayerKeys: string[];
  notes: string;
};

export type ResearchPublicationPlayerV1 = {
  playerKey: string;
  nflTeam: string;
  profile: ResearchProfileV2;
};

export type ResearchPublicationV1 = {
  schemaVersion: 1;
  draftKey: string;
  publicationId: string;
  roleVocabularyVersion: string;
  rubricVersion: string | null;
  publishedAt: string;
  publishedBy: string;
  teamSnapshots: TeamResearchSnapshotV1[];
  profiles: ResearchPublicationPlayerV1[];
};

export type ResearchAuditWarningV1 = {
  code: string;
  playerKey: string | null;
  nflTeam: string | null;
  message: string;
};

export type ResearchPublicationAckV1 = {
  publicationId: string;
  researchRevision: number;
  changed: boolean;
  profileCount: number;
  warnings: ResearchAuditWarningV1[];
  serverTime: string;
};

export type ResearchSnapshotV1 = {
  publicationId: string;
  researchRevision: number;
  roleVocabularyVersion: string;
  rubricVersion: string | null;
  publishedAt: string;
  publishedBy: string;
  profileCount: number;
  warnings: ResearchAuditWarningV1[];
};

export type StarterPosition = "QB" | "RB" | "WR" | "TE";
export type RosterTargetsV1 = Record<StarterPosition | "FLEX", number>;

export type DraftInitV1 = {
  schemaVersion: 1;
  draftKey: string;
  displayName?: string;
  expectedTeams: number;
  expectedRounds: number;
  totalPickSlots: number;
  managedTeamId: string;
  draftSlotTeamIds: string[];
  rosterTargets: RosterTargetsV1;
  pinnedCatalogVersion: string;
  catalog: CatalogPlayerV1[];
};

export type DraftHealth = {
  revision: number;
  status: "uninitialized" | "pre_draft" | "live" | "complete";
  lastIngestAt: string | null;
  lastOverallPick: number;
  sourceCursorLastOverallPick: number;
  totalPickSlots: number;
  missingOverallPicks: number[];
  hasGap: boolean;
  conflictCount: number;
  connectionCount: number;
  ingestorStatus: "never_seen" | "healthy" | "stale" | "dead";
  stale: boolean;
  staleAfterSeconds: number;
  deadAfterSeconds: number;
};

export type RecommendationV1 = CatalogPlayerV1 & {
  intrinsicRank: number;
  pickNowRank: number;
};

export type ManagedRosterEntryV1 = CatalogPlayerV1 & {
  overallPick: number;
};

export type DraftNeedsV1 = {
  targets: RosterTargetsV1;
  filled: Record<StarterPosition, number>;
  baseDeficits: Record<StarterPosition, number>;
  flexEligibleAfterBase: number;
  flexOpen: number;
  flexMet: boolean;
};

export type DraftClockV1 = {
  current: number | null;
  round: number | null;
  roundPick: number | null;
  nextTeamPick: number | null;
  picksAway: number | null;
};

export type DraftSnapshot = {
  schemaVersion: 1;
  draftKey: string;
  revision: number;
  status: DraftHealth["status"];
  picks: DraftPickEventV1[];
  rosters: Record<string, DraftPickEventV1[]>;
  managedRoster: ManagedRosterEntryV1[];
  needs: DraftNeedsV1;
  draft: DraftClockV1;
  available: RecommendationV1[];
  recommendations: RecommendationV1[];
  research: ResearchSnapshotV1 | null;
  health: DraftHealth;
  pinnedCatalogVersion: string | null;
  serverTime: string;
};
