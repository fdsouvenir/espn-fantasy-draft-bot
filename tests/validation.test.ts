import { describe, expect, it } from "vitest";
import { validateIngest, validateInit } from "../src/validation";

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

  it("rejects events beyond the source cursor or declared draft size", () => {
    const base = { schemaVersion: 1, draftKey: "d", ingestorInstanceId: "test", capturedAt: "2026-08-11T12:00:00.000Z", draftState: { inProgress: true, drafted: false, totalPickSlots: 16 } };
    expect(() => validateIngest({ ...base, cursor: { lastOverallPick: 0 }, events: [event(1)] })).toThrow("invalid_cursor");
    expect(() => validateIngest({ ...base, cursor: { lastOverallPick: 17 }, events: [event(17)] })).toThrow("invalid_overall_pick");
  });

  it("rejects mutually exclusive phase flags", () => {
    expect(() => validateIngest({ schemaVersion: 1, draftKey: "d", ingestorInstanceId: "test", capturedAt: "2026-08-11T12:00:00.000Z", cursor: { lastOverallPick: 0 }, draftState: { inProgress: true, drafted: true, totalPickSlots: 16 }, events: [] }))
      .toThrow("invalid_phase_flags");
  });
});

describe("validateInit", () => {
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
});
