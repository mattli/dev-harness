import { expect, test } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceWriter } from "../src/trace/writer.js";
import { renderTranscript } from "../src/trace/renderer.js";
import type { TraceEvent } from "../src/trace/types.js";

const ev = (over: Partial<TraceEvent> = {}): TraceEvent => ({
  ts: "2026-07-06T00:00:00Z", runId: "r1", sprint: 0, phase: "PLAN",
  agentRole: "planner", contractVersion: 0, inputDigest: "in", toolCalls: [],
  outputDigest: "out", tokens: 10, costUsd: 0.01, ...over,
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
  // Run 1 leaves two events behind at this path.
  const w1 = new TraceWriter(f);
  w1.write(ev()); w1.write(ev({ phase: "GENERATE" }));
  // Run 2 reuses the same runId → same path. It must start clean, not append.
  const w2 = new TraceWriter(f);
  w2.write(ev({ phase: "EVALUATE" }));
  const lines = readFileSync(f, "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]).phase).toBe("EVALUATE");
});

test("renderer groups by sprint and phase", () => {
  const md = renderTranscript([ev(), ev({ phase: "GENERATE", agentRole: "generator" })]);
  expect(md).toContain("# Run r1");
  expect(md).toContain("PLAN");
  expect(md).toContain("GENERATE");
});
