import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
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
