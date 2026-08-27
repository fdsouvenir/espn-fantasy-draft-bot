import { afterEach, describe, expect, it, vi } from "vitest";
import publisher from "../api/research/publish";
import vocabulary from "../config/research-vocabulary.json";

const TOKEN = "publish-trigger-token-that-is-longer-than-thirty-two-bytes";
const SHEET_ID = "approved-sheet";

function sheetValues(headers: string[], row: Record<string, unknown> = {}): unknown[][] {
  return [headers, headers.map((header) => row[header] ?? "")];
}

function validPayload(): Record<string, unknown> {
  const ranges: Record<string, unknown[][]> = {
    "Team Snapshots": sheetValues(vocabulary.sheet.teamSnapshotHeaders, {
      nfl_team: "CHI",
      research_run_id: "run-chi-1",
      snapshot_complete: "yes",
      covered_player_keys: "espn:101",
      offense_scoring_band: "average",
      coverage_notes: "Complete packet.",
    }),
  };
  for (const [position, tab] of Object.entries({
    QB: "QB Profiles",
    RB: "RB Profiles",
    WR: "WR Profiles",
    TE: "TE Profiles",
    K: "K Profiles",
    "D/ST": "DST Profiles",
  })) {
    const headers = [
      ...vocabulary.sheet.profileCommonHeaders,
      ...vocabulary.sheet.positionFindingHeaders[position as keyof typeof vocabulary.sheet.positionFindingHeaders],
    ];
    ranges[tab] = position === "RB"
      ? sheetValues(headers, {
          profile_id: "profile-101",
          player_key: "espn:101",
          player_name: "Runner One",
          position: "RB",
          nfl_team: "CHI",
          research_run_id: "run-chi-1",
          evidence_cutoff_at: "2026-08-27T09:00:00Z",
          researched_role: "clear-lead",
          research_state: "complete",
          taxonomy_state: "matched",
          publication_status: "published",
          war_room_headline: "One of the remaining actual starters",
          current_role_summary: "Leads the present backfield.",
          opportunity_summary: "Owns the clearest touch path.",
          competition_summary: "A second back retains passing work.",
          availability_summary: "Practicing in full.",
          draft_implication: "The role is scarcer than the ESPN rank suggests.",
          confidence: "high",
          confidence_reason: "Independent reports agree.",
          supporting_observation_ids: "obs-1",
          source_refs: "https://example.com/one",
          researched_at: "2026-08-27T10:00:00Z",
          classified_at: "2026-08-27T11:00:00Z",
          expires_at: "2026-08-30T11:00:00Z",
          classified_by: "Verl",
        })
      : [headers];
  }
  return {
    schemaVersion: 1,
    spreadsheetId: SHEET_ID,
    requestId: "request-20260827-001",
    requestedAt: "2026-08-27T12:00:00Z",
    requestedBy: "Verl",
    ranges,
  };
}

function request(payload: unknown, token = TOKEN, headers: Record<string, string> = {}): Request {
  return new Request("https://publisher.example/api/research/publish", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("research publish relay", () => {
  it("rejects unauthenticated requests before reading the import", async () => {
    vi.stubEnv("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN", TOKEN);
    const response = await publisher.fetch(new Request("https://publisher.example/api/research/publish", {
      method: "POST",
      body: "not-json",
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("rejects an authenticated request for any other Sheet", async () => {
    vi.stubEnv("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN", TOKEN);
    vi.stubEnv("DRAFTSIDE_RESEARCH_SPREADSHEET_ID", SHEET_ID);
    const payload = validPayload();
    payload.spreadsheetId = "other-sheet";
    const response = await publisher.fetch(request(payload));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "spreadsheet_not_allowed" });
  });

  it("rejects a declared body larger than the fixed import bound", async () => {
    vi.stubEnv("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN", TOKEN);
    const response = await publisher.fetch(request({}, TOKEN, { "Content-Length": "5242881" }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "body_too_large" });
  });

  it("mechanically validates an approved Sheet import without Worker credentials", async () => {
    vi.stubEnv("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN", TOKEN);
    vi.stubEnv("DRAFTSIDE_RESEARCH_SPREADSHEET_ID", SHEET_ID);
    vi.stubEnv("DRAFTSIDE_DRAFT_KEY", "draft-1");
    vi.stubEnv("DRAFTSIDE_PUBLISH_VALIDATE_ONLY", "1");
    const response = await publisher.fetch(request(validPayload()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      draftKey: "draft-1",
      profileCount: 1,
      teamCount: 1,
      validated: true,
      published: false,
    });
  });

  it("forwards only the signed publication contract to the Worker", async () => {
    vi.stubEnv("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN", TOKEN);
    vi.stubEnv("DRAFTSIDE_RESEARCH_SPREADSHEET_ID", SHEET_ID);
    vi.stubEnv("DRAFTSIDE_DRAFT_KEY", "draft-1");
    vi.stubEnv("DRAFTSIDE_WORKER_BASE", "https://worker.example");
    vi.stubEnv("RESEARCH_HMAC_CURRENT", "worker-research-secret-that-is-longer-than-thirty-two-bytes");
    const workerFetch = vi.fn().mockResolvedValue(Response.json({
      researchRevision: 4,
      changed: true,
      warnings: [],
    }, { status: 201 }));
    vi.stubGlobal("fetch", workerFetch);

    const response = await publisher.fetch(request(validPayload()));

    expect(response.status).toBe(200);
    expect(workerFetch).toHaveBeenCalledOnce();
    const [url, init] = workerFetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://worker.example/api/v1/drafts/draft-1/research");
    expect(init.headers).toMatchObject({
      "X-Draft-Signature": expect.stringMatching(/^v1=[0-9a-f]{64}$/),
    });
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).not.toHaveProperty("ranges");
    expect(JSON.stringify(init.headers)).not.toContain(TOKEN);
  });
});
