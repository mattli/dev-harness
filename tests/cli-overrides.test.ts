import { describe, expect, test } from "vitest";
import { buildRunOverrides } from "../src/cli/overrides.js";

describe("buildRunOverrides", () => {
  test("maps caps flags to config overrides", () => {
    const o = buildRunOverrides(
      { goal: "g", project: "/p", wallClockMs: 60000, maxIterations: 3, dollarCeiling: 5 },
      "rid"
    );
    expect(o.caps).toEqual({ wallClockMsPerSprint: 60000, maxIterationsPerSprint: 3, dollarCeiling: 5 });
  });

  test("omits caps entirely when no cap flags are given", () => {
    const o = buildRunOverrides({ goal: "g", project: "/p" }, "rid");
    expect(o.caps).toBeUndefined();
  });
});
