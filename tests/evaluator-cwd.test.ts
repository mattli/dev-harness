import { expect, test } from "vitest";
import { critiqueContract, evaluateArtifact, type EvaluatorDeps } from "../src/agents/evaluator.js";
import type { QueryFn } from "../src/agents/invoke.js";
import type { Sprint } from "../src/state/types.js";
import type { Contract } from "../src/contract/types.js";
import type { VerifierResult } from "../src/verifier/types.js";

// The two evaluator roles have OPPOSITE cwd rules, and both are pinned here at
// the real boundary: the options handed to the SDK query.
//
// - NEGOTIATE critic: SIGHTED — must inspect the PROJECT worktree so it judges
//   the contract against real code. Running with the wrong/undefined cwd made it
//   inspect the harness's own (TypeScript) tree, "see" no target source, and
//   freeze an unsatisfiable "target source absent" contract — the poisoning this
//   fix exists to prevent.
// - EVALUATE scorer: BLIND (C2) — must NOT get a worktree cwd, or it could
//   `git log` prior-sprint commits / read goal files out-of-band and credit
//   pre-existing files outside the produced diff (a false pass). It grades only
//   the injected diff + verifier result.
function spyQuery(reply: string): { queryFn: QueryFn; seen: Array<string | undefined> } {
  const seen: Array<string | undefined> = [];
  const queryFn: QueryFn = async function* (args) {
    seen.push(args.options.cwd);
    yield { type: "assistant", message: { content: [{ type: "text", text: reply }] } } as any;
    yield { type: "result", subtype: "success", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } } as any;
  };
  return { queryFn, seen };
}

const deps = (queryFn: QueryFn): EvaluatorDeps => ({ queryFn, model: "m", goal: "g" });
const sprint: Sprint = { id: 0, title: "t", description: "d" };
const contract: Contract = { version: 1, criteria: [], frozen: true };
const verifier: VerifierResult = { passed: true, findings: [] };

test("critiqueContract inspects the project worktree cwd, not the harness cwd", async () => {
  const { queryFn, seen } = spyQuery("AGREEMENT: yes");
  await critiqueContract(deps(queryFn), sprint, contract, "/work/tree");
  expect(seen).toEqual(["/work/tree"]);
});

test("evaluateArtifact stays BLIND — never runs in the worktree cwd", async () => {
  const { queryFn, seen } = spyQuery("FINAL SCORE: 80");
  await evaluateArtifact(deps(queryFn), contract, "diff", verifier);
  // No worktree path is threaded in: the scorer's query carries no cwd.
  expect(seen).toEqual([undefined]);
});
