import { describe, expect, it } from "vitest";
import type { CatalogPlayerV1, ResearchProfileV2, ResearchPublicationV1 } from "../src/contracts";
import {
  auditResearchPublication,
  RESEARCHED_ROLES_BY_POSITION,
  researchInventoryBucket,
} from "../src/research";

function catalogPlayer(overrides: Partial<CatalogPlayerV1> = {}): CatalogPlayerV1 {
  return {
    playerId: "101",
    name: "Runner",
    position: "RB",
    nflTeam: "CHI",
    tier: "RB-2",
    roleClass: "RB1",
    opportunityScore: 70,
    intrinsicScore: 70,
    pickNowScore: 70,
    returnProbability: null,
    reasons: [],
    risks: [],
    ...overrides,
  };
}

function profile(overrides: Partial<ResearchProfileV2> = {}): ResearchProfileV2 {
  return {
    schemaVersion: 2,
    profileId: "profile-rb-101",
    researchRunId: "run-2026-08-27",
    evidenceCutoffAt: "2026-08-27T09:30:00.000Z",
    position: "RB",
    researchedRole: "clear-lead",
    researchState: "complete",
    taxonomyState: "matched",
    publicationStatus: "published",
    warRoomHeadline: "Current lead back",
    currentRoleSummary: "Leads the current backfield.",
    opportunitySummary: "Owns the most stable workload path.",
    competitionSummary: "Another back retains a package.",
    availabilitySummary: "Practicing in full.",
    draftImplication: "An actual starting role remains available.",
    contingency: null,
    confidence: "high",
    confidenceReason: "Independent observations agree.",
    alternativesConsidered: ["committee-1a"],
    unresolvedQuestions: [],
    supportingObservationIds: ["obs-1"],
    contradictingObservationIds: [],
    sourceUrls: ["https://example.com/report"],
    structuredFindings: {
      position: "RB",
      carryShare: { low: 0.5, high: 0.62 },
      backfieldRank: 1,
    },
    additionalFindings: {},
    researchedAt: "2026-08-27T10:00:00.000Z",
    classifiedAt: "2026-08-27T11:00:00.000Z",
    expiresAt: "2026-09-03T11:00:00.000Z",
    classifiedBy: "Verl",
    ...overrides,
  };
}

function publication(playerProfile = profile()): ResearchPublicationV1 {
  return {
    schemaVersion: 1,
    draftKey: "draft",
    publicationId: "publication-1",
    roleVocabularyVersion: "2026.2",
    rubricVersion: "2026.1-draft",
    publishedAt: "2026-08-27T12:00:00.000Z",
    publishedBy: "Verl",
    teamSnapshots: [{
      nflTeam: "CHI",
      researchRunId: "run-2026-08-27",
      complete: true,
      coveredPlayerKeys: ["espn:101"],
      offenseScoringBand: "average",
      notes: "",
    }],
    profiles: [{ playerKey: "espn:101", nflTeam: "CHI", profile: playerProfile }],
  };
}

describe("research presentation and audit", () => {
  it("maps every approved role to a presentation bucket without assigning a role", () => {
    for (const [position, roles] of Object.entries(RESEARCHED_ROLES_BY_POSITION)) {
      for (const role of roles) expect(researchInventoryBucket(position, role)).not.toBeNull();
    }
    expect(researchInventoryBucket("RB", null)).toBeNull();
    expect(researchInventoryBucket("RB", "taxonomy-gap")).toBe("Taxonomy gap");
  });

  it("warns about definite contradictions and incomplete team closure without rewriting Verl", () => {
    const playerProfile = profile({
      structuredFindings: {
        position: "RB",
        carryShare: { low: 0.5, high: 0.62 },
        backfieldRank: 2,
      },
    });
    const batch = publication(playerProfile);
    batch.teamSnapshots[0]!.complete = false;
    const warnings = auditResearchPublication(batch, [catalogPlayer()]);
    expect(warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "role-metric-conflict",
      "team-snapshot-incomplete",
    ]));
    expect(batch.profiles[0]?.profile.researchedRole).toBe("clear-lead");
  });

  it("audits receiving-back targets and TE-room closure as whole-team claims", () => {
    const batch = publication(profile({
      position: "RB",
      structuredFindings: {
        position: "RB",
        targetShare: { low: 0.6, high: 0.7 },
      },
    }));
    batch.profiles.push({
      playerKey: "espn:102",
      nflTeam: "CHI",
      profile: profile({
        profileId: "profile-te-102",
        position: "TE",
        researchedRole: "committee-receiving-lead",
        structuredFindings: {
          position: "TE",
          targetShare: { low: 0.5, high: 0.6 },
          teRoomRank: 2,
        },
      }),
    });
    batch.teamSnapshots[0]!.complete = false;
    const warnings = auditResearchPublication(batch, [
      catalogPlayer(),
      catalogPlayer({ playerId: "102", name: "Tight End", position: "TE" }),
    ]);
    expect(warnings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "target-share-overallocated",
      "team-snapshot-incomplete",
      "role-metric-conflict",
    ]));
  });

  it("distinguishes contingent RBs from reserve change-of-pace players", () => {
    expect(researchInventoryBucket("RB", "contingent-backup")).toBe("Contingent");
    expect(researchInventoryBucket("RB", "reserve-change-of-pace")).toBe("Reserve");
  });

  it.each([
    {
      position: "WR",
      role: "co-target-leader",
      findings: { position: "WR", teamTargetRank: 6 },
    },
    {
      position: "TE",
      role: "passing-game-focal-point",
      findings: { position: "TE", teamTargetRank: 4 },
    },
    {
      position: "D/ST",
      role: "every-week-disruptive-unit",
      findings: { position: "D/ST", pressurePercentile: 5, pointsPreventionPercentile: 60 },
    },
  ])("warns when $position role language contradicts its structured findings", ({
    position,
    role,
    findings,
  }) => {
    const playerProfile = profile({
      position: position as ResearchProfileV2["position"],
      researchedRole: role,
      structuredFindings: findings as ResearchProfileV2["structuredFindings"],
    });
    const warnings = auditResearchPublication(
      publication(playerProfile),
      [catalogPlayer({ position })],
    );
    expect(warnings.map((item) => item.code)).toContain("role-metric-conflict");
  });

  it("warns when a profile and Team Snapshot come from different research runs", () => {
    const batch = publication(profile({ researchRunId: "run-other" }));
    expect(auditResearchPublication(batch, [catalogPlayer()]).map((item) => item.code))
      .toContain("research-run-mismatch");
  });

  it("rejects identity mismatches instead of attaching research to the wrong player", () => {
    expect(() => auditResearchPublication(publication(), [catalogPlayer({ nflTeam: "DET" })]))
      .toThrow("invalid_research_player_identity");
  });
});
