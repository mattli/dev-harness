import { expect, test } from "vitest";
import { negotiate, type NegotiateDeps } from "../src/contract/negotiate.js";
import { evaluateArtifact, buildEvaluatePrompt, type EvaluatorDeps } from "../src/agents/evaluator.js";
import { toGraderView, type Contract } from "../src/contract/types.js";
import type { QueryFn } from "../src/agents/invoke.js";
import type { VerifierResult } from "../src/verifier/types.js";

// Cause-#3 structural fix: the blind scorer receives a GraderView (version +
// acceptance criteria) and NEVER the contract's scope. These tests pin that
// guarantee at the boundary that enforces it — the projection + the grader's
// input string — on EVERY negotiation outcome, including the round-cap
// force-freeze that bypasses the adversarial gate (the trapdoor this closes).

const verifier: VerifierResult = { passed: true, findings: [] };
const SCOPE_SENTINEL = "SCOPE-SENTINEL-must-never-reach-the-grader";

function contractWithScope(frozen: boolean): Contract {
  return {
    version: 1,
    criteria: [{ id: "c1", description: "the full verifier passes", verifyBy: "tests pass" }],
    scope: [{ id: "s1", description: SCOPE_SENTINEL }],
    frozen,
  };
}

test("toGraderView drops scope entirely (the projection is the only constructor)", () => {
  const view = toGraderView(contractWithScope(true));
  expect(view).toEqual({
    version: 1,
    criteria: [{ id: "c1", description: "the full verifier passes", verifyBy: "tests pass" }],
  });
  expect("scope" in view).toBe(false);
  expect(JSON.stringify(view)).not.toContain(SCOPE_SENTINEL);
});

// Freeze a contract that ALWAYS carries scope, either by agreement or by never
// agreeing (forcing the round-cap path). Returns the frozen contract + reason.
async function freezeVia(agree: boolean) {
  const deps: NegotiateDeps = {
    propose: async () => contractWithScope(false),
    critique: async (c) => ({ agreed: agree, contract: c, critique: "x" }),
    maxRounds: 3,
  };
  return negotiate(deps);
}

test("grader input never contains scope — agreement freeze path", async () => {
  const { contract, freezeReason } = await freezeVia(true);
  expect(freezeReason).toBe("agreement");
  const prompt = buildEvaluatePrompt(toGraderView(contract), "some diff", verifier);
  expect(prompt).not.toContain(SCOPE_SENTINEL);
  expect(prompt).toContain("the full verifier passes"); // acceptance criteria still reach the grader
});

test("grader input never contains scope — round-cap force-freeze trapdoor", async () => {
  const { contract, freezeReason } = await freezeVia(false); // never agrees → forced at maxRounds
  expect(freezeReason).toBe("round-cap");
  // The frozen contract really does still carry scope — the guarantee is the
  // projection, not that negotiation stripped anything.
  expect(contract.frozen).toBe(true);
  expect(contract.scope.some((s) => s.description === SCOPE_SENTINEL)).toBe(true);
  const prompt = buildEvaluatePrompt(toGraderView(contract), "some diff", verifier);
  expect(prompt).not.toContain(SCOPE_SENTINEL);
});

// --- Regression: the exact mrqghymn failure shape (file-allowlist + tests-pass) ---
// A fake grader that would fail correct work IF it saw the allowlist (the old
// 3/0/4 behavior). With the allowlist filed as scope, the grader never sees it,
// so verifier-passing work that touches a "forbidden" 7th file grades validly.
const ALLOWLIST = "No files other than the six listed files are modified";

const gradingQuery: QueryFn = async function* (args) {
  const score = args.prompt.includes(ALLOWLIST) ? 20 : 95;
  yield { type: "assistant", message: { content: [{ type: "text", text: `FINAL SCORE: ${score}` }] } } as any;
  yield { type: "result", subtype: "success", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } } as any;
};

test("mrqghymn shape: file-allowlist in scope + tests-pass criterion grades correct work validly", async () => {
  const contract: Contract = {
    version: 1,
    frozen: true,
    criteria: [{ id: "c12", description: "the full verifier (tsc --noEmit && vitest run) passes", verifyBy: "verifier is green" }],
    scope: [{ id: "s1", description: ALLOWLIST }],
  };
  const view = toGraderView(contract);
  // The allowlist is structurally absent from what the grader is shown...
  expect(buildEvaluatePrompt(view, "diff", verifier)).not.toContain(ALLOWLIST);

  // ...so a correct, verifier-passing diff that edits a 7th file (the shape that
  // used to score 3/0/4) gets the valid high grade, not the allowlist penalty.
  const diff = "diff --git a/tests/commit-gate.integration.test.ts b/tests/commit-gate.integration.test.ts\n@@ update the 7th file so the verifier passes @@";
  const deps: EvaluatorDeps = { queryFn: gradingQuery, model: "m", goal: "g" };
  const { score } = await evaluateArtifact(deps, view, diff, verifier);
  expect(score).toBe(95);
});
