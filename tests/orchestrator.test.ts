import { expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop, type LoopDeps } from "../src/orchestrator/run.js";
import { loadConfig } from "../src/config/load.js";

const cfg = (over = {}) => loadConfig({
  runId: "r1", goal: "g", projectPath: mkdtempSync(join(tmpdir(), "p-")),
  worktreeRoot: mkdtempSync(join(tmpdir(), "w-")), ...over,
});

const happyDeps = (): LoopDeps => ({
  nowMs: () => 0,
  runsDir: mkdtempSync(join(tmpdir(), "runs-")),
  planSprints: async () => [{ id: 0, title: "S", description: "d" }],
  proposeContract: async (_sprint, prev) => ({ version: (prev?.contract.version ?? 0) + 1, criteria: [], frozen: false }),
  critiqueContract: async (_sprint, c) => ({ agreed: true, contract: c, critique: "ok" }),
  generateCode: async () => ({ text: "done", costUsd: 0.1, tokens: 10, toolCalls: [] }),
  runVerifier: async () => ({ passed: true, findings: [] }),
  worktreeDiff: async () => "diff --git a/sum.js b/sum.js\n+sum",
  evaluateArtifact: async () => ({ score: 90, findings: [] }),
  createWorktree: async () => ({ path: "/tmp/wt", branch: "run/g-r1" }),
  commitWorktree: async () => true,
  removeWorktree: async () => {},
});

test("happy path: one sprint passes, status=passed", async () => {
  const state = await runLoop(cfg(), happyDeps());
  expect(state.status).toBe("passed");
  expect(state.scores).toContain(90);
});

// Blocker #2 regression: currentSprint/contractVersion must reach the trace (the
// spec's primary review artifact), not stay stuck at the initial 0. Would have
// caught the disk-only-update bug that collapsed multi-sprint runs under Sprint 0.
test("multi-sprint run records distinct sprint numbers + contract versions in trace/transcript", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const deps: LoopDeps = {
    ...happyDeps(),
    runsDir,
    planSprints: async () => [
      { id: 0, title: "S0", description: "d0" },
      { id: 1, title: "S1", description: "d1" },
    ],
  };
  const state = await runLoop(cfg(), deps);
  expect(state.status).toBe("passed");

  const trace = readFileSync(join(runsDir, "r1", "trace.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const gen = trace.filter((e) => e.phase === "GENERATE");
  expect([...new Set(gen.map((e) => e.sprint))].sort()).toEqual([0, 1]); // not collapsed to 0
  expect(gen.every((e) => e.contractVersion > 0)).toBe(true);           // not stale v0

  const transcript = readFileSync(join(runsDir, "r1", "transcript.md"), "utf8");
  expect(transcript).toContain("## Sprint 0");
  expect(transcript).toContain("## Sprint 1");
});

test("records the agreement freeze reason in state", async () => {
  const state = await runLoop(cfg(), happyDeps());
  expect(state.contractFreezeReason).toBe("agreement");
});

test("records the round-cap freeze reason in state and transcript", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const deps: LoopDeps = {
    ...happyDeps(),
    runsDir,
    // Never agree → negotiation is forced to freeze when it hits the round cap.
    critiqueContract: async (_sprint, c) => ({ agreed: false, contract: c, critique: "no" }),
  };
  const state = await runLoop(cfg({ caps: { negotiationRounds: 2 } }), deps);
  expect(state.status).toBe("passed");
  expect(state.contractFreezeReason).toBe("round-cap");

  const transcript = readFileSync(join(runsDir, "r1", "transcript.md"), "utf8");
  expect(transcript).toContain("frozen (round-cap)");
});

test("NEGOTIATE trace event carries the frozen contract's criteria", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const deps: LoopDeps = {
    ...happyDeps(),
    runsDir,
    proposeContract: async (_sprint, prev) => ({
      version: (prev?.contract.version ?? 0) + 1, frozen: false,
      criteria: [{ id: "c1", description: "sum(a,b)=a+b", verifyBy: "node:test" }],
    }),
  };
  const state = await runLoop(cfg(), deps);
  expect(state.status).toBe("passed");

  const trace = readFileSync(join(runsDir, "r1", "trace.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const neg = trace.find((e) => e.phase === "NEGOTIATE");
  expect(neg.contract.criteria[0].id).toBe("c1");

  const transcript = readFileSync(join(runsDir, "r1", "transcript.md"), "utf8");
  expect(transcript).toContain("c1: sum(a,b)=a+b [verify: node:test]");
});

test("halts when score never reaches threshold (max-iteration)", async () => {
  const deps = { ...happyDeps(), evaluateArtifact: async () => ({ score: 10, findings: ["bad"] }) };
  const state = await runLoop(cfg({ caps: { maxIterationsPerSprint: 2 } }), deps);
  expect(state.status).toBe("halted");
  expect(state.haltReason).toBe("max-iteration");
});

test("halts on an unparseable evaluator score (error, never treated as 0)", async () => {
  let removed = false;
  const deps: LoopDeps = {
    ...happyDeps(),
    evaluateArtifact: async () => ({ score: null, findings: [] }),
    removeWorktree: async () => { removed = true; },
  };
  const state = await runLoop(cfg(), deps);
  expect(state.status).toBe("halted");
  expect(state.haltReason).toBe("evaluator-parse-error");
  expect(state.scores).toEqual([]); // null never pushed as a score
  expect(removed).toBe(true);
});

test("halts mid-negotiation when a backstop trips before the first Opus call", async () => {
  // startMs = first nowMs() call (0); every later call exceeds wallClockMs.
  let calls = 0;
  const nowMs = () => (calls++ === 0 ? 0 : 999999);
  let proposed = false;
  let generated = false;
  let removed = false;
  const deps: LoopDeps = {
    ...happyDeps(),
    nowMs,
    proposeContract: async (_sprint, prev) => { proposed = true; return { version: (prev?.contract.version ?? 0) + 1, criteria: [], frozen: false }; },
    generateCode: async () => { generated = true; return { text: "", costUsd: 0, tokens: 0, toolCalls: [] }; },
    removeWorktree: async () => { removed = true; },
  };
  const state = await runLoop(cfg({ caps: { wallClockMs: 1000 } }), deps);
  expect(state.status).toBe("halted");
  expect(state.haltReason).toBe("wall-clock");
  expect(proposed).toBe(false); // aborted before any negotiation Opus call
  expect(generated).toBe(false);
  expect(removed).toBe(true); // graceful path: worktree removed in finally, branch survives
});
