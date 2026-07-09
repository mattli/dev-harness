import { expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop, type LoopDeps } from "../src/orchestrator/run.js";
import { loadConfig } from "../src/config/load.js";
import { buildRunDir } from "../src/state/run-path.js";

const cfg = (over = {}) => loadConfig({
  runId: "r1", goal: "g", projectPath: mkdtempSync(join(tmpdir(), "p-")),
  worktreeRoot: mkdtempSync(join(tmpdir(), "w-")), ...over,
});

// The run folder the loop will create, given a fake planRun title of "test-run"
// and nowMs()=0. Config carries projectPath + runId; siblings start empty.
const runDirOf = (config: { projectPath: string }, runsDir: string) =>
  buildRunDir(runsDir, config.projectPath, "test-run", 0, []);

const happyDeps = (): LoopDeps => ({
  nowMs: () => 0,
  runsDir: mkdtempSync(join(tmpdir(), "runs-")),
  planRun: async () => ({ title: "test-run", sprints: [{ id: 0, title: "S", description: "d" }] }),
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
  const config = cfg();
  const deps: LoopDeps = {
    ...happyDeps(),
    runsDir,
    planRun: async () => ({ title: "test-run", sprints: [
      { id: 0, title: "S0", description: "d0" },
      { id: 1, title: "S1", description: "d1" },
    ] }),
  };
  const state = await runLoop(config, deps);
  expect(state.status).toBe("passed");

  const dir = runDirOf(config, runsDir);
  const trace = readFileSync(join(dir, "trace.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const gen = trace.filter((e) => e.phase === "GENERATE");
  expect([...new Set(gen.map((e) => e.sprint))].sort()).toEqual([0, 1]); // not collapsed to 0
  expect(gen.every((e) => e.contractVersion > 0)).toBe(true);           // not stale v0

  const transcript = readFileSync(join(dir, "transcript.md"), "utf8");
  expect(transcript).toContain("Stage 0");
  expect(transcript).toContain("Stage 1");
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
  const config = cfg({ caps: { negotiationRounds: 2 } });
  const state = await runLoop(config, deps);
  expect(state.status).toBe("passed");
  expect(state.contractFreezeReason).toBe("round-cap");

  const transcript = readFileSync(join(runDirOf(config, runsDir), "transcript.md"), "utf8");
  expect(transcript).toContain("Stage 0"); // freeze reason itself is asserted in state above
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
  const config = cfg();
  const state = await runLoop(config, deps);
  expect(state.status).toBe("passed");

  const dir = runDirOf(config, runsDir);
  const trace = readFileSync(join(dir, "trace.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const neg = trace.find((e) => e.phase === "NEGOTIATE");
  expect(neg.contract.criteria[0].id).toBe("c1");

  const transcript = readFileSync(join(dir, "transcript.md"), "utf8");
  expect(transcript).toContain("sum(a,b)=a+b");
});

test("a planner failure persists an inspectable halted run instead of crashing", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  let worktreeCreated = false;
  const config = cfg();
  const deps: LoopDeps = {
    ...happyDeps(), runsDir,
    planRun: async () => { throw new Error("model returned garbage"); },
    createWorktree: async () => { worktreeCreated = true; return { path: "/tmp/wt", branch: "run/g-r1" }; },
  };
  const state = await runLoop(config, deps);
  expect(state.status).toBe("halted");
  expect(state.haltReason).toBe("planner-error");
  expect(worktreeCreated).toBe(false); // stopped before any worktree was made

  // The run must survive on disk for post-mortem; state carries its folder.
  expect(state.runDir).toBeTruthy();
  expect(readFileSync(join(state.runDir!, "state.json"), "utf8")).toContain("planner-error");
  expect(readFileSync(join(state.runDir!, "transcript.md"), "utf8")).toContain("could not plan the run");
});

test("halts when score never reaches threshold (max-iteration)", async () => {
  const deps = { ...happyDeps(), evaluateArtifact: async () => ({ score: 10, findings: ["bad"] }) };
  const state = await runLoop(cfg({ caps: { maxIterationsPerSprint: 2 } }), deps);
  expect(state.status).toBe("halted");
  expect(state.haltReason).toBe("max-iteration");
});

// Real-I/O boundary: the transcript is rendered inside haltRun, so it must be
// written AFTER the halt status/reason are set — a unit test that injects state
// can't catch the ordering bug where the on-disk transcript still says "running".
test("a halted run's on-disk transcript shows the stop outcome, not 'running'", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const config = cfg({ caps: { maxIterationsPerSprint: 2 } });
  const deps = { ...happyDeps(), runsDir, evaluateArtifact: async () => ({ score: 10, findings: ["bad"] }) };
  const state = await runLoop(config, deps);
  expect(state.status).toBe("halted");

  const transcript = readFileSync(join(runDirOf(config, runsDir), "transcript.md"), "utf8");
  expect(transcript).toContain("Stopped"); // the outcome line reflects the halt
  expect(transcript).not.toContain("Still running");
  expect(transcript).toContain("max-iteration"); // the reason is surfaced
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
