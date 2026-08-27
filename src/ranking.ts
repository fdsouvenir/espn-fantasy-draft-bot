import type { CatalogPlayerV1, DraftPickEventV1, RecommendationV1 } from "./contracts";

export type RankingContext = {
  currentPick: number | null;
  nextTeamPick: number | null;
  baseDeficits: Partial<Record<"QB" | "RB" | "WR" | "TE", number>>;
  flexOpen: number;
  /** Optional richer context; ranking still degrades deterministically when absent. */
  draftSlotTeamIds?: string[];
  managedTeamId?: string;
  rosterTargets?: Partial<Record<"QB" | "RB" | "WR" | "TE" | "FLEX", number>>;
};

type ScoredPlayer = CatalogPlayerV1 & {
  intrinsicComposite: number;
  projectionPercentile: number;
  marketPercentile: number;
  roleDepthScore: number;
};

const SKILL_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const FLEX_POSITIONS = new Set(["RB", "WR", "TE"]);
const RETURN_SIMULATIONS = 256;
const SYNTHETIC_PREFILTER = 48;
const SYNTHETIC_CANDIDATE_POOL = 16;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function isDefense(position: string): boolean {
  const normalized = position.trim().toUpperCase();
  return normalized === "DST" || normalized === "D/ST";
}

function parseTier(tier: string): number | null {
  const match = tier.trim().toUpperCase().match(/^T?(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]!);
  return Number.isFinite(parsed) ? parsed : null;
}

function roleScore(roleClass: string): number {
  const normalized = roleClass.trim().toLowerCase();
  const scores: Record<string, number> = {
    starter: 100,
    "lead-committee": 84,
    committee: 66,
    "passing-down": 62,
    "goal-line": 58,
    backup: 35,
    specialist: 30,
    unknown: 45,
  };
  if (scores[normalized] !== undefined) return scores[normalized];
  if (/^(qb|rb|wr|te)-unlisted$/.test(normalized)) return 20;
  const depthRole = normalized.match(/^(qb|rb|wr|te)(\d+)$/);
  if (depthRole) {
    const ordinal = Number.parseInt(depthRole[2]!, 10);
    if (ordinal === 1) return 100;
    if (ordinal === 2) return 68;
    if (ordinal === 3) return 42;
    return 22;
  }
  return isDefense(roleClass) || normalized === "k" ? 30 : 45;
}

function depthScore(player: CatalogPlayerV1): number {
  if (player.depthOrdinal === undefined) return 50;
  if (player.depthOrdinal <= 1) return 100;
  if (player.depthOrdinal === 2) return 68;
  if (player.depthOrdinal === 3) return 42;
  return 22;
}

/** Empirical mid-rank percentiles. Equal values always receive equal scores. */
function empiricalPercentiles(
  players: CatalogPlayerV1[],
  value: (player: CatalogPlayerV1) => number | undefined,
  higherIsBetter: boolean,
  withinPosition: boolean,
): Map<string, number> {
  const result = new Map<string, number>();
  const groups = new Map<string, CatalogPlayerV1[]>();
  for (const player of players) {
    const key = withinPosition ? player.position : "ALL";
    groups.set(key, [...(groups.get(key) ?? []), player]);
  }
  for (const group of groups.values()) {
    const known = group
      .filter((player) => Number.isFinite(value(player)))
      .sort((left, right) => {
        const difference = (value(left) ?? 0) - (value(right) ?? 0);
        return difference || lexicalCompare(left.playerId, right.playerId);
      });
    let index = 0;
    while (index < known.length) {
      let end = index;
      const current = value(known[index]!)!;
      while (end + 1 < known.length && value(known[end + 1]!) === current) end += 1;
      const midpoint = (index + end) / 2;
      const ascending = known.length === 1 ? 50 : (midpoint / (known.length - 1)) * 100;
      const percentile = higherIsBetter ? ascending : 100 - ascending;
      for (let cursor = index; cursor <= end; cursor += 1) {
        result.set(known[cursor]!.playerId, percentile);
      }
      index = end + 1;
    }
  }
  return result;
}

function scoreIntrinsic(players: CatalogPlayerV1[]): ScoredPlayer[] {
  const projections = empiricalPercentiles(players, (player) => player.projectedPoints, true, true);
  const market = empiricalPercentiles(players, (player) => player.adp, false, false);
  return players.map((player) => {
    const projectionPercentile = projections.get(player.playerId) ?? 50;
    const marketPercentile = market.get(player.playerId) ?? 50;
    const roleDepthScore = 0.65 * roleScore(player.roleClass) + 0.35 * depthScore(player);
    const opportunity = clamp(
      0.6 * player.opportunityScore + 0.4 * roleDepthScore,
      0,
      100,
    );
    const intrinsicComposite = clamp(
      0.36 * player.intrinsicScore +
        0.24 * projectionPercentile +
        0.32 * opportunity +
        0.08 * marketPercentile,
      0,
      100,
    );
    return {
      ...player,
      intrinsicComposite,
      projectionPercentile,
      marketPercentile,
      roleDepthScore,
    };
  });
}

function interveningPicks(context?: RankingContext): number | null {
  if (!context || context.currentPick === null || context.nextTeamPick === null) return null;
  // `currentPick` is the first unmade pick. If our next pick is current, nobody
  // selects before us; otherwise every slot from current through nextTeamPick-1 does.
  return Math.max(0, context.nextTeamPick - context.currentPick);
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function makePrng(seed: number): () => number {
  let state = seed || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) + 0.5) / 4_294_967_296;
  };
}

function selectionPriority(player: ScoredPlayer, context?: RankingContext): number {
  const quality =
    0.55 * player.intrinsicComposite +
    0.3 * player.opportunityScore +
    0.15 * player.projectionPercentile;
  // ADP is an expected selection order, so use it as an ordering distribution,
  // not as one vote among 1,000 low-probability players. The priority is later
  // normalized inside a bounded plausible set, avoiding overflow at late picks.
  // Historical draft behavior becomes materially noisier after the opening
  // rounds, so dispersion widens with draft stage instead of treating pick 70
  // as if managers were still following the top-five board exactly.
  const marketOrder = player.adp ?? 1_000 - player.marketPercentile * 9;
  const draftStage = Math.max(1, context?.currentPick ?? 1);
  const marketTemperature = 0.7 + (draftStage - 1) * 0.8;
  let priority = -marketOrder / marketTemperature + quality / 25;
  const earlySpecialistPenalty = (player.position === "K" || isDefense(player.position)) &&
    Object.values(context?.baseDeficits ?? {}).some((deficit) => (deficit ?? 0) > 0)
    ? 12
    : 0;
  priority -= earlySpecialistPenalty;
  return priority;
}

type PositionCounts = Record<"QB" | "RB" | "WR" | "TE" | "K" | "D/ST" | "OTHER", number>;

function normalizedPosition(position: string): keyof PositionCounts {
  const normalized = position.trim().toUpperCase();
  if (normalized === "QB" || normalized === "RB" || normalized === "WR" || normalized === "TE" || normalized === "K") return normalized;
  if (isDefense(normalized)) return "D/ST";
  return "OTHER";
}

function emptyCounts(): PositionCounts {
  return { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, "D/ST": 0, OTHER: 0 };
}

function initialRosters(
  picks: DraftPickEventV1[],
  catalog: CatalogPlayerV1[],
): Map<string, PositionCounts> {
  const catalogById = new Map(catalog.map((player) => [player.playerId, player]));
  const rosters = new Map<string, PositionCounts>();
  for (const pick of picks) {
    const player = catalogById.get(pick.playerId);
    if (!player) continue;
    const counts = rosters.get(pick.teamId) ?? emptyCounts();
    counts[normalizedPosition(player.position)] += 1;
    rosters.set(pick.teamId, counts);
  }
  return rosters;
}

function inferredFirstRoundOrder(picks: DraftPickEventV1[]): string[] {
  const firstRound = picks
    .filter((pick) => pick.round === 1)
    .sort((left, right) => left.roundPick - right.roundPick || left.overallPick - right.overallPick);
  const unique: string[] = [];
  for (const pick of firstRound) if (!unique.includes(pick.teamId)) unique.push(pick.teamId);
  return unique;
}

function simulatedOwners(
  picks: DraftPickEventV1[],
  context: RankingContext | undefined,
  count: number,
): string[] {
  if (!context || context.currentPick === null || count === 0) return [];
  if (context.draftSlotTeamIds && context.draftSlotTeamIds.length >= context.currentPick + count - 1) {
    return context.draftSlotTeamIds.slice(context.currentPick - 1, context.currentPick - 1 + count);
  }
  const firstRound = inferredFirstRoundOrder(picks);
  const inferredTeamCount = Math.max(
    firstRound.length,
    ...picks.map((pick) => pick.roundPick),
  );
  if (inferredTeamCount >= 2 && firstRound.length === inferredTeamCount) {
    return Array.from({ length: count }, (_, offset) => {
      const overall = context.currentPick! + offset;
      const roundIndex = Math.floor((overall - 1) / inferredTeamCount);
      const slot = (overall - 1) % inferredTeamCount;
      const orderIndex = roundIndex % 2 === 0 ? slot : inferredTeamCount - slot - 1;
      return firstRound[orderIndex]!;
    });
  }
  // Before a complete first round is observable, we cannot invent team IDs.
  // A shared league-average roster preserves deterministic availability while
  // explicitly avoiding a false claim of team-specific knowledge.
  return Array.from({ length: count }, () => "__league_average__");
}

function teamNeedMultiplier(
  player: ScoredPlayer,
  roster: PositionCounts,
  context?: RankingContext,
): number {
  const position = normalizedPosition(player.position);
  const targets = {
    QB: context?.rosterTargets?.QB ?? 1,
    RB: context?.rosterTargets?.RB ?? 2,
    WR: context?.rosterTargets?.WR ?? 2,
    TE: context?.rosterTargets?.TE ?? 1,
  };
  const rosterSize = Object.values(roster).reduce((total, count) => total + count, 0);
  if (position === "K" || position === "D/ST") return rosterSize < 10 ? 0.08 : roster[position] === 0 ? 1.15 : 0.45;
  if (position === "OTHER") return 0.4;
  const target = targets[position];
  if (roster[position] < target) return 1.55;
  if ((position === "RB" || position === "WR") && roster[position] < target + 2) return 1.05;
  if ((position === "QB" || position === "TE") && roster[position] >= target + 1) return 0.55;
  return 0.78;
}

/**
 * Deterministic Plackett-Luce simulation. Each run assigns every player an
 * exponential-race key (-log(U) / weight); the first m keys are the m players
 * selected without replacement before the managed team's next pick.
 */
function simulateReturnProbabilities(
  players: ScoredPlayer[],
  fullCatalog: CatalogPlayerV1[],
  picks: DraftPickEventV1[],
  context?: RankingContext,
): Map<string, number | null> {
  const result = new Map<string, number | null>();
  const between = interveningPicks(context);
  if (between === null) {
    for (const player of players) result.set(player.playerId, player.returnProbability);
    return result;
  }
  if (between === 0) {
    for (const player of players) result.set(player.playerId, 1);
    return result;
  }
  if (between >= players.length) {
    for (const player of players) result.set(player.playerId, 0);
    return result;
  }

  const ordered = [...players].sort((left, right) => lexicalCompare(left.playerId, right.playerId));
  const priorities = new Map(ordered.map((player) => [player.playerId, selectionPriority(player, context)]));
  const marketOrder = [...ordered].sort(
    (left, right) => priorities.get(right.playerId)! - priorities.get(left.playerId)! || lexicalCompare(left.playerId, right.playerId),
  );
  const removals = new Map(ordered.map((player) => [player.playerId, 0]));
  const owners = simulatedOwners(picks, context, between);
  const baseRosters = initialRosters(picks, fullCatalog);
  const stateKey = [
    context?.currentPick ?? "none",
    ...picks
      .slice()
      .sort((left, right) => left.overallPick - right.overallPick || lexicalCompare(left.eventId, right.eventId))
      .map((pick) => `${pick.overallPick}:${pick.playerId}`),
    ...ordered.map((player) => player.playerId),
    ...owners,
  ].join("|");

  for (let simulation = 0; simulation < RETURN_SIMULATIONS; simulation += 1) {
    const random = makePrng(fnv1a(`${stateKey}|${simulation}`));
    const selected = new Set<string>();
    const rosters = new Map<string, PositionCounts>(
      [...baseRosters.entries()].map(([teamId, roster]) => [teamId, { ...roster }]),
    );
    for (let ownerIndex = 0; ownerIndex < owners.length; ownerIndex += 1) {
      const owner = owners[ownerIndex]!;
      const roster = rosters.get(owner) ?? emptyCounts();
      let choice: ScoredPlayer | null = null;
      let bestKey = Number.POSITIVE_INFINITY;
      const plausible = marketOrder
        .filter((candidate) => !selected.has(candidate.playerId))
        .slice(0, SYNTHETIC_PREFILTER)
        .map((candidate) => ({
          candidate,
          priority: priorities.get(candidate.playerId)! + Math.log(teamNeedMultiplier(candidate, roster, context)),
        }))
        .sort((left, right) => right.priority - left.priority || lexicalCompare(left.candidate.playerId, right.candidate.playerId))
        .slice(0, SYNTHETIC_CANDIDATE_POOL);
      const maximumPriority = plausible[0]?.priority ?? 0;
      for (const { candidate, priority } of plausible) {
        const weight = Math.exp(priority - maximumPriority);
        const key = -Math.log(random()) / weight;
        if (key < bestKey || (key === bestKey && choice && lexicalCompare(candidate.playerId, choice.playerId) < 0)) {
          bestKey = key;
          choice = candidate;
        }
      }
      if (!choice) break;
      selected.add(choice.playerId);
      removals.set(choice.playerId, removals.get(choice.playerId)! + 1);
      roster[normalizedPosition(choice.position)] += 1;
      rosters.set(owner, roster);
    }
  }

  for (const player of ordered) {
    result.set(player.playerId, round(1 - removals.get(player.playerId)! / RETURN_SIMULATIONS, 3));
  }
  return result;
}

function tierScarcity(player: ScoredPlayer, players: ScoredPlayer[], context?: RankingContext): number {
  const between = interveningPicks(context);
  if (between === null || between === 0) return 0;
  const samePosition = players.filter((candidate) => candidate.position === player.position);
  const sameTier = samePosition.filter((candidate) => candidate.tier === player.tier);
  const tier = parseTier(player.tier);
  let nextTier: ScoredPlayer[] = [];
  if (tier !== null) {
    const nextTierNumber = Math.min(
      ...samePosition
        .map((candidate) => parseTier(candidate.tier))
        .filter((candidateTier): candidateTier is number => candidateTier !== null && candidateTier > tier),
    );
    if (Number.isFinite(nextTierNumber)) {
      nextTier = samePosition.filter((candidate) => parseTier(candidate.tier) === nextTierNumber);
    }
  } else {
    // Editorial tiers such as RB-A/WR-B are opaque labels. Determine the next
    // tier by its score ordering rather than pretending the label has universal semantics.
    const currentAverage = sameTier.reduce((sum, candidate) => sum + candidate.intrinsicComposite, 0) / sameTier.length;
    const otherGroups = new Map<string, ScoredPlayer[]>();
    for (const candidate of samePosition) {
      if (candidate.tier === player.tier) continue;
      otherGroups.set(candidate.tier, [...(otherGroups.get(candidate.tier) ?? []), candidate]);
    }
    nextTier = [...otherGroups.values()]
      .filter((group) => group.reduce((sum, candidate) => sum + candidate.intrinsicComposite, 0) / group.length < currentAverage)
      .sort((left, right) => {
        const leftAverage = left.reduce((sum, candidate) => sum + candidate.intrinsicComposite, 0) / left.length;
        const rightAverage = right.reduce((sum, candidate) => sum + candidate.intrinsicComposite, 0) / right.length;
        return rightAverage - leftAverage || lexicalCompare(left[0]!.tier, right[0]!.tier);
      })[0] ?? [];
  }
  if (nextTier.length === 0) return 0;
  const currentAverage = sameTier.reduce((sum, candidate) => sum + candidate.intrinsicComposite, 0) / sameTier.length;
  const nextAverage = nextTier.reduce((sum, candidate) => sum + candidate.intrinsicComposite, 0) / nextTier.length;
  const tierDrop = clamp((currentAverage - nextAverage) / 15, 0, 1);
  const drainPressure = clamp(between / Math.max(1, sameTier.length * 3), 0, 1);
  return 6 * tierDrop * drainPressure;
}

function rosterFit(player: ScoredPlayer, context?: RankingContext): number {
  if (!context) return 0;
  if (!SKILL_POSITIONS.has(player.position)) {
    const startersOpen = Object.values(context.baseDeficits).some((deficit) => (deficit ?? 0) > 0);
    return startersOpen || context.flexOpen > 0 ? -24 : -5;
  }
  const position = player.position as "QB" | "RB" | "WR" | "TE";
  const deficit = context.baseDeficits[position] ?? 0;
  let fit = Math.min(6, deficit * 4);
  if (context.flexOpen > 0 && FLEX_POSITIONS.has(player.position)) fit += 2;
  const otherStarterOpen = Object.entries(context.baseDeficits).some(
    ([candidatePosition, candidateDeficit]) => candidatePosition !== player.position && (candidateDeficit ?? 0) > 0,
  );
  if (deficit === 0 && otherStarterOpen) fit -= 3;
  return clamp(fit, -6, 8);
}

function injuryPenalty(player: CatalogPlayerV1): { penalty: number; status: string } {
  const status = player.injuryStatus?.trim().toUpperCase() ?? "";
  if (["OUT", "IR", "PUP", "NFI", "SUSPENSION", "SUSPENDED"].includes(status)) return { penalty: 14, status };
  if (status === "DOUBTFUL") return { penalty: 8, status };
  if (status === "QUESTIONABLE") return { penalty: 3, status };
  return { penalty: 0, status };
}

function contextualize(
  player: ScoredPlayer,
  allPlayers: ScoredPlayer[],
  returnProbability: number | null,
  context?: RankingContext,
): CatalogPlayerV1 {
  const scarcity = tierScarcity(player, allPlayers, context);
  const fit = rosterFit(player, context);
  const marketValue = context?.currentPick !== null && context?.currentPick !== undefined && player.adp !== undefined
    ? clamp((context.currentPick - player.adp) * 0.2, -5, 5)
    : 0;
  const returnUrgency = returnProbability === null || returnProbability >= 0.75
    ? 0
    : 8 * clamp((0.75 - returnProbability) / 0.75, 0, 1);
  const injury = injuryPenalty(player);
  const reasons = [...player.reasons];
  const risks = [...player.risks];

  if (player.projectedPoints !== undefined) reasons.push("Projection contributes to intrinsic value");
  if (player.opportunityScore >= 70 || player.roleDepthScore >= 75) reasons.push("Opportunity and depth role support workload");
  if (scarcity >= 1) reasons.push("Tier may close before the next team pick");
  if (fit >= 3) reasons.push(`Open ${player.position} starter or flex slot`);
  if (marketValue >= 1) reasons.push(`Fell past ESPN ADP ${player.adp?.toFixed(1)}`);
  if (returnUrgency >= 2) reasons.push("Unlikely to return through intervening picks");
  if (injury.penalty > 0) risks.push(`ESPN injury status: ${injury.status}`);
  if (fit <= -10 && (player.position === "K" || isDefense(player.position))) risks.push("K/DST suppressed while skill-position slots remain open");

  return {
    ...player,
    intrinsicScore: round(player.intrinsicComposite, 2),
    pickNowScore: round(
      clamp(
        0.78 * player.intrinsicComposite + scarcity + fit + marketValue + returnUrgency -
          injury.penalty,
        0,
        100,
      ),
      2,
    ),
    returnProbability,
    reasons: unique(reasons),
    risks: unique(risks),
  };
}

export function rankAvailable(
  catalog: CatalogPlayerV1[],
  picks: DraftPickEventV1[],
  context?: RankingContext,
): RecommendationV1[] {
  const drafted = new Set(picks.map((pick) => pick.playerId));
  const availableCatalog = catalog.filter((player) => !drafted.has(player.playerId));
  const intrinsicallyScored = scoreIntrinsic(availableCatalog);
  const probabilities = simulateReturnProbabilities(intrinsicallyScored, catalog, picks, context);
  const available = intrinsicallyScored
    .map((player) => contextualize(player, intrinsicallyScored, probabilities.get(player.playerId) ?? null, context))
    .sort((left, right) =>
      right.pickNowScore - left.pickNowScore ||
      right.intrinsicScore - left.intrinsicScore ||
      right.opportunityScore - left.opportunityScore ||
      (right.projectedPoints ?? -1) - (left.projectedPoints ?? -1) ||
      lexicalCompare(left.playerId, right.playerId),
    );
  const intrinsicOrder = [...available].sort((left, right) =>
    right.intrinsicScore - left.intrinsicScore ||
    right.opportunityScore - left.opportunityScore ||
    (right.projectedPoints ?? -1) - (left.projectedPoints ?? -1) ||
    lexicalCompare(left.playerId, right.playerId),
  );
  const intrinsicRanks = new Map(intrinsicOrder.map((player, index) => [player.playerId, index + 1]));
  return available.map((player, index) => ({
    ...player,
    intrinsicRank: intrinsicRanks.get(player.playerId) ?? available.length,
    pickNowRank: index + 1,
  }));
}
