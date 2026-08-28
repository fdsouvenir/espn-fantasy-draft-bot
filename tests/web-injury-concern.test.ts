import { describe, expect, it } from "vitest";
// @ts-expect-error Browser-native module intentionally ships without a TypeScript declaration asset.
import { hasInjuryConcern } from "../web/injury-concern.js";

describe("War Room injury concern labels", () => {
  it.each([
    "Available and participating.",
    "Practicing without a reported limitation.",
    "Worked throughout team periods without restriction.",
    "Healthy and a full participant.",
    "No current injury concern.",
    "Returned to full practice after an ankle issue.",
    "No player-specific injury update was found in the evidence window.",
    "No current direct injury evidence was found; availability is unconfirmed.",
    "Availability was not addressed by the reviewed sources.",
  ])("does not flag a cleared or healthy availability summary: %s", (summary) => {
    expect(hasInjuryConcern(summary)).toBe(false);
  });

  it.each([
    "Questionable with a shoulder injury.",
    "Wearing a no-contact jersey after the shoulder injury.",
    "Remains limited with an ankle issue.",
    "Left practice early and did not return.",
    "Out for Week 1.",
  ])("flags a current availability concern: %s", (summary) => {
    expect(hasInjuryConcern(summary)).toBe(true);
  });

  it.each(["QUESTIONABLE", "OUT", "IR", "PUP", "NFI", "SUSPENDED"])(
    "honors an explicit ESPN injury status: %s",
    (status) => {
      expect(hasInjuryConcern("No player-specific availability report was found.", status)).toBe(true);
    },
  );

  it.each(["ACTIVE", "NORMAL", ""])("does not invent concern from a clear ESPN status: %s", (status) => {
    expect(hasInjuryConcern("No player-specific injury update was found.", status)).toBe(false);
  });
});
