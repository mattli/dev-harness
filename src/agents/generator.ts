import { invokeAgent, type AgentResult, type QueryFn } from "./invoke.js";
import { loadPrompt } from "./prompts.js";
import { extractJsonObject } from "./extract-json.js";
import type { Contract } from "../contract/types.js";
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
      : `Propose a contract for THIS sprint: granular, testable criteria, each with how it will be verified.`,
    'Output the contract as a single fenced ```json code block and nothing else:\n```json\n{"criteria":[{"id":"c1","description":"...","verifyBy":"..."}]}\n```',
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
    (o): o is { criteria: Contract["criteria"] } => {
      const crit = (o as { criteria?: unknown } | null)?.criteria;
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
  return { version: (prev?.contract.version ?? 0) + 1, criteria: parsed.criteria, frozen: false };
}

export async function generateCode(deps: GeneratorDeps, sprint: Sprint, contract: Contract): Promise<AgentResult> {
  return invokeAgent({
    queryFn: deps.queryFn, model: deps.model, cwd: deps.cwd, permissionMode: "bypassPermissions",
    systemPrompt: loadPrompt("generator"),
    prompt: buildGeneratePrompt(deps.goal, sprint, contract),
  });
}
