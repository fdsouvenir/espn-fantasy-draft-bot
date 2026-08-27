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
    position: "RB",
    researchedRole: "clear-lead",
    researchState: "complete",
    unknownReason: null,
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
    roleVocabularyVersion: "2026.1",
    rubricVersion: "2026.1-draft",
    publishedAt: "2026-08-27T12:00:00.000Z",
    publishedBy: "Verl",
    teamSnapshots: [{ nflTeam: "CHI", complete: true, coveredPlayerKeys: ["espn:101"], notes: "" }],
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

  it("rejects identity mismatches instead of attaching research to the wrong player", () => {
    expect(() => auditResearchPublication(publication(), [catalogPlayer({ nflTeam: "DET" })]))
      .toThrow("invalid_research_player_identity");
  });
});
