import { expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state/store.js";
import type { RunState } from "../src/state/types.js";

const base: RunState = {
  runId: "r1", goal: "g", status: "running", sprints: [],
  currentSprint: 0, contractVersion: 0, scores: [], iterations: 0,
  budgetSpentUsd: 0, haltReason: null,
};

test("round-trips and applies patches", () => {
  const f = join(mkdtempSync(join(tmpdir(), "state-")), "state.json");
  const s = new StateStore(f);
  s.init(base);
  s.update({ iterations: 2, scores: [80] });
  const r = s.read();
  expect(r.iterations).toBe(2);
  expect(r.scores).toEqual([80]);
  expect(r.goal).toBe("g");
});
