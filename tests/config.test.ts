import { expect, test } from "vitest";
import { loadConfig } from "../src/config/load.js";

test("applies defaults and requires goal + projectPath", () => {
  const c = loadConfig({ goal: "build x", projectPath: "/tmp/app", runId: "r1" });
  expect(c.caps.dollarCeiling).toBe(10);
  expect(c.caps.negotiationRounds).toBe(5);
  expect(c.thresholds.advanceScore).toBe(85);
  expect(c.models.planner).toBe("claude-opus-4-8");
});

test("overrides win over defaults", () => {
  const c = loadConfig({ goal: "g", projectPath: "/tmp/app", runId: "r1", caps: { dollarCeiling: 3 } });
  expect(c.caps.dollarCeiling).toBe(3);
  expect(c.caps.maxIterationsPerSprint).toBe(6); // untouched default preserved
});

test("rejects missing goal", () => {
  expect(() => loadConfig({ projectPath: "/tmp/app", runId: "r1" } as any)).toThrow();
});
