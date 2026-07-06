import { expect, test } from "vitest";
import { planSprints } from "../src/agents/planner.js";
import { evaluateArtifact } from "../src/agents/evaluator.js";
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

test("evaluator parses SCORE line and is blind (no generator text in prompt)", async () => {
  const q = fakeStream("Solid.\nSCORE: 88");
  const r = await evaluateArtifact(
    { queryFn: q, model: "m" },
    { version: 1, criteria: [], frozen: true },
    { passed: true, findings: [] },
  );
  expect(r.score).toBe(88);
});
