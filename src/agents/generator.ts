import { invokeAgent, type AgentResult, type QueryFn } from "./invoke.js";
import { loadPrompt } from "./prompts.js";
import { extractJsonObject } from "./extract-json.js";
import type { Contract, ScopeConstraint } from "../contract/types.js";
import type { PriorRound } from "../contract/negotiate.js";
import type { Sprint } from "../state/types.js";

export interface GeneratorDeps { queryFn: QueryFn; model: string; cwd: string; goal: string; }

/** Pure + exported so C1 (generator sees goal+sprint) is a tested property. */
export function buildProposePrompt(goal: string, sprint: Sprint, prev: PriorRound | null): string {
  return [
    `Goal: ${goal}`,
    `Sprint ${sprint.id}: ${sprint.title}\n${sprint.description}`,
    prev
      ? `Your prior contract (v${prev.contract.version}):\n${JSON.stringify(prev.contract, null, 2)}\n\nThe evaluator's critique of it:\n${prev.critique}\n\nRevise the contract to address the critique.`
      : `Propose a contract for THIS sprint: granular, testable acceptance criteria (each with how it will be verified), plus any intent-level scope restrictions in a separate "scope" list.`,
    'Output the contract as a single fenced ```json code block and nothing else. "criteria" are the behavioral acceptance criteria (graded); "scope" holds out-of-scope areas / intent restrictions at directory/module granularity (NOT an exact file list) and may be omitted or empty:\n```json\n{"criteria":[{"id":"c1","description":"...","verifyBy":"..."}],"scope":[{"id":"s1","description":"..."}]}\n```',
  ].join("\n\n");
}

export function buildGeneratePrompt(goal: string, sprint: Sprint, contract: Contract): string {
  return [
    `Goal: ${goal}`,
    `Sprint ${sprint.id}: ${sprint.title}\n${sprint.description}`,
    `Build code in the working directory to satisfy every criterion of this FROZEN contract, then stop. Do not narrate.\n${JSON.stringify(contract, null, 2)}`,
  ].join("\n\n");
}

export async function proposeContract(deps: GeneratorDeps, sprint: Sprint, prev: PriorRound | null): Promise<Contract> {
  const res = await invokeAgent({
    queryFn: deps.queryFn, model: deps.model,
    systemPrompt: loadPrompt("generator"),
    prompt: buildProposePrompt(deps.goal, sprint, prev),
  });
  // Key on the object's shape (a non-empty, well-typed `criteria` array), not
  // the first `{` in the reply — a stray brace in brace-heavy preamble prose
  // used to crash this. Requiring non-empty + typed criteria rejects a vacuous
  // `{"criteria":[]}` (which would freeze an unsatisfiable no-op contract).
  const parsed = extractJsonObject(
    res.text,
    // Key ONLY on the acceptance criteria (a non-empty, well-typed array), not the
    // first `{` in the reply — a stray brace in brace-heavy preamble prose used to
    // crash this. Requiring non-empty + typed criteria rejects a vacuous
    // `{"criteria":[]}` (which would freeze an unsatisfiable no-op contract).
    // `scope` is NOT part of the accept/reject decision: it is sanitized after
    // extraction (below), so a malformed scope never aborts negotiation. There is
    // nothing to defend against by rejecting it — scope is dropped from the grader
    // view and never graded, so it cannot smuggle graded content either way.
    (o): o is { criteria: Contract["criteria"]; scope?: unknown } => {
      const rec = o as { criteria?: unknown } | null;
      const crit = rec?.criteria;
      return (
        Array.isArray(crit) &&
        crit.length > 0 &&
        crit.every(
          (c) =>
            c != null &&
            typeof c === "object" &&
            typeof (c as { id?: unknown }).id === "string" &&
            typeof (c as { description?: unknown }).description === "string" &&
            typeof (c as { verifyBy?: unknown }).verifyBy === "string",
        )
      );
    },
  );
  // Sanitize scope defensively: keep only well-typed {id,description} entries,
  // default to [] for an absent or malformed scope. A cosmetic scope typo must
  // not kill an otherwise-valid contract (it isn't graded), but non-conforming
  // shapes are still dropped rather than propagated.
  const rawScope = parsed.scope;
  const scope: Contract["scope"] = Array.isArray(rawScope)
    ? rawScope.filter(
        (s): s is ScopeConstraint =>
          s != null &&
          typeof s === "object" &&
          typeof (s as { id?: unknown }).id === "string" &&
          typeof (s as { description?: unknown }).description === "string",
      )
    : [];
  return { version: (prev?.contract.version ?? 0) + 1, criteria: parsed.criteria, scope, frozen: false };
}

export async function generateCode(deps: GeneratorDeps, sprint: Sprint, contract: Contract): Promise<AgentResult> {
  return invokeAgent({
    queryFn: deps.queryFn, model: deps.model, cwd: deps.cwd, permissionMode: "bypassPermissions",
    systemPrompt: loadPrompt("generator"),
    prompt: buildGeneratePrompt(deps.goal, sprint, contract),
  });
}
