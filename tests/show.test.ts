import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestRunSummary } from "../src/report/show.js";
import type { RunState } from "../src/state/types.js";

const writeRun = (runsDir: string, proj: string, folder: string, state: Partial<RunState>) => {
  const dir = join(runsDir, proj, folder);
  mkdirSync(dir, { recursive: true });
  const full: RunState = {
    runId: "x", goal: "g", title: "demo", startedAt: "2026-07-08T00:00:00.000Z",
    status: "passed", sprints: [{ id: 0, title: "a", description: "" }], currentSprint: 0,
    contractVersion: 1, scores: [90], iterations: 1, budgetSpentUsd: 1, haltReason: null,
    contractFreezeReason: "agreement", ...state,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(full));
};

test("latestRunSummary renders the most recent run for a project", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  writeRun(runsDir, "csv-tool", "2026-07-06-old", { title: "old-run", startedAt: "2026-07-06T00:00:00.000Z" });
  writeRun(runsDir, "csv-tool", "2026-07-08-new", { title: "new-run", startedAt: "2026-07-08T00:00:00.000Z" });
  const out = latestRunSummary(runsDir, "/tmp/csv-tool");
  expect(out).toContain("new-run");
  expect(out).not.toContain("old-run");
});

test("latestRunSummary picks newest by start time, not lexical folder order (-2 vs -10)", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  writeRun(runsDir, "csv-tool", "2026-07-08-foo-2", { title: "run-2", startedAt: "2026-07-08T02:00:00.000Z" });
  writeRun(runsDir, "csv-tool", "2026-07-08-foo-10", { title: "run-10", startedAt: "2026-07-08T10:00:00.000Z" });
  const out = latestRunSummary(runsDir, "/tmp/csv-tool");
  expect(out).toContain("run-10"); // lexically "foo-10" < "foo-2", but it started later
});

test("latestRunSummary skips folders without a readable state.json", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  mkdirSync(join(runsDir, "csv-tool", "2026-07-09-broken"), { recursive: true }); // no state.json
  writeRun(runsDir, "csv-tool", "2026-07-08-good", { title: "good-run", startedAt: "2026-07-08T00:00:00.000Z" });
  const out = latestRunSummary(runsDir, "/tmp/csv-tool");
  expect(out).toContain("good-run");
});

test("latestRunSummary breaks startedAt ties deterministically by folder name", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const ts = "2026-07-08T00:00:00.000Z"; // identical start time (concurrent runs)
  writeRun(runsDir, "csv-tool", "2026-07-08-run-a", { title: "run-a", startedAt: ts });
  writeRun(runsDir, "csv-tool", "2026-07-08-run-b", { title: "run-b", startedAt: ts });
  // Deterministic across runs: the lexically-greater folder name wins the tie.
  expect(latestRunSummary(runsDir, "/tmp/csv-tool")).toContain("run-b");
  expect(latestRunSummary(runsDir, "/tmp/csv-tool")).toContain("run-b");
});

test("latestRunSummary throws a clear error when the project has no runs", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  expect(() => latestRunSummary(runsDir, "/tmp/nope")).toThrow(/no runs/i);
});
