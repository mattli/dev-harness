import { expect, test } from "vitest";
import { planSprints } from "../src/agents/planner.js";
import { evaluateArtifact, parseScore, buildEvaluatePrompt, buildCritiquePrompt } from "../src/agents/evaluator.js";
import { buildProposePrompt, buildGeneratePrompt } from "../src/agents/generator.js";
import type { QueryFn } from "../src/agents/invoke.js";
import type { Sprint } from "../src/state/types.js";
import type { Contract } from "../src/contract/types.js";

const fakeStream = (text: string): QueryFn => async function* () {
  yield { type: "assistant", message: { content: [{ type: "text", text }] } } as any;
  yield { type: "result", subtype: "success", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } } as any;
};

const sprint: Sprint = { id: 2, title: "Implement sum module", description: "export sum(a,b)=a+b" };
const contract: Contract = { version: 1, criteria: [{ id: "c1", description: "sum works", verifyBy: "test" }], frozen: true };

test("planner parses sprint JSON", async () => {
  const q = fakeStream('[{"title":"S1","description":"do a"},{"title":"S2","description":"do b"}]');
  const sprints = await planSprints({ queryFn: q, model: "m", goal: "g" });
  expect(sprints).toHaveLength(2);
  expect(sprints[0].id).toBe(0);
  expect(sprints[1].title).toBe("S2");
});

test("evaluator parses SCORE line (grades artifact diff vs contract)", async () => {
  const q = fakeStream("Solid.\nSCORE: 88");
  const r = await evaluateArtifact(
    { queryFn: q, model: "m", goal: "g" },
    contract,
    "diff --git a/sum.js b/sum.js\n+module.exports.sum = (a,b)=>a+b;",
    { passed: true, findings: [] },
  );
  expect(r.score).toBe(88);
});

// Regression: the old anchored /^SCORE:/ parser missed common model formatting
// and silently returned 0, conflating a format failure with a real zero grade.
test("parseScore tolerates markdown/trailing text and never conflates null with 0", () => {
  expect(parseScore("Solid.\nSCORE: 88")).toBe(88);
  expect(parseScore("**SCORE:** 88")).toBe(88);
  expect(parseScore("## Score: 90")).toBe(90);
  expect(parseScore("Final SCORE: 88/100")).toBe(88);
  expect(parseScore("  score:  0  ")).toBe(0);
  expect(parseScore("clamps to 100\nSCORE: 250")).toBe(100);
  expect(parseScore("no score anywhere in this text")).toBeNull();
});

// Blocker #1 regression: the evaluator ends with "SCORE: <n>" THEN lists findings.
// A prose mention of a score in a finding must not hijack the grade.
test("parseScore requires a label so post-SCORE findings can't hijack the grade", () => {
  expect(parseScore("SCORE: 88\n- The current score of 0 for edge cases is a problem")).toBe(88);
  expect(parseScore("SCORE: 88\n- Aim for a score of 95 next round")).toBe(88);
});

// When MULTIPLE genuinely-labelled scores appear (the verdict + a finding quoting
// a labelled score from the code under test), the FIRST label — the verdict — wins.
test("parseScore takes the verdict (first labelled score), not a labelled score quoted in a finding", () => {
  expect(parseScore("SCORE: 88\n- the code sets score=0 which is wrong")).toBe(88);
  expect(parseScore("SCORE: 91\n- found `score: 40` hardcoded in config.js")).toBe(91);
});

// C1 plumbing: the generator now receives the goal + sprint (tested property).
test("generator prompts contain the goal and the sprint (C1)", () => {
  const propose = buildProposePrompt("add sum.js exporting sum(a,b)", sprint, null);
  expect(propose).toContain("add sum.js exporting sum(a,b)");
  expect(propose).toContain("Implement sum module");
  expect(propose).toContain("export sum(a,b)=a+b");

  const generate = buildGeneratePrompt("add sum.js exporting sum(a,b)", sprint, contract);
  expect(generate).toContain("add sum.js exporting sum(a,b)");
  expect(generate).toContain("Implement sum module");
  expect(generate).toContain("sum works"); // the frozen contract's criterion
});

test("critique prompt contains the goal + sprint so it can reject an off-goal contract (C1)", () => {
  const p = buildCritiquePrompt("add sum.js exporting sum(a,b)", sprint, contract);
  expect(p).toContain("add sum.js exporting sum(a,b)");
  expect(p).toContain("Implement sum module");
});

// C2 plumbing (REQUIRED): the evaluator's EVALUATE context is a hard, tested
// boundary — it CONTAINS the artifact diff and EXCLUDES the transcript, commit
// messages, and goal/sprint. A leak channel reopening must fail here, not depend
// on the model obeying the prompt.
test("evaluate prompt contains the artifact diff (C2)", () => {
  const diff = "diff --git a/sum.js b/sum.js\n+module.exports.sum = (a,b)=>a+b;";
  const p = buildEvaluatePrompt(contract, diff, { passed: true, findings: [] });
  expect(p).toContain(diff);
  expect(p).toContain("sum works"); // the contract it grades against
});

test("evaluate prompt EXCLUDES transcript, commit messages, and goal/sprint (C2 boundary)", () => {
  const diff = "diff --git a/sum.js b/sum.js\n+ok";
  const p = buildEvaluatePrompt(contract, diff, { passed: true, findings: [] });
  // These are deliberately not parameters of buildEvaluatePrompt; assert they
  // cannot appear even if a caller mistakenly tried to smuggle them via the diff.
  const GENERATOR_TRANSCRIPT = "I chose this approach because it is elegant";
  const COMMIT_MESSAGE = "sprint 0 passed (score 100)";
  const GOAL = "add sum.js exporting sum(a,b)";
  const SPRINT_TITLE = "Implement sum module";
  expect(p).not.toContain(GENERATOR_TRANSCRIPT);
  expect(p).not.toContain(COMMIT_MESSAGE);
  expect(p).not.toContain(GOAL);
  expect(p).not.toContain(SPRINT_TITLE);
});
