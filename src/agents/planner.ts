import { invokeAgent, type QueryFn } from "./invoke.js";
import { loadPrompt } from "./prompts.js";
import type { Sprint } from "../state/types.js";

export interface PlannerDeps { queryFn: QueryFn; model: string; goal: string; }

export async function planSprints(deps: PlannerDeps): Promise<Sprint[]> {
  const res = await invokeAgent({
    queryFn: deps.queryFn, model: deps.model,
    systemPrompt: loadPrompt("planner"),
    prompt: `Goal: ${deps.goal}`,
  });
  const json = res.text.slice(res.text.indexOf("["), res.text.lastIndexOf("]") + 1);
  const raw = JSON.parse(json) as Array<{ title: string; description: string }>;
  return raw.map((s, id) => ({ id, title: s.title, description: s.description }));
}
