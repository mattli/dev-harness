import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestRunSummary, pickLatest } from "../src/report/show.js";
import type { RunState } from "../src/state/types.js";

const mkState = (over: Partial<RunState>): RunState => ({
  runId: "x", goal: "g", title: "demo", startedAt: "2026-07-08T00:00:00.000Z",
  status: "passed", sprints: [], currentSprint: 0, contractVersion: 1, scores: [],
  iterations: 0, budgetSpentUsd: 0, haltReason: null, contractFreezeReason: "agreement", ...over,
});

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

test("pickLatest breaks startedAt ties by folder name, independent of input order", () => {
  const ts = "2026-07-08T00:00:00.000Z"; // identical start time (concurrent runs)
  const a = { name: "2026-07-08-run-a", state: mkState({ title: "run-a", startedAt: ts }) };
  const b = { name: "2026-07-08-run-b", state: mkState({ title: "run-b", startedAt: ts }) };
  // Same winner regardless of the order the entries were read from disk.
  expect(pickLatest([a, b]).title).toBe("run-b");
  expect(pickLatest([b, a]).title).toBe("run-b");
});

test("pickLatest throws on empty input rather than reading undefined", () => {
  expect(() => pickLatest([])).toThrow(/no runs/i);
});

test("pickLatest orders by start time when it differs", () => {
  const older = { name: "2026-07-06-x", state: mkState({ title: "older", startedAt: "2026-07-06T00:00:00.000Z" }) };
  const newer = { name: "2026-07-08-y", state: mkState({ title: "newer", startedAt: "2026-07-08T00:00:00.000Z" }) };
  expect(pickLatest([newer, older]).title).toBe("newer");
  expect(pickLatest([older, newer]).title).toBe("newer");
});

test("latestRunSummary throws a clear error when the project has no runs", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  expect(() => latestRunSummary(runsDir, "/tmp/nope")).toThrow(/no runs/i);
});
