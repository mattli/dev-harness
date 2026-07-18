import { expect, test } from "vitest";
import { renderSummary, describeOutcome } from "../src/report/summary.js";
import type { RunState } from "../src/state/types.js";

const base = (over: Partial<RunState> = {}): RunState => ({
  runId: "abc", goal: "Build a CSV converter", title: "csv-json-converter",
  startedAt: "2026-07-08T14:00:00.000Z", status: "halted",
  sprints: [{ id: 0, title: "a", description: "" }, { id: 1, title: "b", description: "" },
            { id: 2, title: "c", description: "" }, { id: 3, title: "d", description: "" }],
  currentSprint: 3, contractVersion: 5, scores: [100, 98, 96], iterations: 3,
  budgetSpentUsd: 6.8, haltReason: "dollar-ceiling", contractFreezeReason: "agreement",
  projectPath: "/Users/me/dev/csv-tool",
  runDir: "/Users/me/dev/csv-tool/runs/csv-tool/2026-07-08-csv-json-converter", ...over,
});

test("dollar-ceiling summary names the limit and spend, and gives no advice", () => {
  const s = renderSummary(base());
  expect(s).toContain("csv-json-converter — 2026-07-08");
  expect(s).toContain("Paused — hit the spending limit you set ($6.80)");
  expect(s).toContain("Progress: 3 of 4 stages finished");
  expect(s).toContain("scored 100, 98, 96 out of 100");
  expect(s).toContain("Spent:    $6.80");
  expect(s).toContain("Code:     branch run-abc in /Users/me/dev/csv-tool");
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

test("a wall-clock halt reads as paused, not failed", () => {
  expect(describeOutcome(base({ haltReason: "wall-clock" }))).toMatch(/paused/i);
});

test("a subscription usage-limit has its own plain-language line", () => {
  expect(describeOutcome(base({ haltReason: "usage-limit" }))).toMatch(/subscription usage limit/i);
});

test("a run with no scores yet says so", () => {
  expect(renderSummary(base({ scores: [] }))).toContain("no stages scored yet");
});

test("the summary tells you which folder holds the run's artifacts", () => {
  expect(renderSummary(base())).toContain("Records:  /Users/me/dev/csv-tool/runs/csv-tool/2026-07-08-csv-json-converter");
});

test("a run missing projectPath falls back gracefully instead of crashing", () => {
  const legacy = base();
  delete (legacy as { projectPath?: string }).projectPath;
  expect(() => renderSummary(legacy)).not.toThrow();
  expect(renderSummary(legacy)).toContain("(unknown project path)");
});

test("a legacy run missing startedAt renders instead of crashing", () => {
  const legacy = base();
  delete (legacy as { startedAt?: string }).startedAt;
  expect(() => renderSummary(legacy)).not.toThrow();
  expect(renderSummary(legacy)).toContain("unknown date");
});
