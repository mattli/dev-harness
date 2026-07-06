import { invokeAgent, type AgentResult, type QueryFn } from "./invoke.js";
import { loadPrompt } from "./prompts.js";
import type { Contract } from "../contract/types.js";

export interface GeneratorDeps { queryFn: QueryFn; model: string; cwd: string; }

export async function proposeContract(deps: GeneratorDeps, prev: Contract | null): Promise<Contract> {
  const res = await invokeAgent({
    queryFn: deps.queryFn, model: deps.model,
    systemPrompt: loadPrompt("generator"),
    prompt: `Propose a contract.${prev ? ` Prior version and critique:\n${JSON.stringify(prev)}` : ""}`,
  });
  const json = res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json) as { criteria: Contract["criteria"] };
  return { version: (prev?.version ?? 0) + 1, criteria: parsed.criteria, frozen: false };
}

export async function generateCode(deps: GeneratorDeps, contract: Contract): Promise<AgentResult> {
  return invokeAgent({
    queryFn: deps.queryFn, model: deps.model, cwd: deps.cwd, permissionMode: "bypassPermissions",
    systemPrompt: loadPrompt("generator"),
    prompt: `Build against this FROZEN contract:\n${JSON.stringify(contract, null, 2)}`,
  });
}
