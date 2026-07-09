import { expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter } from "../src/trace/writer.js";
import { renderTranscript } from "../src/trace/renderer.js";
import type { TraceEvent } from "../src/trace/types.js";
import type { RunState } from "../src/state/types.js";

const ev = (over: Partial<TraceEvent> = {}): TraceEvent => ({
  ts: "2026-07-06T00:00:00Z", runId: "r1", sprint: 0, phase: "PLAN",
  agentRole: "planner", contractVersion: 0, inputDigest: "in", toolCalls: [],
  outputDigest: "out", tokens: 10, costUsd: 0.01, ...over,
});

const st = (over: Partial<RunState> = {}): RunState => ({
  runId: "r1", goal: "g", title: "demo", startedAt: "2026-07-08T00:00:00.000Z",
  status: "passed", sprints: [{ id: 0, title: "Scaffolding", description: "" }],
  currentSprint: 0, contractVersion: 1, scores: [100], iterations: 1,
  budgetSpentUsd: 0.72, haltReason: null, contractFreezeReason: "agreement", ...over,
});

test("writer appends one JSON line per event", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-"));
  const f = join(dir, "trace.jsonl");
  const w = new TraceWriter(f);
  w.write(ev()); w.write(ev({ phase: "GENERATE" }));
  const lines = readFileSync(f, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1]).phase).toBe("GENERATE");
});

test("a fresh writer truncates a prior run's trace at the same path", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-"));
  const f = join(dir, "trace.jsonl");
  const w1 = new TraceWriter(f);
  w1.write(ev()); w1.write(ev({ phase: "GENERATE" }));
  const w2 = new TraceWriter(f);
  w2.write(ev({ phase: "EVALUATE" }));
  const lines = readFileSync(f, "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]).phase).toBe("EVALUATE");
});

test("transcript opens with the plain-English summary", () => {
  const md = renderTranscript([ev({ phase: "PLAN" })], st());
  expect(md).toContain("demo — 2026-07-08");
  expect(md).toContain("Finished successfully — all stages passed");
});

test("transcript narrates a stage with its title, score, cost, and tool counts", () => {
  const md = renderTranscript([
    ev({ phase: "GENERATE", agentRole: "generator", sprint: 0, costUsd: 0.72,
         toolCalls: ["Write", "Write", "Bash"] }),
    ev({ phase: "EVALUATE", agentRole: "evaluator", sprint: 0, outputDigest: "score 100", score: 100 }),
  ], st());
  expect(md).toContain("Stage 0 — Scaffolding");
  expect(md).toContain("100/100");
  expect(md).toContain("$0.72");
  expect(md).toContain("created 2 files");
  expect(md).toContain("ran 1 command");
});

test("a stage that retried sums cost and tools across all its attempts", () => {
  const md = renderTranscript([
    ev({ phase: "GENERATE", agentRole: "generator", sprint: 0, costUsd: 0.10, toolCalls: ["Write"] }),
    ev({ phase: "EVALUATE", agentRole: "evaluator", sprint: 0, outputDigest: "score 40", score: 40 }),
    ev({ phase: "GENERATE", agentRole: "generator", sprint: 0, costUsd: 0.20, toolCalls: ["Edit", "Bash"] }),
    ev({ phase: "EVALUATE", agentRole: "evaluator", sprint: 0, outputDigest: "score 90", score: 90 }),
  ], st());
  expect(md).toContain("$0.30");        // 0.10 + 0.20, not just the first attempt
  expect(md).toContain("90/100");        // the last score, not the failed 40
  expect(md).toContain("created 1 file");
  expect(md).toContain("revised 1 time");
  expect(md).toContain("ran 1 command");
});

test("the stage the run died on is 'stopped', not 'not reached'; later stages are not reached", () => {
  const s = st({ status: "halted", haltReason: "dollar-ceiling", currentSprint: 1,
    sprints: [{ id: 0, title: "Scaffolding", description: "" },
              { id: 1, title: "Parsing", description: "" },
              { id: 2, title: "CLI", description: "" }] });
  const md = renderTranscript([
    ev({ phase: "GENERATE", agentRole: "generator", sprint: 0, costUsd: 0.72, toolCalls: ["Write"] }),
    ev({ phase: "EVALUATE", agentRole: "evaluator", sprint: 0, outputDigest: "score 100", score: 100 }),
    ev({ phase: "DECIDE", agentRole: "system", sprint: 1, outputDigest: "halt:dollar-ceiling" }),
  ], s);
  expect(md).toMatch(/Stage 1 — Parsing.*stopped/s);
  expect(md).toContain("stopped while preparing this stage (dollar-ceiling)");
  expect(md).toContain("Stage 2 — CLI");
  expect(md).toContain("not reached");
  expect(md).not.toContain("$0.0000");
});

test("transcript still surfaces a stage's frozen requirements (criteria)", () => {
  const md = renderTranscript([
    ev({ phase: "NEGOTIATE", agentRole: "system", sprint: 0, outputDigest: "frozen (round-cap)",
         contract: { version: 1, frozen: true,
           criteria: [{ id: "c1", description: "sum(a,b)=a+b", verifyBy: "node:test" }] } }),
    ev({ phase: "EVALUATE", agentRole: "evaluator", sprint: 0, outputDigest: "score 100", score: 100 }),
  ], st());
  expect(md).toContain("sum(a,b)=a+b");
});

test("transcript collapses newlines in a criterion so it stays on one line", () => {
  const md = renderTranscript([
    ev({ phase: "NEGOTIATE", agentRole: "system", sprint: 0,
         contract: { version: 1, frozen: true,
           criteria: [{ id: "c1", description: "first\nsecond", verifyBy: "t" }] } }),
    ev({ phase: "EVALUATE", agentRole: "evaluator", sprint: 0, outputDigest: "score 100", score: 100 }),
  ], st());
  expect(md).toContain("first second");
  expect(md).not.toMatch(/^second/m);
});

test("transcript tolerates a NEGOTIATE contract missing its criteria array", () => {
  expect(() => renderTranscript([
    ev({ phase: "NEGOTIATE", agentRole: "system", sprint: 0, contract: { version: 1, frozen: true } as never }),
    ev({ phase: "EVALUATE", agentRole: "evaluator", sprint: 0, outputDigest: "score 100", score: 100 }),
  ], st())).not.toThrow();
});
