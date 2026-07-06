import { expect, test } from "vitest";
import { planSprints } from "../src/agents/planner.js";
import { evaluateArtifact, parseScore } from "../src/agents/evaluator.js";
import type { QueryFn } from "../src/agents/invoke.js";

const fakeStream = (text: string): QueryFn => async function* () {
  yield { type: "assistant", message: { content: [{ type: "text", text }] } } as any;
  yield { type: "result", subtype: "success", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } } as any;
};

test("planner parses sprint JSON", async () => {
  const q = fakeStream('[{"title":"S1","description":"do a"},{"title":"S2","description":"do b"}]');
  const sprints = await planSprints({ queryFn: q, model: "m", goal: "g" });
  expect(sprints).toHaveLength(2);
  expect(sprints[0].id).toBe(0);
  expect(sprints[1].title).toBe("S2");
});

test("evaluator parses SCORE line (structural blindness: no generator-output param)", async () => {
  const q = fakeStream("Solid.\nSCORE: 88");
  const r = await evaluateArtifact(
    { queryFn: q, model: "m" },
    { version: 1, criteria: [], frozen: true },
    { passed: true, findings: [] },
  );
  expect(r.score).toBe(88);
});

// Regression: the old anchored /^SCORE:/ parser missed common model formatting
// and silently returned 0, conflating a format failure with a real zero grade.
test("parseScore tolerates markdown/trailing text and never conflates null with 0", () => {
  expect(parseScore("Solid.\nSCORE: 88")).toBe(88);
  expect(parseScore("**SCORE:** 88")).toBe(88);       // markdown bold — old parser gave 0
  expect(parseScore("## Score: 90")).toBe(90);          // heading — old parser gave 0
  expect(parseScore("Final SCORE: 88/100")).toBe(88);   // trailing text
  expect(parseScore("  score:  0  ")).toBe(0);          // a GENUINE zero, not null
  expect(parseScore("clamps to 100\nSCORE: 250")).toBe(100);
  expect(parseScore("no score anywhere in this text")).toBeNull(); // unparseable → null, not 0
  expect(parseScore("critique complete")).toBeNull();
});

test("parseScore takes the LAST score mention (model ends with the SCORE line)", () => {
  expect(parseScore("the score used to be 40 but now\nSCORE: 92")).toBe(92);
});
