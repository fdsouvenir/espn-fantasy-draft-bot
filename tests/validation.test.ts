import { describe, expect, it } from "vitest";
import { validateIngest, validateInit, validateResearchPublication } from "../src/validation";

function event(overallPick: number, playerId = "123") {
  return { schemaVersion: 1, eventId: overallPick.toString(16).padStart(64, "0"), overallPick, round: 1, roundPick: overallPick, teamId: "1", playerId, source: "espn", providerObservedAt: null, ingestorObservedAt: "2026-08-11T12:00:00.000Z" };
}

describe("validateIngest", () => {
  it("accepts negative ESPN D/ST identifiers represented as strings", () => {
    const value = validateIngest({ schemaVersion: 1, draftKey: "staging:espn:2026:test", ingestorInstanceId: "test", capturedAt: "2026-08-11T12:00:00.000Z", cursor: { lastOverallPick: 1 }, draftState: { inProgress: true, drafted: false, totalPickSlots: 64 }, events: [event(1, "-16007")] });
    expect(value.events[0]?.playerId).toBe("-16007");
  });

  it("rejects unsorted batches", () => {
    expect(() => validateIngest({ schemaVersion: 1, draftKey: "d", ingestorInstanceId: "test", capturedAt: "2026-08-11T12:00:00.000Z", cursor: { lastOverallPick: 2 }, draftState: { inProgress: true, drafted: false, totalPickSlots: 64 }, events: [event(2), event(1)] })).toThrow("events_not_strictly_ordered");
  });

  it("allows sparse events for context validation but rejects picks beyond draft size", () => {
    const base = { schemaVersion: 1, draftKey: "d", ingestorInstanceId: "test", capturedAt: "2026-08-11T12:00:00.000Z", draftState: { inProgress: true, drafted: false, totalPickSlots: 16 } };
    expect(validateIngest({ ...base, cursor: { lastOverallPick: 0 }, events: [event(1)] }).events).toHaveLength(1);
    expect(() => validateIngest({ ...base, cursor: { lastOverallPick: 17 }, events: [event(17)] })).toThrow("invalid_overall_pick");
  });

  it("rejects mutually exclusive phase flags", () => {
    expect(() => validateIngest({ schemaVersion: 1, draftKey: "d", ingestorInstanceId: "test", capturedAt: "2026-08-11T12:00:00.000Z", cursor: { lastOverallPick: 0 }, draftState: { inProgress: true, drafted: true, totalPickSlots: 16 }, events: [] }))
      .toThrow("invalid_phase_flags");
  });
});

describe("validateInit", () => {
  const validInit = (catalog: unknown[]) => ({
    schemaVersion: 1,
    draftKey: "test",
    expectedTeams: 2,
    expectedRounds: 1,
    totalPickSlots: 2,
    managedTeamId: "team-1",
    draftSlotTeamIds: ["team-1", "team-2"],
    rosterTargets: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 },
    pinnedCatalogVersion: "v2",
    catalog,
  });

  const catalogPlayer = {
    playerId: "101",
    name: "Runner",
    position: "RB",
    nflTeam: "CHI",
    tier: "RB-A",
    roleClass: "clear-lead",
    opportunityScore: 80,
    intrinsicScore: 80,
    pickNowScore: 80,
    returnProbability: null,
    reasons: [],
    risks: [],
  };

  it("rejects malformed catalog members", () => {
    expect(() => validateInit({
      schemaVersion: 1,
      draftKey: "test",
      expectedTeams: 4,
      expectedRounds: 4,
      totalPickSlots: 16,
      pinnedCatalogVersion: "v1",
      catalog: [{ playerId: "101", name: "Missing fields" }],
    })).toThrow("invalid_catalog_player_team");
  });

  it("requires total pick slots to match teams multiplied by rounds", () => {
    expect(() => validateInit({
      schemaVersion: 1,
      draftKey: "test",
      expectedTeams: 4,
      expectedRounds: 4,
      totalPickSlots: 15,
      managedTeamId: "team-1",
      draftSlotTeamIds: Array(15).fill("team-1"),
      rosterTargets: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 },
      pinnedCatalogVersion: "v1",
      catalog: [],
    })).toThrow("invalid_draft_shape");
  });

  it("preserves Verl's published research without reclassifying it", () => {
    const researchProfile = {
      schemaVersion: 2,
      profileId: "profile-rb-101",
      researchRunId: "run-2026-08-11",
      evidenceCutoffAt: "2026-08-11T10:30:00.000Z",
      position: "RB",
      researchedRole: "clear-lead",
      researchState: "complete",
      taxonomyState: "matched",
      publicationStatus: "published",
      warRoomHeadline: "The remaining clear lead back",
      currentRoleSummary: "Verl classified the player as the present backfield lead.",
      opportunitySummary: "First-team early-down, passing-down, and goal-line work.",
      competitionSummary: "The second back remains a change-of-pace option.",
      availabilitySummary: "Practicing in full.",
      draftImplication: "Treat the role as scarce when other clear leads are gone.",
      contingency: {
        researchedRole: "committee-1a",
        trigger: "Pass protection problems return",
        summary: "The backfield could narrow to an early-down committee.",
      },
      confidence: "high",
      confidenceReason: "Two independent reports",
      alternativesConsidered: ["committee-1a"],
      unresolvedQuestions: ["Two-minute usage"],
      supportingObservationIds: ["obs-1", "obs-2"],
      contradictingObservationIds: [],
      sourceUrls: ["https://example.com/report"],
      structuredFindings: {
        position: "RB",
        carryShare: { low: 0.52, high: 0.64 },
        routeShare: { low: 0.34, high: 0.48 },
        goalLineRole: "primary",
        backfieldRank: 1,
        competitionStatus: "settled",
      },
      additionalFindings: { goalLineRole: "primary", observedSnapShare: 0.63 },
      researchedAt: "2026-08-11T11:00:00.000Z",
      classifiedAt: "2026-08-11T12:00:00.000Z",
      expiresAt: "2026-08-18T12:00:00.000Z",
      classifiedBy: "Verl",
    };
    const value = validateInit(validInit([{
      ...catalogPlayer,
      roleClass: "RB1",
      researchProfile,
    }]));
    expect(value.catalog[0]?.roleClass).toBe("RB1");
    expect(value.catalog[0]?.researchProfile).toEqual(researchProfile);
  });

  it("rejects malformed research transport without judging Verl's classification", () => {
    expect(() => validateInit(validInit([{
      ...catalogPlayer,
      researchProfile: {
        schemaVersion: 2,
        profileId: "profile-rb-101",
        researchRunId: "run-2026-08-11",
        evidenceCutoffAt: "2026-08-11T10:30:00.000Z",
        position: "RB",
        researchedRole: "clear-lead",
        researchState: "complete",
        taxonomyState: "matched",
        publicationStatus: "published",
        warRoomHeadline: "Agent conclusion",
        currentRoleSummary: "Current role",
        opportunitySummary: "Opportunity",
        competitionSummary: "Competition",
        availabilitySummary: "Availability",
        draftImplication: "Draft implication",
        contingency: null,
        confidence: "unknown",
        confidenceReason: "Evidence remains incomplete",
        alternativesConsidered: [],
        unresolvedQuestions: [],
        supportingObservationIds: [],
        contradictingObservationIds: [],
        sourceUrls: ["not-a-source-url"],
        structuredFindings: { position: "RB" },
        additionalFindings: {},
        researchedAt: "2026-08-11T11:00:00.000Z",
        classifiedAt: "2026-08-11T12:00:00.000Z",
        expiresAt: "2026-08-18T12:00:00.000Z",
        classifiedBy: "Verl",
      },
    }]))).toThrow("invalid_catalog_player_research_profile");
  });
});

describe("validateResearchPublication", () => {
  const profile = {
    schemaVersion: 2,
    profileId: "profile-rb-101",
    researchRunId: "run-2026-08-27",
    evidenceCutoffAt: "2026-08-27T09:30:00.000Z",
    position: "RB",
    researchedRole: "clear-lead",
    researchState: "complete",
    taxonomyState: "matched",
    publicationStatus: "published",
    warRoomHeadline: "Current backfield lead",
    currentRoleSummary: "Leads the current backfield rotation.",
    opportunitySummary: "Owns the most stable current touch path.",
    competitionSummary: "A second back retains passing work.",
    availabilitySummary: "Practicing in full.",
    draftImplication: "One of the remaining actual starting backs.",
    contingency: null,
    confidence: "high",
    confidenceReason: "Independent current reports agree.",
    alternativesConsidered: ["committee-1a"],
    unresolvedQuestions: [],
    supportingObservationIds: ["obs-1"],
    contradictingObservationIds: [],
    sourceUrls: ["https://example.com/report"],
    structuredFindings: {
      position: "RB",
      carryShare: { low: 0.52, high: 0.64 },
      targetShare: { low: 0.1, high: 0.16 },
      routeShare: { low: 0.34, high: 0.48 },
      goalLineRole: "primary",
      backfieldRank: 1,
    },
    additionalFindings: {},
    researchedAt: "2026-08-27T10:00:00.000Z",
    classifiedAt: "2026-08-27T11:00:00.000Z",
    expiresAt: "2026-08-30T11:00:00.000Z",
    classifiedBy: "Verl",
  };

  const publication = {
    schemaVersion: 1,
    draftKey: "test",
    publicationId: "research-2026-08-27T12:00:00Z",
    roleVocabularyVersion: "2026.3",
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
    profiles: [{ playerKey: "espn:101", nflTeam: "CHI", profile }],
  };

  it("accepts the shared contract without assigning a role", () => {
    expect(validateResearchPublication(publication).profiles[0]?.profile.researchedRole).toBe("clear-lead");
  });

  it("allows a needs-review profile to report that no player-specific source was found", () => {
    const result = validateResearchPublication({
      ...publication,
      profiles: [{
        ...publication.profiles[0],
        profile: {
          ...profile,
          researchedRole: null,
          researchState: "insufficient-evidence",
          publicationStatus: "needs-review",
          supportingObservationIds: [],
          sourceUrls: [],
          expiresAt: null,
        },
      }],
    });
    expect(result.profiles[0]?.profile.sourceUrls).toEqual([]);
    expect(() => validateResearchPublication({
      ...publication,
      profiles: [{
        ...publication.profiles[0],
        profile: { ...profile, sourceUrls: [] },
      }],
    })).toThrow("invalid_research_profile");
  });

  it("requires expiration for published profiles but not unsupported review exceptions", () => {
    expect(validateResearchPublication({
      ...publication,
      profiles: [{
        ...publication.profiles[0],
        profile: {
          ...profile,
          researchedRole: null,
          researchState: "insufficient-evidence",
          publicationStatus: "needs-review",
          sourceUrls: [],
          expiresAt: null,
        },
      }],
    }).profiles[0]?.profile.expiresAt).toBeNull();
    expect(() => validateResearchPublication({
      ...publication,
      profiles: [{
        ...publication.profiles[0],
        profile: { ...profile, expiresAt: null },
      }],
    })).toThrow("invalid_research_profile");
  });

  it("rejects an unknown matched role while preserving taxonomy-gap as the escape hatch", () => {
    expect(() => validateResearchPublication({
      ...publication,
      profiles: [{
        ...publication.profiles[0],
        profile: { ...profile, researchedRole: "invented-role" },
      }],
    })).toThrow("invalid_research_profile");
    expect(validateResearchPublication({
      ...publication,
      profiles: [{
        ...publication.profiles[0],
        profile: {
          ...profile,
          researchedRole: "taxonomy-gap",
          taxonomyState: "taxonomy-gap",
          publicationStatus: "needs-review",
        },
      }],
    }).profiles[0]?.profile.taxonomyState).toBe("taxonomy-gap");
  });

  it("rejects inverted estimates and midpoint-shaped data", () => {
    expect(() => validateResearchPublication({
      ...publication,
      profiles: [{
        ...publication.profiles[0],
        profile: {
          ...profile,
          structuredFindings: { position: "RB", carryShare: { low: 0.7, high: 0.5 } },
        },
      }],
    })).toThrow("invalid_research_profile");
  });

  it("rejects redundant profile fields and evidence dated after research completion", () => {
    expect(() => validateResearchPublication({
      ...publication,
      profiles: [{
        ...publication.profiles[0],
        profile: { ...profile, unknownReason: null },
      }],
    })).toThrow("invalid_research_profile");
    expect(() => validateResearchPublication({
      ...publication,
      profiles: [{
        ...publication.profiles[0],
        profile: { ...profile, evidenceCutoffAt: "2026-08-27T10:30:00.000Z" },
      }],
    })).toThrow("invalid_research_profile");
  });

  it("rejects Sheet-only team context at the publication boundary", () => {
    expect(() => validateResearchPublication({
      ...publication,
      teamSnapshots: [{ ...publication.teamSnapshots[0], teamContextJson: "{}" }],
    })).toThrow("invalid_research_team_snapshot");
  });
});
