/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { CatalogPlayerV1, DraftInitV1, IngestBatchV1 } from "../src/contracts";
import { bytesToHex, canonicalHmacInput } from "../src/security";

const DRAFT_KEY = "staging:espn:ffl:2026:123456789:1786494600000";
const LEGACY_DRAFT_KEY = "staging:espn:ffl:2026:987654321:1786494700000";
const TOKEN = "device-token-with-more-than-thirty-two-safe-characters";
const DEVICE_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_DEVICE_ID = "10000000-0000-4000-8000-000000000002";
const ACCESS_HEADERS = {
  "Cf-Access-Authenticated-User-Email": "owner@example.com",
  Origin: "http://worker.test",
};

function player(): CatalogPlayerV1 {
  return {
    playerId: "101",
    name: "Runner One",
    position: "RB",
    nflTeam: "CHI",
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

function draftInit(draftKey = DRAFT_KEY): DraftInitV1 {
  return {
    schemaVersion: 1,
    draftKey,
    expectedTeams: 2,
    expectedRounds: 1,
    totalPickSlots: 2,
    managedTeamId: "team-1",
    draftSlotTeamIds: ["team-1", "team-2"],
    rosterTargets: { QB: 1, RB: 1, WR: 1, TE: 1, FLEX: 0 },
    pinnedCatalogVersion: "companion-test-v1",
    catalog: [player()],
  };
}

function ingestBatch(): IngestBatchV1 {
  return {
    schemaVersion: 1,
    draftKey: DRAFT_KEY,
    ingestorInstanceId: "companion-test",
    capturedAt: "2026-08-11T12:00:00.000Z",
    cursor: { lastOverallPick: 1 },
    draftState: { inProgress: true, drafted: false, totalPickSlots: 2 },
    events: [{
      schemaVersion: 1,
      eventId: "1".padStart(64, "0"),
      overallPick: 1,
      round: 1,
      roundPick: 1,
      teamId: "team-1",
      playerId: "101",
      source: "espn",
      providerObservedAt: "2026-08-11T12:00:00.000Z",
      ingestorObservedAt: "2026-08-11T12:00:00.100Z",
    }],
  };
}

async function signedCompanionHeaders(pathname: string, body: Uint8Array, nonce: string, token = TOKEN): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const canonical = await canonicalHmacInput(timestamp, nonce, "POST", pathname, body);
  const signature = await crypto.subtle.sign("HMAC", key, Uint8Array.from(canonical).buffer);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Draftside-Device": DEVICE_ID,
    "X-Draft-Timestamp": timestamp,
    "X-Draft-Nonce": nonce,
    "X-Draft-Signature": `v1=${bytesToHex(new Uint8Array(signature))}`,
  };
}

beforeAll(async () => {
  await env.DRAFT_SESSION.getByName(DRAFT_KEY).initializeDraft(draftInit());
  await env.COMPANION_REGISTRY.getByName("primary").registerDraft({
    draftKey: DRAFT_KEY,
    displayName: "Test League",
    season: 2026,
    leagueId: "123456789",
    draftEpoch: 1786494600000,
    initializedAt: "2026-08-11T12:00:00.000Z",
  });
});

describe("companion device registry", () => {
  it("registers idempotently, resolves an observed room, and selects it explicitly", async () => {
    const register = async (name: string, token = TOKEN) => SELF.fetch("http://worker.test/api/v1/companion/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Draftside-Device": DEVICE_ID,
      },
      body: JSON.stringify({ name, version: "0.2.0" }),
    });

    const first = await register("Fred's laptop");
    expect(first.status).toBe(201);
    const payload = await first.json<Record<string, unknown>>();
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    expect(payload).toMatchObject({
      device: { deviceId: DEVICE_ID, name: "Fred's laptop", version: "0.2.0", revokedAt: null },
    });
    expect(payload).not.toHaveProperty("drafts");

    const resolved = await SELF.fetch("http://worker.test/api/v1/companion/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "X-Draftside-Device": DEVICE_ID,
      },
      body: JSON.stringify({ rooms: [{ season: 2026, leagueId: "123456789" }] }),
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      drafts: [{
        draftKey: DRAFT_KEY,
        displayName: "Test League",
        season: 2026,
        leagueId: "123456789",
      }],
    });

    const selected = await SELF.fetch("http://worker.test/api/v1/companion/select", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "X-Draftside-Device": DEVICE_ID,
      },
      body: JSON.stringify({ draftKey: DRAFT_KEY }),
    });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({
      draft: { draftKey: DRAFT_KEY, displayName: "Test League" },
      bootstrap: {
        draftKey: DRAFT_KEY,
        expectedTeams: 2,
        totalPickSlots: 2,
        draftSlotTeamIds: ["team-1", "team-2"],
        draftUrl: "https://fantasy.espn.com/football/draft",
      },
    });

    const repeated = await register("Draft laptop");
    expect(repeated.status).toBe(201);
    expect(await repeated.json()).toMatchObject({ device: { name: "Draft laptop" } });
    expect((await register("Hijack", "different-token-with-more-than-thirty-two-characters")).status).toBe(409);
  });

  it("supports Access-protected administration, revoke, and explicit enable", async () => {
    // Cloudflare Access protects this route before it reaches the Worker.
    const list = await SELF.fetch("http://worker.test/api/v1/companion/devices");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ devices: [expect.objectContaining({ deviceId: DEVICE_ID })] });

    const badOrigin = await SELF.fetch(`http://worker.test/api/v1/companion/devices/${DEVICE_ID}/revoke`, {
      method: "POST",
      headers: { ...ACCESS_HEADERS, Origin: "https://attacker.example" },
    });
    expect(badOrigin.status).toBe(403);

    const revoked = await SELF.fetch(`http://worker.test/api/v1/companion/devices/${DEVICE_ID}/revoke`, {
      method: "POST",
      headers: ACCESS_HEADERS,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ device: { deviceId: DEVICE_ID, revokedAt: expect.any(String) } });

    const deniedRegistration = await SELF.fetch("http://worker.test/api/v1/companion/register", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "X-Draftside-Device": DEVICE_ID,
      },
      body: JSON.stringify({ name: "Draft laptop", version: "0.2.0" }),
    });
    expect(deniedRegistration.status).toBe(403);

    const enabled = await SELF.fetch(`http://worker.test/api/v1/companion/devices/${DEVICE_ID}/enable`, {
      method: "POST",
      headers: ACCESS_HEADERS,
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ device: { deviceId: DEVICE_ID, revokedAt: null } });
  });

  it("backfills an initialized draft that predates the companion registry", async () => {
    await env.DRAFT_SESSION.getByName(LEGACY_DRAFT_KEY).initializeDraft(draftInit(LEGACY_DRAFT_KEY));

    const badOrigin = await SELF.fetch("http://worker.test/api/v1/companion/register?resource=draft", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ draftKey: LEGACY_DRAFT_KEY }),
    });
    expect(badOrigin.status).toBe(403);

    const backfilled = await SELF.fetch("http://worker.test/api/v1/companion/register?resource=draft", {
      method: "POST",
      headers: { ...ACCESS_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ draftKey: LEGACY_DRAFT_KEY }),
    });
    expect(backfilled.status).toBe(201);
    expect(await backfilled.json()).toMatchObject({
      draft: {
        draftKey: LEGACY_DRAFT_KEY,
        displayName: "ESPN league 987654321",
        season: 2026,
        leagueId: "987654321",
        draftEpoch: 1786494700000,
      },
      bootstrap: { draftKey: LEGACY_DRAFT_KEY, expectedTeams: 2, totalPickSlots: 2 },
    });

    const resolved = await SELF.fetch("http://worker.test/api/v1/companion/resolve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "X-Draftside-Device": DEVICE_ID,
      },
      body: JSON.stringify({ rooms: [{ season: 2026, leagueId: "987654321" }] }),
    });
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      drafts: [{ draftKey: LEGACY_DRAFT_KEY, leagueId: "987654321" }],
    });
  });

  it("authorizes companion HMAC ingestion and rejects unknown or revoked devices", async () => {
    const pathname = `/api/v1/drafts/${DRAFT_KEY}/companion-ingest`;
    const bytes = new TextEncoder().encode(JSON.stringify(ingestBatch()));
    const accepted = await SELF.fetch(`http://worker.test${pathname}`, {
      method: "POST",
      headers: await signedCompanionHeaders(pathname, bytes, "20000000-0000-4000-8000-000000000001"),
      body: bytes,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ accepted: 1, lastOverallPick: 1 });

    const unknownHeaders = await signedCompanionHeaders(
      pathname,
      bytes,
      "20000000-0000-4000-8000-000000000002",
    );
    unknownHeaders["X-Draftside-Device"] = OTHER_DEVICE_ID;
    const unknown = await SELF.fetch(`http://worker.test${pathname}`, {
      method: "POST",
      headers: unknownHeaders,
      body: bytes,
    });
    expect(unknown.status).toBe(403);

    await SELF.fetch(`http://worker.test/api/v1/companion/devices/${DEVICE_ID}/revoke`, {
      method: "POST",
      headers: ACCESS_HEADERS,
    });
    const revoked = await SELF.fetch(`http://worker.test${pathname}`, {
      method: "POST",
      headers: await signedCompanionHeaders(pathname, bytes, "20000000-0000-4000-8000-000000000003"),
      body: bytes,
    });
    expect(revoked.status).toBe(403);
  });

  it("bounds new-device registration attempts per minute", async () => {
    const stub = env.COMPANION_REGISTRY.getByName("rate-limit-test");
    await runInDurableObject(stub, async (instance) => {
      for (let index = 0; index < 20; index += 1) {
        expect(instance.registerDevice(
          `30000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          index.toString(16).padStart(64, "0"),
          `Laptop ${index}`,
          "0.2.0",
          "2026-08-11T12:00:00.000Z",
        )).toMatchObject({ ok: true });
      }
      expect(instance.registerDevice(
        "30000000-0000-4000-8000-000000000020",
        "f".repeat(64),
        "One too many",
        "0.2.0",
        "2026-08-11T12:00:00.000Z",
      )).toEqual({ ok: false, error: "registration_rate_limited" });
    });
  });
});
