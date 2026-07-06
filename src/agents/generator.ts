import { invokeAgent, type AgentResult, type QueryFn } from "./invoke.js";
import { loadPrompt } from "./prompts.js";
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
    `Output ONLY JSON: {"criteria":[{"id":"c1","description":"...","verifyBy":"..."}]}`,
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
  const json = res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json) as { criteria: Contract["criteria"] };
  return { version: (prev?.contract.version ?? 0) + 1, criteria: parsed.criteria, frozen: false };
}

export async function generateCode(deps: GeneratorDeps, sprint: Sprint, contract: Contract): Promise<AgentResult> {
  return invokeAgent({
    queryFn: deps.queryFn, model: deps.model, cwd: deps.cwd, permissionMode: "bypassPermissions",
    systemPrompt: loadPrompt("generator"),
    prompt: buildGeneratePrompt(deps.goal, sprint, contract),
  });
}
