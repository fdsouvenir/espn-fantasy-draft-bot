/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  CatalogPlayerV1,
  DraftInitV1,
  DraftPickEventV1,
  IngestBatchV1,
  ResearchPublicationV1,
} from "../src/contracts";
import { bytesToHex, canonicalHmacInput } from "../src/security";

const SECRET = "integration-test-secret-with-more-than-32-bytes";
const PREVIOUS_SECRET = "integration-test-previous-secret-more-than-32-bytes";
const RESEARCH_SECRET = "integration-test-research-secret-more-than-32-bytes";
const encoder = new TextEncoder();

function catalogPlayer(playerId: string, name: string): CatalogPlayerV1 {
  return {
    playerId,
    name,
    position: playerId.startsWith("-") ? "D/ST" : "RB",
    nflTeam: playerId.startsWith("-") ? "TEN" : "CHI",
    tier: "T1",
    roleClass: "starter",
    opportunityScore: 90,
    intrinsicScore: 88,
    pickNowScore: 91,
    returnProbability: 0.35,
    reasons: ["test fixture"],
    risks: [],
  };
}

function init(draftKey: string): DraftInitV1 {
  const draftSlotTeamIds = Array.from({ length: 4 }, (_, roundIndex) => {
    const teams = ["team-1", "team-2", "team-3", "team-4"];
    return roundIndex % 2 === 0 ? teams : [...teams].reverse();
  }).flat();
  return {
    schemaVersion: 1,
    draftKey,
    expectedTeams: 4,
    expectedRounds: 4,
    totalPickSlots: 16,
    managedTeamId: "team-3",
    draftSlotTeamIds,
    rosterTargets: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 },
    pinnedCatalogVersion: "test-v1",
    catalog: [catalogPlayer("101", "Runner One"), catalogPlayer("102", "Runner Two"), catalogPlayer("-16010", "Titans D/ST")],
  };
}

function pick(overallPick: number, playerId: string, overrides: Partial<DraftPickEventV1> = {}): DraftPickEventV1 {
  return {
    schemaVersion: 1,
    eventId: overallPick.toString(16).padStart(64, "0"),
    overallPick,
    round: 1,
    roundPick: overallPick,
    teamId: `team-${overallPick}`,
    playerId,
    source: "espn",
    providerObservedAt: "2026-08-11T11:00:00.000Z",
    ingestorObservedAt: "2026-08-11T11:00:00.100Z",
    ...overrides,
  };
}

function batch(draftKey: string, events: DraftPickEventV1[], overrides: Partial<IngestBatchV1> = {}): IngestBatchV1 {
  return {
    schemaVersion: 1,
    draftKey,
    ingestorInstanceId: "integration-test",
    capturedAt: "2026-08-11T11:00:01.000Z",
    cursor: { lastOverallPick: events.at(-1)?.overallPick ?? 0 },
    draftState: { inProgress: true, drafted: false, totalPickSlots: 16 },
    events,
    ...overrides,
  };
}

function researchPublication(
  draftKey: string,
  overrides: Partial<ResearchPublicationV1> = {},
): ResearchPublicationV1 {
  return {
    schemaVersion: 1,
    draftKey,
    publicationId: "research-2026-08-27-1",
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
      notes: "Pilot",
    }],
    profiles: [{
      playerKey: "espn:101",
      nflTeam: "CHI",
      profile: {
        schemaVersion: 2,
        profileId: "profile-rb-101",
        researchRunId: "run-2026-08-27",
        evidenceCutoffAt: "2026-08-27T09:30:00.000Z",
        position: "RB",
        researchedRole: "clear-lead",
        researchState: "complete",
        taxonomyState: "matched",
        publicationStatus: "published",
        warRoomHeadline: "One of the remaining actual starting backs",
        currentRoleSummary: "Leads the current backfield rotation.",
        opportunitySummary: "Owns the most stable touch path.",
        competitionSummary: "A second back retains passing work.",
        availabilitySummary: "Practicing in full.",
        draftImplication: "The role is scarcer than the ESPN rank suggests.",
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
          routeShare: { low: 0.34, high: 0.48 },
          goalLineRole: "primary",
          backfieldRank: 1,
        },
        additionalFindings: {},
        researchedAt: "2026-08-27T10:00:00.000Z",
        classifiedAt: "2026-08-27T11:00:00.000Z",
        expiresAt: "2026-08-30T11:00:00.000Z",
        classifiedBy: "Verl",
      },
    }],
    ...overrides,
  };
}

async function signature(method: string, pathname: string, body: Uint8Array, timestamp: string, nonce: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const canonical = Uint8Array.from(await canonicalHmacInput(timestamp, nonce, method, pathname, body));
  const signed = await crypto.subtle.sign("HMAC", key, canonical.buffer);
  return `v1=${bytesToHex(new Uint8Array(signed))}`;
}

async function signedJsonHeaders(pathname: string, body: Uint8Array, nonce: string, secret = SECRET): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    "content-type": "application/json",
    "X-Draft-Timestamp": timestamp,
    "X-Draft-Nonce": nonce,
    "X-Draft-Signature": await signature("POST", pathname, body, timestamp, nonce, secret),
  };
}

beforeEach(() => {
  (env as Env).INGEST_HMAC_CURRENT = SECRET;
  (env as Env & { INGEST_HMAC_PREVIOUS?: string }).INGEST_HMAC_PREVIOUS = "";
  (env as Env).RESEARCH_HMAC_CURRENT = RESEARCH_SECRET;
  (env as Env & { RESEARCH_HMAC_PREVIOUS?: string }).RESEARCH_HMAC_PREVIOUS = "";
});

describe("DraftSession integration", () => {
  it("initializes idempotently and exposes an undrafted catalog", async () => {
    const stub = env.DRAFT_SESSION.getByName("init-idempotent");
    expect(await stub.initializeDraft(init("init-idempotent"))).toEqual({ created: true, revision: 0 });
    expect(await stub.initializeDraft(init("init-idempotent"))).toEqual({ created: false, revision: 0 });

    const snapshot = await stub.getSnapshot();
    expect(snapshot).toMatchObject({ draftKey: "init-idempotent", status: "pre_draft", revision: 0 });
    expect(snapshot.available.map((player) => player.playerId)).toEqual(expect.arrayContaining(["101", "102", "-16010"]));
  });

  it("atomically publishes Verl research and adds presentation grouping without changing ranking", async () => {
    const draftKey = "research-publication";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    const before = await stub.getSnapshot();
    const beforePlayer = before.available.find((player) => player.playerId === "101")!;
    const publication = researchPublication(draftKey);
    const first = await stub.publishResearch(publication, crypto.randomUUID(), new Date().toISOString());
    expect(first).toMatchObject({ changed: true, researchRevision: 1, profileCount: 1, warnings: [] });
    const replay = await stub.publishResearch(publication, crypto.randomUUID(), new Date().toISOString());
    expect(replay).toMatchObject({ changed: false, researchRevision: 1 });

    const snapshot = await stub.getSnapshot();
    const afterPlayer = snapshot.available.find((player) => player.playerId === "101")!;
    expect(snapshot.research).toMatchObject({ publicationId: publication.publicationId, profileCount: 1 });
    expect(afterPlayer.researchProfile?.researchedRole).toBe("clear-lead");
    expect(afterPlayer.researchInventoryBucket).toBe("Actual starter");
    expect(afterPlayer.researchOffenseScoringBand).toBe("average");
    expect(afterPlayer.researchTeamNotes).toBe("Pilot");
    expect(afterPlayer.pickNowScore).toBe(beforePlayer.pickNowScore);
  });

  it("keeps the last valid research batch when a replacement has an identity error", async () => {
    const draftKey = "research-last-known-good";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    await stub.publishResearch(researchPublication(draftKey), crypto.randomUUID(), new Date().toISOString());
    const original = researchPublication(draftKey).profiles[0]!;
    const invalid = researchPublication(draftKey, {
      publicationId: "research-2026-08-27-2",
      profiles: [{
        ...original,
        profile: {
          ...original.profile,
          position: "WR",
          researchedRole: "rotational-receiver",
          structuredFindings: { position: "WR" },
        },
      }],
    });
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.publishResearch(invalid, crypto.randomUUID(), new Date().toISOString()))
        .rejects.toThrow("invalid_research_player_identity");
    });
    expect((await stub.getSnapshot()).research?.publicationId).toBe("research-2026-08-27-1");
  });

  it("preserves negative D/ST IDs and reports a gap without dropping picks", async () => {
    const draftKey = "negative-dst-gap";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));

    const ack = await stub.ingestBatch(batch(draftKey, [pick(1, "101"), pick(3, "-16010")]), "00000000-0000-4000-8000-000000000001", "2026-08-11T11:00:02.000Z");
    expect(ack).toMatchObject({ revision: 1, accepted: 2, deduped: 0, lastOverallPick: 3, missingOverallPicks: [2] });

    const snapshot = await stub.getSnapshot();
    expect(snapshot.picks.map((event) => event.playerId)).toEqual(["101", "-16010"]);
    expect(snapshot.available.map((player) => player.playerId)).toEqual(["102"]);
    expect(snapshot.health).toMatchObject({ hasGap: true, missingOverallPicks: [2], lastOverallPick: 3 });
  });

  it("uses the source cursor to expose trailing missing picks", async () => {
    const draftKey = "trailing-gap";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    await stub.ingestBatch(
      batch(draftKey, [pick(1, "101"), pick(2, "102")], { cursor: { lastOverallPick: 4 } }),
      "00000000-0000-4000-8000-000000000012",
      "2026-08-11T11:00:02.000Z",
    );
    expect((await stub.getHealth()).missingOverallPicks).toEqual([3, 4]);
  });

  it("stores future keepers without advancing the live draft clock", async () => {
    const draftKey = "future-keeper-clock";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft({ ...init(draftKey), prefilledPickNumbers: [4] });

    await stub.ingestBatch(
      batch(draftKey, [pick(4, "101")], { cursor: { lastOverallPick: 1 } }),
      "00000000-0000-4000-8000-000000000013",
      "2026-08-11T11:00:02.000Z",
    );
    const corrected = await stub.ingestBatch(
      batch(draftKey, [], { cursor: { lastOverallPick: 0 } }),
      "00000000-0000-4000-8000-000000000014",
      "2026-08-11T11:00:03.000Z",
    );

    expect(corrected).toMatchObject({ lastOverallPick: 0, missingOverallPicks: [] });
    const snapshot = await stub.getSnapshot();
    expect(snapshot.draft.current).toBe(1);
    expect(snapshot.picks.map((event) => event.overallPick)).toEqual([4]);
    expect(snapshot.available.map((player) => player.playerId)).not.toContain("101");
  });

  it("rejects a cursor regression across a live pick", async () => {
    const draftKey = "live-cursor-regression";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    await stub.ingestBatch(
      batch(draftKey, [pick(1, "101")]),
      "00000000-0000-4000-8000-000000000015",
      "2026-08-11T11:00:02.000Z",
    );

    await runInDurableObject(stub, async (instance) => {
      await expect(instance.ingestBatch(
        batch(draftKey, [], { cursor: { lastOverallPick: 0 } }),
        "00000000-0000-4000-8000-000000000016",
        "2026-08-11T11:00:03.000Z",
      )).rejects.toThrow("invalid_cursor");
    });
  });

  it("rejects an incompatible re-initialization", async () => {
    const draftKey = "init-conflict";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.initializeDraft({ ...init(draftKey), pinnedCatalogVersion: "different-version" }),
      ).rejects.toThrow("draft_init_conflict");
    });
  });

  it("persists 12-team snake context, enriches the managed roster, and reports needs and next pick", async () => {
    const draftKey = "managed-context-12-team";
    const teamIds = Array.from({ length: 12 }, (_, index) => `team-${index + 1}`);
    const draftSlotTeamIds = Array.from({ length: 6 }, (_, roundIndex) =>
      roundIndex % 2 === 0 ? teamIds : [...teamIds].reverse(),
    ).flat();
    const players = [
      { ...catalogPlayer("201", "Quarterback"), position: "QB" },
      { ...catalogPlayer("202", "Runner A"), position: "RB" },
      { ...catalogPlayer("203", "Runner B"), position: "RB" },
      { ...catalogPlayer("204", "Runner C"), position: "RB" },
      { ...catalogPlayer("205", "Receiver"), position: "WR" },
    ];
    const config: DraftInitV1 = {
      schemaVersion: 1,
      draftKey,
      expectedTeams: 12,
      expectedRounds: 6,
      totalPickSlots: 72,
      managedTeamId: "team-3",
      draftSlotTeamIds,
      rosterTargets: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 },
      pinnedCatalogVersion: "test-v1",
      catalog: players,
    };
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(config);
    await stub.ingestBatch(
      batch(
        draftKey,
        [
          pick(3, "201", { round: 1, roundPick: 3, teamId: "team-3" }),
          pick(22, "202", { round: 2, roundPick: 10, teamId: "team-3" }),
          pick(27, "203", { round: 3, roundPick: 3, teamId: "team-3" }),
          pick(46, "204", { round: 4, roundPick: 10, teamId: "team-3" }),
        ],
        {
          cursor: { lastOverallPick: 46 },
          draftState: { inProgress: true, drafted: false, totalPickSlots: 72 },
        },
      ),
      "00000000-0000-4000-8000-000000000013",
      "2026-08-11T11:00:02.000Z",
    );

    const snapshot = await stub.getSnapshot();
    expect(snapshot.managedRoster).toEqual([
      expect.objectContaining({ playerId: "201", name: "Quarterback", overallPick: 3 }),
      expect.objectContaining({ playerId: "202", name: "Runner A", overallPick: 22 }),
      expect.objectContaining({ playerId: "203", name: "Runner B", overallPick: 27 }),
      expect.objectContaining({ playerId: "204", name: "Runner C", overallPick: 46 }),
    ]);
    expect(snapshot.needs).toEqual({
      targets: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 },
      filled: { QB: 1, RB: 3, WR: 0, TE: 0 },
      baseDeficits: { QB: 0, RB: 0, WR: 2, TE: 1 },
      flexEligibleAfterBase: 1,
      flexOpen: 0,
      flexMet: true,
    });
    expect(snapshot.draft).toEqual({ current: 47, round: 4, roundPick: 11, nextTeamPick: 51, picksAway: 4 });

    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.initializeDraft({ ...config, managedTeamId: "team-4" }),
      ).rejects.toThrow("draft_init_conflict");
    });
  });

  it("deduplicates exact repeats, rejects nonce replay, and keeps revision stable", async () => {
    const draftKey = "dedupe-nonce";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    const envelope = batch(draftKey, [pick(1, "101")]);
    const nonceOne = "00000000-0000-4000-8000-000000000002";
    const nonceTwo = "00000000-0000-4000-8000-000000000003";

    expect(await stub.ingestBatch(envelope, nonceOne, "2026-08-11T11:00:02.000Z")).toMatchObject({ revision: 1, accepted: 1, deduped: 0 });
    expect(await stub.ingestBatch(envelope, nonceTwo, "2026-08-11T11:00:03.000Z")).toMatchObject({ revision: 1, accepted: 0, deduped: 1 });
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.ingestBatch(envelope, nonceTwo, "2026-08-11T11:00:04.000Z")).rejects.toThrow("nonce_replay");
    });
    expect((await stub.getSnapshot()).picks).toHaveLength(1);
  });

  it("rejects a conflicting pick and records the conflict without replacing state", async () => {
    const draftKey = "pick-conflict";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    await stub.ingestBatch(batch(draftKey, [pick(1, "101")]), "00000000-0000-4000-8000-000000000004", "2026-08-11T11:00:02.000Z");

    const conflict = batch(draftKey, [pick(1, "102", { eventId: "f".repeat(64) })]);
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.ingestBatch(conflict, "00000000-0000-4000-8000-000000000005", "2026-08-11T11:00:03.000Z")).rejects.toThrow("pick_conflict");
    });
    const snapshot = await stub.getSnapshot();
    expect(snapshot.picks).toHaveLength(1);
    expect(snapshot.picks[0]?.playerId).toBe("101");
    expect(snapshot.health.conflictCount).toBe(1);
  });

  it("derives stale and dead ingestor health from the last ingest heartbeat", async () => {
    const draftKey = "ingestor-liveness";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    await stub.ingestBatch(
      batch(draftKey, []),
      "00000000-0000-4000-8000-000000000020",
      new Date(Date.now() - 60_000).toISOString(),
    );
    expect(await stub.getHealth()).toMatchObject({ ingestorStatus: "stale", stale: true });
    expect((await stub.getSnapshot()).recommendations).toEqual([]);
    await stub.ingestBatch(
      batch(draftKey, []),
      "00000000-0000-4000-8000-000000000021",
      new Date(Date.now() - 121_000).toISOString(),
    );
    expect(await stub.getHealth()).toMatchObject({ ingestorStatus: "dead", stale: true });
  });

  it("does not mark a completed draft stale after the collector exits", async () => {
    const draftKey = "completed-liveness";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    await stub.ingestBatch(
      batch(draftKey, [], {
        capturedAt: new Date(Date.now() - 121_000).toISOString(),
        cursor: { lastOverallPick: 16 },
        draftState: { inProgress: false, drafted: true, totalPickSlots: 16 },
      }),
      "00000000-0000-4000-8000-000000000022",
      new Date(Date.now() - 121_000).toISOString(),
    );
    expect(await stub.getHealth()).toMatchObject({
      status: "complete",
      ingestorStatus: "healthy",
      stale: false,
    });
  });

  it("dedupes replayed pick identity while preserving the first observation timestamps", async () => {
    const draftKey = "full-field-dedupe";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    await stub.ingestBatch(
      batch(draftKey, [pick(1, "101")]),
      "00000000-0000-4000-8000-000000000022",
      new Date().toISOString(),
    );
    const changedObservation = batch(draftKey, [pick(1, "101", {
      providerObservedAt: "2026-08-11T11:00:01.000Z",
      ingestorObservedAt: "2026-08-11T11:00:02.000Z",
    })]);
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.ingestBatch(changedObservation, "00000000-0000-4000-8000-000000000023", new Date().toISOString()))
        .resolves.toMatchObject({ accepted: 0, deduped: 1 });
    });
    const snapshot = await stub.getSnapshot();
    expect(snapshot.picks).toHaveLength(1);
    expect(snapshot.picks[0]).toMatchObject({
      providerObservedAt: "2026-08-11T11:00:00.000Z",
      ingestorObservedAt: "2026-08-11T11:00:00.100Z",
    });
    expect(snapshot.health.conflictCount).toBe(0);
  });

  it("rejects draft-context mismatches before atomically writing any part of a batch", async () => {
    const cases: Array<[string, (draftKey: string) => IngestBatchV1, string]> = [
      ["total", (draftKey) => batch(draftKey, [pick(1, "101")], { draftState: { inProgress: true, drafted: false, totalPickSlots: 15 } }), "invalid_total_picks"],
      ["cursor", (draftKey) => batch(draftKey, [pick(1, "101")], { cursor: { lastOverallPick: 17 } }), "invalid_cursor"],
      ["round", (draftKey) => batch(draftKey, [pick(1, "101"), pick(2, "102", { round: 2 })]), "invalid_pick_coordinates"],
      ["team", (draftKey) => batch(draftKey, [pick(1, "101"), pick(2, "102", { teamId: "team-4" })]), "invalid_pick_team"],
      ["unknown-player", (draftKey) => batch(draftKey, [pick(1, "999")]), "invalid_player_id"],
      ["duplicate-player", (draftKey) => batch(draftKey, [pick(1, "101"), pick(2, "101")]), "invalid_duplicate_player"],
    ];
    for (const [name, makeEnvelope, expectedError] of cases) {
      const draftKey = `invalid-context-${name}`;
      const stub = env.DRAFT_SESSION.getByName(draftKey);
      await stub.initializeDraft(init(draftKey));
      await runInDurableObject(stub, async (instance) => {
        await expect(instance.ingestBatch(makeEnvelope(draftKey), crypto.randomUUID(), new Date().toISOString()))
          .rejects.toThrow(expectedError);
      });
      const snapshot = await stub.getSnapshot();
      expect(snapshot.picks, name).toHaveLength(0);
      expect(snapshot.revision, name).toBe(0);
      expect(snapshot.health.lastIngestAt, name).toBeNull();
    }
  });

  it("rejects an event ID collision without replacing either identity", async () => {
    const draftKey = "event-id-collision";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    const original = pick(1, "101");
    await stub.ingestBatch(batch(draftKey, [original]), crypto.randomUUID(), new Date().toISOString());
    const collision = pick(2, "102", { eventId: original.eventId });
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.ingestBatch(batch(draftKey, [collision]), crypto.randomUUID(), new Date().toISOString()))
        .rejects.toThrow("event_id_conflict");
    });
    expect((await stub.getSnapshot()).picks.map((event) => event.overallPick)).toEqual([1]);
  });

  it("rejects drafting a catalog player twice across separate batches", async () => {
    const draftKey = "stored-duplicate-player";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    await stub.ingestBatch(batch(draftKey, [pick(1, "101")]), crypto.randomUUID(), new Date().toISOString());
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.ingestBatch(
        batch(draftKey, [pick(2, "101")]),
        crypto.randomUUID(),
        new Date().toISOString(),
      )).rejects.toThrow("invalid_duplicate_player");
    });
    expect((await stub.getSnapshot()).picks.map((event) => event.overallPick)).toEqual([1]);
  });

  it("suppresses server-side recommendations while source truth has a gap", async () => {
    const draftKey = "gap-suppresses-recommendations";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    await stub.ingestBatch(
      batch(draftKey, [pick(2, "102")]),
      crypto.randomUUID(),
      new Date().toISOString(),
    );
    const snapshot = await stub.getSnapshot();
    expect(snapshot.health.hasGap).toBe(true);
    expect(snapshot.available.length).toBeGreaterThan(0);
    expect(snapshot.recommendations).toEqual([]);
  });
});

describe("Worker route security", () => {
  it("starts locally, serves health, and exposes the static application", async () => {
    const health = await SELF.fetch("http://worker.test/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    const app = await SELF.fetch("http://worker.test/");
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("text/html");
  });

  it("rejects unsigned initialization without creating state", async () => {
    const draftKey = "route-unsigned-init";
    const base = `http://worker.test/api/v1/drafts/${draftKey}`;
    const rejected = await SELF.fetch(`${base}/initialize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(init(draftKey)),
    });
    expect(rejected.status).toBe(400);
    expect((await (await SELF.fetch(`${base}/snapshot`)).json<{ status: string }>()).status).toBe("uninitialized");
  });

  it("accepts a correctly signed ingest through the Worker route", async () => {
    const draftKey = "route-valid-hmac";
    const base = `http://worker.test/api/v1/drafts/${draftKey}`;
    const initPath = `/api/v1/drafts/${draftKey}/initialize`;
    const initBytes = encoder.encode(JSON.stringify(init(draftKey)));
    const initialized = await SELF.fetch(`${base}/initialize`, {
      method: "POST",
      headers: await signedJsonHeaders(initPath, initBytes, "00000000-0000-4000-8000-000000000010"),
      body: initBytes,
    });
    expect(initialized.status).toBe(201);

    const pathname = `/api/v1/drafts/${draftKey}/ingest`;
    const bytes = encoder.encode(JSON.stringify(batch(draftKey, [pick(1, "-16010")])));
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = "00000000-0000-4000-8000-000000000006";
    const headers = {
      "content-type": "application/json",
      "X-Draft-Timestamp": timestamp,
      "X-Draft-Nonce": nonce,
      "X-Draft-Signature": await signature("POST", pathname, bytes, timestamp, nonce),
    };
    const accepted = await SELF.fetch(`http://worker.test${pathname}`, { method: "POST", headers, body: bytes });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ accepted: 1, revision: 1 });

    const snapshot = await SELF.fetch(`${base}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json<{ picks: Array<{ playerId: string }> }>()).picks).toEqual([
      expect.objectContaining({ playerId: "-16010" }),
    ]);
  });

  it("accepts a signed research publication and exposes it through the snapshot", async () => {
    const draftKey = "route-valid-research";
    const base = `http://worker.test/api/v1/drafts/${draftKey}`;
    const initPath = `/api/v1/drafts/${draftKey}/initialize`;
    const initBytes = encoder.encode(JSON.stringify(init(draftKey)));
    expect((await SELF.fetch(`${base}/initialize`, {
      method: "POST",
      headers: await signedJsonHeaders(initPath, initBytes, crypto.randomUUID()),
      body: initBytes,
    })).status).toBe(201);

    const path = `/api/v1/drafts/${draftKey}/research`;
    const bytes = encoder.encode(JSON.stringify(researchPublication(draftKey)));
    const response = await SELF.fetch(`http://worker.test${path}`, {
      method: "POST",
      headers: await signedJsonHeaders(path, bytes, crypto.randomUUID(), RESEARCH_SECRET),
      body: bytes,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ changed: true, profileCount: 1 });
    const snapshot = await (await SELF.fetch(`${base}/snapshot`)).json<{
      research: { publicationId: string };
      available: Array<{ playerId: string; researchInventoryBucket?: string }>;
    }>();
    expect(snapshot.research.publicationId).toBe("research-2026-08-27-1");
    expect(snapshot.available.find((player) => player.playerId === "101")?.researchInventoryBucket)
      .toBe("Actual starter");
    const readback = await (await SELF.fetch(`${base}/research`)).json<ResearchPublicationV1>();
    expect(readback).toEqual(researchPublication(draftKey));
  });

  it("accepts the previous HMAC during rotation and rejects initialization nonce replay", async () => {
    (env as Env & { INGEST_HMAC_PREVIOUS?: string }).INGEST_HMAC_PREVIOUS = PREVIOUS_SECRET;
    const draftKey = "route-hmac-rotation";
    const pathname = `/api/v1/drafts/${draftKey}/initialize`;
    const bytes = encoder.encode(JSON.stringify(init(draftKey)));
    const nonce = "00000000-0000-4000-8000-000000000030";
    const headers = await signedJsonHeaders(pathname, bytes, nonce, PREVIOUS_SECRET);
    const first = await SELF.fetch(`http://worker.test${pathname}`, { method: "POST", headers, body: bytes });
    expect(first.status).toBe(201);
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.initializeDraft(init(draftKey), nonce)).rejects.toThrow("nonce_replay");
    });
  });

  it("rejects oversized ingest bodies before parsing or mutation", async () => {
    const draftKey = "route-body-limit";
    const pathname = `/api/v1/drafts/${draftKey}/ingest`;
    const body = "x".repeat(256 * 1024 + 1);
    const response = await SELF.fetch(`http://worker.test${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Draft-Timestamp": Math.floor(Date.now() / 1000).toString(),
        "X-Draft-Nonce": "00000000-0000-4000-8000-000000000031",
        "X-Draft-Signature": `v1=${"0".repeat(64)}`,
      },
      body,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "body_too_large" });
  });

  it("rejects research publications larger than the relay import bound", async () => {
    const draftKey = "route-research-body-limit";
    const pathname = `/api/v1/drafts/${draftKey}/research`;
    const body = "x".repeat(5 * 1024 * 1024 + 1);
    const response = await SELF.fetch(`http://worker.test${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Draft-Timestamp": Math.floor(Date.now() / 1000).toString(),
        "X-Draft-Nonce": "00000000-0000-4000-8000-000000000032",
        "X-Draft-Signature": `v1=${"0".repeat(64)}`,
      },
      body,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "body_too_large" });
  });

  it("hibernates a WebSocket and publishes a draft.updated notification", async () => {
    const draftKey = "route-websocket-update";
    const stub = env.DRAFT_SESSION.getByName(draftKey);
    await stub.initializeDraft(init(draftKey));
    const response = await SELF.fetch(`http://worker.test/api/v1/drafts/${draftKey}/ws`, {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).not.toBeNull();
    socket!.accept();
    const nextMessage = () => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("websocket_message_timeout")), 2_000);
      socket!.addEventListener("message", (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      }, { once: true });
    });
    expect(JSON.parse(await nextMessage())).toMatchObject({ type: "snapshot_required", revision: 0 });
    const update = nextMessage();
    await stub.ingestBatch(batch(draftKey, [pick(1, "101")]), crypto.randomUUID(), new Date().toISOString());
    expect(JSON.parse(await update)).toMatchObject({ type: "draft.updated", revision: 1, lastOverallPick: 1 });
    socket!.close(1000, "test_complete");
  });

  it("rejects stale timestamps and invalid signatures without mutating the draft", async () => {
    const draftKey = "route-invalid-hmac";
    const base = `http://worker.test/api/v1/drafts/${draftKey}`;
    const initPath = `/api/v1/drafts/${draftKey}/initialize`;
    const initBytes = encoder.encode(JSON.stringify(init(draftKey)));
    expect((await SELF.fetch(`${base}/initialize`, {
      method: "POST",
      headers: await signedJsonHeaders(initPath, initBytes, "00000000-0000-4000-8000-000000000011"),
      body: initBytes,
    })).status).toBe(201);

    const pathname = `/api/v1/drafts/${draftKey}/ingest`;
    const bytes = encoder.encode(JSON.stringify(batch(draftKey, [pick(1, "101")])));
    const staleTimestamp = "1700000000";
    const nonce = "00000000-0000-4000-8000-000000000007";
    const stale = await SELF.fetch(`http://worker.test${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Draft-Timestamp": staleTimestamp,
        "X-Draft-Nonce": nonce,
        "X-Draft-Signature": await signature("POST", pathname, bytes, staleTimestamp, nonce),
      },
      body: bytes,
    });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ error: "invalid_signature_time" });

    const currentTimestamp = Math.floor(Date.now() / 1000).toString();
    const invalid = await SELF.fetch(`http://worker.test${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Draft-Timestamp": currentTimestamp,
        "X-Draft-Nonce": "00000000-0000-4000-8000-000000000008",
        "X-Draft-Signature": `v1=${"0".repeat(64)}`,
      },
      body: bytes,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid_signature" });

    const snapshot = await SELF.fetch(`${base}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json<{ picks: unknown[] }>()).picks).toHaveLength(0);
  });
});
