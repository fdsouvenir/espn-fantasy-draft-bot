import { describe, expect, it } from "vitest";
import vocabulary from "../config/research-vocabulary.json";
import {
  buildResearchPublication,
  ResearchSheetImportError,
  type ResearchSheetImportV1,
} from "../src/research-sheet-import";

const sheet = vocabulary.sheet;

function values(headers: string[], row: Record<string, unknown> = {}): unknown[][] {
  return [headers, headers.map((header) => row[header] ?? "")];
}

function request(overrides: Partial<ResearchSheetImportV1> = {}): ResearchSheetImportV1 {
  const ranges: Record<string, unknown[][]> = {
    "Team Snapshots": values(sheet.teamSnapshotHeaders, {
      nfl_team: "CHI",
      research_run_id: "run-chi-1",
      snapshot_complete: "yes",
      covered_player_keys: "espn:101",
      offense_scoring_band: "average",
      coverage_notes: "Complete pilot packet.",
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
      ...sheet.profileCommonHeaders,
      ...sheet.positionFindingHeaders[position as keyof typeof sheet.positionFindingHeaders],
    ];
    ranges[tab] = position === "RB"
      ? values(headers, {
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
          alternatives_considered: "committee-1a | early-down-lead",
          additional_findings_json: "{\"note\":\"goal-line work observed\"}",
          supporting_observation_ids: "obs-1;obs-2",
          source_refs: "https://example.com/one;https://example.com/two",
          researched_at: "2026-08-27T10:00:00Z",
          classified_at: "2026-08-27T11:00:00Z",
          expires_at: "2026-08-30T11:00:00Z",
          classified_by: "Verl",
          carry_share_low: "52%",
          carry_share_high: "64%",
          backfield_rank: "1",
          goal_line_role: "primary",
          competition_status: "settled",
        })
      : [headers];
  }
  return {
    schemaVersion: 1,
    spreadsheetId: "sheet-1",
    requestId: "request-20260827-001",
    requestedAt: "2026-08-27T12:00:00Z",
    requestedBy: "Verl",
    ranges,
    ...overrides,
  };
}

describe("research Sheet import", () => {
  it("mechanically maps reviewed Sheet values into the runtime contract", () => {
    const publication = buildResearchPublication(request(), "local:research-pilot");
    expect(publication).toMatchObject({
      draftKey: "local:research-pilot",
      publicationId: "sheet-request-20260827-001",
      roleVocabularyVersion: "2026.3",
      publishedBy: "Verl",
    });
    expect(publication.teamSnapshots).toHaveLength(1);
    expect(publication.profiles).toHaveLength(1);
    expect(publication.profiles[0]?.profile).toMatchObject({
      researchedRole: "clear-lead",
      alternativesConsidered: ["committee-1a", "early-down-lead"],
      supportingObservationIds: ["obs-1", "obs-2"],
      structuredFindings: {
        position: "RB",
        carryShare: { low: 0.52, high: 0.64 },
        backfieldRank: 1,
      },
    });
  });

  it("fails closed while a deployable row is still marked working", () => {
    const payload = request();
    const rb = payload.ranges["RB Profiles"]!;
    const workflowIndex = (rb[0] as string[]).indexOf("workflow_status");
    rb[1]![workflowIndex] = "working";
    expect(() => buildResearchPublication(payload, "local:research-pilot")).toThrow(ResearchSheetImportError);
    try {
      buildResearchPublication(payload, "local:research-pilot");
    } catch (error) {
      expect((error as ResearchSheetImportError).problems).toContain("RB Profiles row 2 is still marked working");
    }
  });

  it("does not invent a missing half of a researched range", () => {
    const payload = request();
    const rb = payload.ranges["RB Profiles"]!;
    const highIndex = (rb[0] as string[]).indexOf("carry_share_high");
    rb[1]![highIndex] = "";
    expect(() => buildResearchPublication(payload, "local:research-pilot")).toThrow(ResearchSheetImportError);
  });

  it("requires every import range and its checked-in headers", () => {
    const payload = request();
    delete payload.ranges["RB Profiles"];
    try {
      buildResearchPublication(payload, "local:research-pilot");
      throw new Error("expected import to fail");
    } catch (error) {
      expect((error as ResearchSheetImportError).problems).toContain("RB Profiles is missing");
    }
  });

  it("ignores untouched team placeholder rows", () => {
    const payload = request();
    payload.ranges["Team Snapshots"]!.push(["GB"]);
    const publication = buildResearchPublication(payload, "local:research-pilot");
    expect(publication.teamSnapshots.map((snapshot) => snapshot.nflTeam)).toEqual(["CHI"]);
  });
});
