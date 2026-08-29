import { describe, expect, it } from "vitest";
// @ts-expect-error Browser-native module intentionally ships without a TypeScript declaration asset.
import { selectNextUpLanes } from "../web/next-up.js";

const compareByRole = (left: { order: number }, right: { order: number }) =>
  left.order - right.order;

describe("War Room Next Up lanes", () => {
  it("does not put a tight end ahead of the RB and WR opportunity lanes at the first pick", () => {
    const players = [
      { id: "mcbride", position: "TE", order: 0 },
      { id: "lead-rb", position: "RB", order: 1 },
      { id: "target-leader", position: "WR", order: 2 },
    ];
    const needs = ["QB", "RB", "WR", "TE"];

    const lanes = selectNextUpLanes(players, needs, compareByRole);

    expect([lanes.backfield?.id, lanes.receiver?.id, lanes.other?.id]).toEqual([
      "lead-rb",
      "target-leader",
      "mcbride",
    ]);
  });

  it("uses roster state only to suppress an already-covered position", () => {
    const players = [
      { id: "another-wr", position: "WR", order: 0 },
      { id: "needed-rb", position: "RB", order: 1 },
    ];
    const needs = [
      { position: "RB", priority: "urgent" },
      { position: "WR", priority: "met" },
    ];

    const lanes = selectNextUpLanes(players, needs, compareByRole);

    expect(lanes.backfield?.id).toBe("needed-rb");
    expect(lanes.receiver).toBeNull();
  });
});
