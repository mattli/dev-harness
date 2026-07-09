import { expect, test } from "vitest";
import { renderSummary, describeOutcome } from "../src/report/summary.js";
import type { RunState } from "../src/state/types.js";

const base = (over: Partial<RunState> = {}): RunState => ({
  runId: "abc", goal: "Build a CSV converter", title: "csv-json-converter",
  startedAt: "2026-07-08T14:00:00.000Z", status: "halted",
  sprints: [{ id: 0, title: "a", description: "" }, { id: 1, title: "b", description: "" },
            { id: 2, title: "c", description: "" }, { id: 3, title: "d", description: "" }],
  currentSprint: 3, contractVersion: 5, scores: [100, 98, 96], iterations: 3,
  budgetSpentUsd: 6.8, haltReason: "dollar-ceiling", contractFreezeReason: "agreement", ...over,
});

test("dollar-ceiling summary names the limit and spend, and gives no advice", () => {
  const s = renderSummary(base());
  expect(s).toContain("csv-json-converter — 2026-07-08");
  expect(s).toContain("Stopped early — hit the spending limit ($6.80)");
  expect(s).toContain("Progress: 3 of 4 stages finished");
  expect(s).toContain("scored 100, 98, 96 out of 100");
  expect(s).toContain("Spent:    $6.80");
  expect(s).toContain("branch run/build-a-csv-converter-abc");
  expect(s).not.toMatch(/next/i); // descriptive only, no recommendations
});

test("passed run reports success and all stages finished", () => {
  const s = renderSummary(base({ status: "passed", haltReason: null, currentSprint: 3 }));
  expect(s).toContain("Finished successfully — all stages passed");
  expect(s).toContain("Progress: 4 of 4 stages finished");
});

test("describeOutcome maps each halt code to plain English", () => {
  expect(describeOutcome(base({ haltReason: "wall-clock" }))).toContain("time limit");
  expect(describeOutcome(base({ haltReason: "max-iteration" }))).toContain("retry limit");
  expect(describeOutcome(base({ haltReason: "no-progress" }))).toContain("stopped improving");
  expect(describeOutcome(base({ haltReason: "evaluator-parse-error" }))).toContain("grading error");
});

test("an unknown halt code degrades gracefully instead of throwing", () => {
  expect(describeOutcome(base({ haltReason: "some-new-reason" }))).toBe("Stopped — some-new-reason");
});

test("a run with no scores yet says so", () => {
  expect(renderSummary(base({ scores: [] }))).toContain("no stages scored yet");
});
