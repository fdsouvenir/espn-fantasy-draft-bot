import { describe, expect, it } from "vitest";
import type { CatalogPlayerV1, DraftPickEventV1 } from "../src/contracts";
import { type RankingContext, rankAvailable } from "../src/ranking";

function player(overrides: Partial<CatalogPlayerV1> & Pick<CatalogPlayerV1, "playerId" | "position">): CatalogPlayerV1 {
  return {
    name: overrides.playerId,
    nflTeam: "CHI",
    tier: "3",
    roleClass: "starter",
    opportunityScore: 65,
    intrinsicScore: 65,
    pickNowScore: 65,
    returnProbability: null,
    reasons: [],
    risks: [],
    ...overrides,
  };
}

const neutralContext: RankingContext = {
  currentPick: 25,
  nextTeamPick: 40,
  baseDeficits: { QB: 0, RB: 0, WR: 0, TE: 0 },
  flexOpen: 0,
};

describe("rankAvailable", () => {
  it("removes drafted players exactly once, including signed D/ST IDs", () => {
    const catalog = [player({ playerId: "1", position: "RB" }), player({ playerId: "-16007", position: "D/ST" })];
    const pick: DraftPickEventV1 = {
      schemaVersion: 1,
      eventId: "a".repeat(64),
      overallPick: 1,
      round: 1,
      roundPick: 1,
      teamId: "1",
      playerId: "-16007",
      source: "espn",
      providerObservedAt: null,
      ingestorObservedAt: "2026-08-11T12:00:00.000Z",
    };
    expect(rankAvailable(catalog, [pick]).map((candidate) => candidate.playerId)).toEqual(["1"]);
  });

  it("materially rewards stronger projections when other inputs are equal", () => {
    const ranked = rankAvailable([
      player({ playerId: "low", position: "WR", projectedPoints: 100 }),
      player({ playerId: "high", position: "WR", projectedPoints: 240 }),
    ], [], neutralContext);
    expect(ranked[0]?.playerId).toBe("high");
    expect(ranked[0]!.intrinsicScore - ranked[1]!.intrinsicScore).toBeGreaterThan(15);
  });

  it("recognizes production RB1 and RB-unlisted depth-role values", () => {
    const ranked = rankAvailable([
      player({ playerId: "listed", position: "RB", roleClass: "RB1", depthOrdinal: 1 }),
      player({ playerId: "unlisted", position: "RB", roleClass: "RB-unlisted" }),
    ], [], neutralContext);
    expect(ranked[0]?.playerId).toBe("listed");
    expect(ranked[0]!.intrinsicScore - ranked[1]!.intrinsicScore).toBeGreaterThan(8);
  });

  it("transports Verl research without turning it into an implicit ranking adjustment", () => {
    const researchProfile = {
      schemaVersion: 2 as const,
      profileId: "profile-wr-researched",
      researchRunId: "run-2026-08-26",
      evidenceCutoffAt: "2026-08-26T17:30:00.000Z",
      position: "WR" as const,
      researchedRole: "clear-target-leader",
      researchState: "complete" as const,
      taxonomyState: "matched" as const,
      publicationStatus: "published" as const,
      warRoomHeadline: "Clear first read despite the weak offense",
      currentRoleSummary: "Verl classified the player as the current target leader.",
      opportunitySummary: "Full-time routes with the first read on key downs.",
      competitionSummary: "No teammate has matched the observed first-team usage.",
      availabilitySummary: "Practicing in full.",
      draftImplication: "Treat as a volume WR1 rather than an ADP duplicate.",
      contingency: null,
      confidence: "high" as const,
      confidenceReason: "Multiple current primary reports agree.",
      alternativesConsidered: [],
      unresolvedQuestions: [],
      supportingObservationIds: ["obs-1"],
      contradictingObservationIds: [],
      sourceUrls: ["https://example.com/report"],
      structuredFindings: {
        position: "WR" as const,
        teamTargetRank: 1,
        targetShare: { low: 0.21, high: 0.28 },
        routeShare: { low: 0.78, high: 0.91 },
      },
      additionalFindings: { alignment: "X receiver" },
      researchedAt: "2026-08-26T18:00:00.000Z",
      classifiedAt: "2026-08-26T18:30:00.000Z",
      expiresAt: "2026-08-30T18:30:00.000Z",
      classifiedBy: "Verl",
    };
    const ranked = rankAvailable([
      player({ playerId: "plain", position: "WR" }),
      player({ playerId: "researched", position: "WR", researchProfile }),
    ], [], { ...neutralContext, currentPick: 25, nextTeamPick: 25 });
    const plain = ranked.find((candidate) => candidate.playerId === "plain")!;
    const researched = ranked.find((candidate) => candidate.playerId === "researched")!;
    expect(researched.pickNowScore).toBe(plain.pickNowScore);
    expect(researched.researchProfile).toEqual(researchProfile);
  });

  it("uses opportunity and depth role to elevate a lesser-known starter", () => {
    const ranked = rankAvailable([
      player({ playerId: "starter", name: "Quiet Starter", position: "RB", roleClass: "starter", depthOrdinal: 1, opportunityScore: 92, projectedPoints: 210, intrinsicScore: 62, adp: 70, percentOwned: 18 }),
      player({ playerId: "backup", name: "Famous Backup", position: "RB", roleClass: "backup", depthOrdinal: 3, opportunityScore: 30, projectedPoints: 135, intrinsicScore: 70, adp: 45, percentOwned: 80 }),
    ], [], neutralContext);
    expect(ranked[0]?.playerId).toBe("starter");
    expect(ranked[0]?.reasons).toContain("Opportunity and depth role support workload");
  });

  it("boosts a close candidate that fills an open starter need", () => {
    const ranked = rankAvailable([
      player({ playerId: "rb", position: "RB", intrinsicScore: 64 }),
      player({ playerId: "wr", position: "WR", intrinsicScore: 67 }),
    ], [], { ...neutralContext, baseDeficits: { QB: 0, RB: 1, WR: 0, TE: 0 } });
    expect(ranked[0]?.playerId).toBe("rb");
    expect(ranked[0]?.reasons).toContain("Open RB starter or flex slot");
  });

  it("rewards a closing strong tier but not an equivalent flat tier", () => {
    const context = { ...neutralContext, currentPick: 20, nextTeamPick: 35 };
    const ranked = rankAvailable([
      player({ playerId: "scarce", position: "TE", tier: "T1", intrinsicScore: 75, projectedPoints: 190 }),
      player({ playerId: "next-tier", position: "TE", tier: "T2", intrinsicScore: 50, projectedPoints: 190 }),
      player({ playerId: "flat", position: "WR", tier: "T1", intrinsicScore: 75, projectedPoints: 190 }),
      player({ playerId: "flat-next", position: "WR", tier: "T2", intrinsicScore: 75, projectedPoints: 190 }),
    ], [], context);
    const scarce = ranked.find((candidate) => candidate.playerId === "scarce")!;
    const flat = ranked.find((candidate) => candidate.playerId === "flat")!;
    expect(scarce.pickNowScore).toBeGreaterThan(flat.pickNowScore);
    expect(scarce.reasons).toContain("Tier may close before the next team pick");
    expect(flat.reasons).not.toContain("Tier may close before the next team pick");
  });

  it("applies bounded injury penalties and exposes the risk", () => {
    const ranked = rankAvailable([
      player({ playerId: "healthy", position: "WR", intrinsicScore: 68, injuryStatus: "ACTIVE" }),
      player({ playerId: "injured", position: "WR", intrinsicScore: 76, injuryStatus: "OUT" }),
    ], [], neutralContext);
    const injured = ranked.find((candidate) => candidate.playerId === "injured")!;
    expect(ranked[0]?.playerId).toBe("healthy");
    expect(injured.risks).toContain("ESPN injury status: OUT");
    expect(injured.pickNowScore).toBeGreaterThanOrEqual(0);
  });

  it("strongly suppresses K and D/ST while required skill slots remain", () => {
    const context = { ...neutralContext, baseDeficits: { QB: 1, RB: 1, WR: 1, TE: 1 }, flexOpen: 1 };
    const ranked = rankAvailable([
      player({ playerId: "k", position: "K", intrinsicScore: 99, opportunityScore: 99, projectedPoints: 180 }),
      player({ playerId: "dst", position: "D/ST", intrinsicScore: 99, opportunityScore: 99, projectedPoints: 180 }),
      player({ playerId: "wr", position: "WR", intrinsicScore: 70, opportunityScore: 70, projectedPoints: 160 }),
    ], [], context);
    expect(ranked[0]?.playerId).toBe("wr");
    expect(ranked.find((candidate) => candidate.playerId === "k")?.risks).toContain("K/DST suppressed while skill-position slots remain open");
    expect(ranked.find((candidate) => candidate.playerId === "dst")?.risks).toContain("K/DST suppressed while skill-position slots remain open");
  });

  it("returns 100% with no intervening picks and lower odds for high-demand players across a long turn", () => {
    const catalog = [
      player({ playerId: "urgent", position: "RB", intrinsicScore: 95, opportunityScore: 95, projectedPoints: 300, adp: 5 }),
      player({ playerId: "later", position: "RB", intrinsicScore: 40, opportunityScore: 35, projectedPoints: 90, adp: 150 }),
      ...Array.from({ length: 18 }, (_, index) => player({ playerId: `filler-${index.toString().padStart(2, "0")}`, position: index % 2 === 0 ? "WR" : "RB", intrinsicScore: 55 + (index % 5), adp: 45 + index })),
    ];
    const immediate = rankAvailable(catalog, [], { ...neutralContext, currentPick: 25, nextTeamPick: 25 });
    expect(immediate.every((candidate) => candidate.returnProbability === 1)).toBe(true);

    const turn = rankAvailable(catalog, [], { ...neutralContext, currentPick: 25, nextTeamPick: 38 });
    const urgent = turn.find((candidate) => candidate.playerId === "urgent")!;
    const later = turn.find((candidate) => candidate.playerId === "later")!;
    expect(urgent.returnProbability).toBeLessThan(later.returnProbability!);
    expect(urgent.returnProbability).toBeLessThan(0.25);
    expect(later.returnProbability).toBeGreaterThan(0.5);
    expect(urgent.reasons).toContain("Unlikely to return through intervening picks");

    const shortWait = rankAvailable(catalog, [], { ...neutralContext, currentPick: 25, nextTeamPick: 30 })
      .find((candidate) => candidate.playerId === "urgent")!;
    expect(shortWait.returnProbability).toBeGreaterThanOrEqual(urgent.returnProbability!);

    const lowDemandCatalog = catalog.map((candidate) => candidate.playerId === "urgent" ? { ...candidate, adp: 150 } : candidate);
    const lowDemand = rankAvailable(lowDemandCatalog, [], { ...neutralContext, currentPick: 25, nextTeamPick: 38 })
      .find((candidate) => candidate.playerId === "urgent")!;
    expect(lowDemand.returnProbability).toBeGreaterThan(urgent.returnProbability!);
  });

  it("models future pick owners and their roster/keeper needs", () => {
    const picked = [
      player({ playerId: "qa", position: "QB" }),
      player({ playerId: "qb", position: "QB" }),
      player({ playerId: "qc", position: "QB" }),
      player({ playerId: "rd", position: "RB" }),
    ];
    const available = [
      player({ playerId: "candidate-qb", position: "QB", intrinsicScore: 78, projectedPoints: 300, adp: 45 }),
      ...Array.from({ length: 24 }, (_, index) => player({
        playerId: `skill-${index.toString().padStart(2, "0")}`,
        position: index % 2 === 0 ? "RB" : "WR",
        intrinsicScore: 70 - (index % 5),
        adp: 40 + index,
      })),
    ];
    const picks: DraftPickEventV1[] = picked.map((candidate, index) => ({
      schemaVersion: 1,
      eventId: String(index + 1).repeat(64),
      overallPick: index + 1,
      round: 1,
      roundPick: index + 1,
      teamId: ["A", "B", "C", "D"][index]!,
      playerId: candidate.playerId,
      source: index === 3 ? "manual" : "espn",
      providerObservedAt: null,
      ingestorObservedAt: "2026-08-11T12:00:00.000Z",
    }));
    const context = {
      ...neutralContext,
      currentPick: 5,
      nextTeamPick: 8,
      draftSlotTeamIds: ["A", "B", "C", "D", "D", "C", "B", "A"],
      managedTeamId: "A",
      rosterTargets: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 },
    };
    const missingQuarterback = rankAvailable([...picked, ...available], picks, context)
      .find((candidate) => candidate.playerId === "candidate-qb")!;
    // Preserve the exact drafted-player set and only swap ownership: D now has
    // the QB while A has the RB, isolating the effect of intervening team need.
    const keeperFilled = picks.map((pick) => ({
      ...pick,
      teamId: pick.teamId === "A" ? "D" : pick.teamId === "D" ? "A" : pick.teamId,
    }));
    const allTeamsHaveQuarterbacks = rankAvailable([...picked, ...available], keeperFilled, context)
      .find((candidate) => candidate.playerId === "candidate-qb")!;
    expect(allTeamsHaveQuarterbacks.returnProbability).toBeGreaterThan(missingQuarterback.returnProbability!);
  });

  it("does not let a thousand-player-shaped tail swamp top-ADP return odds", () => {
    const catalog = Array.from({ length: 160 }, (_, index) => player({
      playerId: `adp-${(index + 1).toString().padStart(3, "0")}`,
      position: index % 3 === 0 ? "RB" : "WR",
      roleClass: index % 3 === 0 ? "RB1" : "WR1",
      intrinsicScore: 90 - index * 0.2,
      opportunityScore: 85 - index * 0.1,
      projectedPoints: 300 - index,
      adp: index + 1,
    }));
    const ranked = rankAvailable(catalog, [], {
      ...neutralContext,
      currentPick: 1,
      nextTeamPick: 4,
      draftSlotTeamIds: ["A", "B", "C", "D"],
      rosterTargets: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 },
    });
    for (const candidate of ranked.filter((item) => (item.adp ?? 999) <= 3)) {
      expect(candidate.returnProbability).toBeLessThan(0.25);
    }
  });

  it("widens ADP uncertainty mid-draft so pick-70 options can plausibly return", () => {
    const catalog = Array.from({ length: 180 }, (_, index) => player({
      playerId: `mid-${(index + 1).toString().padStart(3, "0")}`,
      position: index % 4 < 2 ? "RB" : "WR",
      roleClass: index % 4 < 2 ? "RB1" : "WR1",
      intrinsicScore: 88 - index * 0.18,
      opportunityScore: 82 - index * 0.12,
      projectedPoints: 320 - index,
      adp: index + 1,
    }));
    const teams = Array.from({ length: 12 }, (_, index) => `T${index + 1}`);
    const slots = Array.from({ length: 15 * teams.length }, (_, index) => {
      const round = Math.floor(index / teams.length);
      const slot = index % teams.length;
      return teams[round % 2 === 0 ? slot : teams.length - slot - 1]!;
    });
    const picks: DraftPickEventV1[] = catalog.slice(0, 60).map((candidate, index) => ({
      schemaVersion: 1,
      eventId: (index + 1).toString(16).padStart(64, "0"),
      overallPick: index + 1,
      round: Math.floor(index / teams.length) + 1,
      roundPick: (index % teams.length) + 1,
      teamId: slots[index]!,
      playerId: candidate.playerId,
      source: "espn",
      providerObservedAt: null,
      ingestorObservedAt: "2026-08-11T12:00:00.000Z",
    }));
    const ranked = rankAvailable(catalog, picks, {
      ...neutralContext,
      currentPick: 61,
      nextTeamPick: 69,
      draftSlotTeamIds: slots,
      managedTeamId: slots[68],
      rosterTargets: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 },
    });
    const pick72 = ranked.find((candidate) => candidate.adp === 72)!;
    const pick76 = ranked.find((candidate) => candidate.adp === 76)!;
    const pick80 = ranked.find((candidate) => candidate.adp === 80)!;
    expect(pick72.returnProbability).toBeGreaterThanOrEqual(0.3);
    expect(pick76.returnProbability).toBeGreaterThanOrEqual(0.45);
    expect(pick80.returnProbability).toBeGreaterThanOrEqual(0.55);
    expect(pick72.returnProbability).toBeLessThan(pick76.returnProbability!);
    expect(pick76.returnProbability).toBeLessThan(pick80.returnProbability!);
  });

  it("uses ESPN ADP value at the current pick", () => {
    const ranked = rankAvailable([
      player({ playerId: "fallen", position: "WR", adp: 10 }),
      player({ playerId: "reach", position: "WR", adp: 60 }),
    ], [], { ...neutralContext, currentPick: 35 });
    expect(ranked[0]?.playerId).toBe("fallen");
    expect(ranked[0]?.reasons).toContain("Fell past ESPN ADP 10.0");
  });

  it("is byte-deterministic, stably breaks ties, and bounds every score", () => {
    const catalog = [
      player({ playerId: "b", position: "RB", intrinsicScore: 120, opportunityScore: 120, adp: 4 }),
      player({ playerId: "a", position: "RB", intrinsicScore: 120, opportunityScore: 120, adp: 4 }),
      player({ playerId: "c", position: "WR", intrinsicScore: -20, opportunityScore: -20, adp: 200, injuryStatus: "OUT" }),
    ];
    const first = rankAvailable(catalog, [], neutralContext);
    const second = rankAvailable(catalog, [], neutralContext);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.slice(0, 2).map((candidate) => candidate.playerId)).toEqual(["a", "b"]);
    expect(first.every((candidate) => candidate.intrinsicScore >= 0 && candidate.intrinsicScore <= 100)).toBe(true);
    expect(first.every((candidate) => candidate.pickNowScore >= 0 && candidate.pickNowScore <= 100)).toBe(true);
    expect(first[0]?.pickNowScore).toBeLessThan(100);
  });
});
