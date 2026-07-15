import { invokeAgent, type QueryFn } from "./invoke.js";
import { loadPrompt } from "./prompts.js";
import type { Sprint } from "../state/types.js";

export interface PlannerDeps { queryFn: QueryFn; model: string; goal: string; }
export const MAX_SPRINTS = 6;
export interface PlanResult { title: string; sprints: Sprint[]; proposedCount: number; }

export async function planRun(deps: PlannerDeps): Promise<PlanResult> {
  const res = await invokeAgent({
    queryFn: deps.queryFn, model: deps.model,
    systemPrompt: loadPrompt("planner"),
    prompt: `Goal: ${deps.goal}`,
  });
  // Parse the JSON object and key on its labelled fields (not positional
  // scanning of prose) — see the project lesson on emitting a marker.
  const json = res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1);
  const obj = JSON.parse(json) as { title: string; sprints: Array<{ title: string; description: string }> };
  const all = obj.sprints.map((s, id) => ({ id, title: s.title, description: s.description }));
  return { title: obj.title, sprints: all.slice(0, MAX_SPRINTS), proposedCount: all.length };
}
