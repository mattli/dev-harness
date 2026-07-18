import { invokeAgent, type QueryFn } from "./invoke.js";
import { loadPrompt } from "./prompts.js";
import { extractJsonObject } from "./extract-json.js";
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
  // Key on the object's shape (non-empty title + non-empty, well-typed sprints),
  // not the first `{` in the reply — the old first-brace/last-brace slice
  // crashed on any stray brace in preamble prose. See the project lesson on
  // emitting a marker.
  const obj = extractJsonObject(
    res.text,
    (o): o is { title: string; sprints: Array<{ title: string; description: string }> } => {
      const rec = o as { title?: unknown; sprints?: unknown } | null;
      return (
        typeof rec?.title === "string" &&
        rec.title.length > 0 &&
        Array.isArray(rec.sprints) &&
        rec.sprints.length > 0 &&
        rec.sprints.every(
          (s) =>
            s != null &&
            typeof s === "object" &&
            typeof (s as { title?: unknown }).title === "string" &&
            typeof (s as { description?: unknown }).description === "string",
        )
      );
    },
  );
  const all = obj.sprints.map((s, id) => ({ id, title: s.title, description: s.description }));
  return { title: obj.title, sprints: all.slice(0, MAX_SPRINTS), proposedCount: all.length };
}
