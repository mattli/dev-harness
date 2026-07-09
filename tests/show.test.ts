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
  writeRun(runsDir, "csv-tool", "2026-07-06-old", { title: "old-run" });
  writeRun(runsDir, "csv-tool", "2026-07-08-new", { title: "new-run" });
  const out = latestRunSummary(runsDir, "/tmp/csv-tool");
  expect(out).toContain("new-run");
  expect(out).not.toContain("old-run");
});

test("latestRunSummary throws a clear error when the project has no runs", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  expect(() => latestRunSummary(runsDir, "/tmp/nope")).toThrow(/no runs/i);
});
