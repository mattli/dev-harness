import { expect, test } from "vitest";
import { negotiate, type NegotiateDeps } from "../src/contract/negotiate.js";
import { evaluateArtifact, buildEvaluatePrompt, type EvaluatorDeps } from "../src/agents/evaluator.js";
import { proposeContract } from "../src/agents/generator.js";
import { toGraderView, type Contract } from "../src/contract/types.js";
import type { QueryFn } from "../src/agents/invoke.js";
import type { Sprint } from "../src/state/types.js";
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
// A plausible grader that keys on the DIFF: it rewards the criterion being met
// (the diff shows the edit that makes the verifier pass) but docks hard if it can
// see a file-allowlist restriction — the pre-fix 3/0/4 behavior. Keying on
// diff-derived content (not a constant) means the test exercises real grading, so
// a green result reflects "correct work graded fairly," not a restatement of the
// projection test.
const ALLOWLIST = "No files other than the six listed files are modified";
const SEVENTH_FILE = "commit-gate.integration.test.ts";

const gradingQuery: QueryFn = async function* (args) {
  const sawAllowlist = args.prompt.includes(ALLOWLIST);
  const meetsCriterion = args.prompt.includes(SEVENTH_FILE); // the diff shows the fix
  const score = sawAllowlist ? 20 : meetsCriterion ? 95 : 50;
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
  // used to score 3/0/4) gets the valid high grade, not the allowlist penalty. The
  // fake reads the 7th-file edit from the diff — if scope had leaked, it would
  // dock to 20 instead.
  const diff = `diff --git a/tests/${SEVENTH_FILE} b/tests/${SEVENTH_FILE}\n@@ update the 7th file so the verifier passes @@`;
  const deps: EvaluatorDeps = { queryFn: gradingQuery, model: "m", goal: "g" };
  const { score } = await evaluateArtifact(deps, view, diff, verifier);
  expect(score).toBe(95);
});

// --- The guarantee is the TYPE SYSTEM, not single-call-site discipline ---
// A full Contract carries `scope`, which is incompatible with GraderView's
// `scope?: never` brand — so passing one to the blind grader is a COMPILE ERROR.
// The @ts-expect-error directives ASSERT that error. If the brand is ever dropped
// (so a Contract structurally satisfies GraderView again — the earlier review's
// finding), these calls compile, the directives go unused, and `tsc --noEmit`
// FAILS. That turns a silent re-admission of scope into a build break; it is the
// trapdoor closing. Declared-not-called: the assertion is purely compile-time, and
// running these type-illegal calls would (correctly) leak scope at runtime, since
// nothing but the type system forbids the call.
export function _grader_rejects_a_scope_bearing_contract(scoped: Contract): void {
  // @ts-expect-error a Contract (with scope) is not assignable to GraderView
  buildEvaluatePrompt(scoped, "diff", verifier);
  // @ts-expect-error same guard on evaluateArtifact
  void evaluateArtifact({ queryFn: gradingQuery, model: "m", goal: "g" }, scoped, "diff", verifier);
}

test("proposeContract survives a malformed scope by sanitizing it, not aborting", async () => {
  // Valid criteria + a scope array with junk entries: a cosmetic scope typo must
  // not kill an otherwise-valid contract (scope isn't graded), but non-conforming
  // entries are dropped rather than propagated.
  const reply = JSON.stringify({
    criteria: [{ id: "c1", description: "d", verifyBy: "v" }],
    scope: [{ id: "s1", description: "keep me" }, { id: "no-desc" }, "not-an-object"],
  });
  const q: QueryFn = async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text: reply }] } } as any;
    yield { type: "result", subtype: "success", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } } as any;
  };
  const sprint: Sprint = { id: 0, title: "t", description: "d" };
  const c = await proposeContract({ queryFn: q, model: "m", cwd: ".", goal: "g" }, sprint, null);
  expect(c.criteria).toHaveLength(1); // contract survived, not aborted
  expect(c.scope).toEqual([{ id: "s1", description: "keep me" }]); // junk entries dropped
});
