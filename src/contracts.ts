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
  health: DraftHealth;
  pinnedCatalogVersion: string | null;
  serverTime: string;
};
