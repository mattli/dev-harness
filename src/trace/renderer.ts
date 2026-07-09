import type { TraceEvent } from "./types.js";
import type { RunState, Sprint } from "../state/types.js";
import { renderSummary } from "../report/summary.js";

// Collapse any internal whitespace/newlines so a model-authored field (criteria
// come straight from LLM JSON) can't split one criterion across multiple
// transcript lines and mangle the structure a reviewer reads.
const oneLine = (s: string): string => String(s).replace(/\s*\n\s*/g, " ").trim();

/** Summarize the generator's tool calls into a human sentence, from counts. */
function narrate(toolCalls: string[]): string {
  const count = (t: string) => toolCalls.filter((c) => c === t).length;
  const parts: string[] = [];
  const writes = count("Write");
  const edits = count("Edit");
  const cmds = count("Bash");
  if (writes) parts.push(`created ${writes} file${writes > 1 ? "s" : ""}`);
  if (edits) parts.push(`revised ${edits} time${edits > 1 ? "s" : ""}`);
  if (cmds) parts.push(`ran ${cmds} command${cmds > 1 ? "s" : ""}`);
  return parts.length ? parts.join(", ") : "no file changes recorded";
}

function scoreOf(events: TraceEvent[]): number | null {
  const evalEv = [...events].reverse().find((e) => e.phase === "EVALUATE");
  const m = evalEv?.outputDigest.match(/score\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

function criteriaLines(events: TraceEvent[]): string[] {
  // Guard the array: the renderer parses trace.jsonl back from disk, so a
  // format-skewed or hand-edited line must degrade to no section, not throw.
  const neg = events.find((e) => e.phase === "NEGOTIATE" && e.contract);
  const criteria = neg?.contract?.criteria ?? [];
  if (!criteria.length) return [];
  return ["  Requirements:", ...criteria.map((c) => `    - ${oneLine(c.description)}`)];
}

function stageBlock(sprint: Sprint, events: TraceEvent[], reached: boolean, haltReason: string | null): string[] {
  if (!reached) {
    return [`## Stage ${sprint.id} — ${sprint.title}   (not reached)`,
      `  Stopped before this stage could start${haltReason ? ` (${haltReason})` : ""}.`, ""];
  }
  const gen = events.find((e) => e.phase === "GENERATE");
  const score = scoreOf(events);
  const cost = gen?.costUsd ?? 0;
  const marker = score === null ? "✗ stopped" : `✓ ${score}/100`;
  return [
    `## Stage ${sprint.id} — ${sprint.title}   [${marker}] · $${cost.toFixed(2)}`,
    `  ${narrate(gen?.toolCalls ?? [])}.`,
    ...criteriaLines(events),
    "",
  ];
}

/** Transcript = the plain-English summary, then a readable per-stage narrative
 *  built from data already in the trace (titles, scores, costs, tool counts).
 *  Deeper detail (reasoning, the generated code) is deliberately out of scope. */
export function renderTranscript(events: TraceEvent[], state: RunState): string {
  const lines: string[] = [renderSummary(state), "────────────────────────────────────────────", ""];
  const reachedMax = state.status === "passed" ? state.sprints.length - 1 : state.currentSprint - 1;
  for (const sprint of state.sprints) {
    const stageEvents = events.filter((e) => e.sprint === sprint.id);
    const reached = sprint.id <= reachedMax || stageEvents.some((e) => e.phase === "GENERATE");
    lines.push(...stageBlock(sprint, stageEvents, reached, state.haltReason));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
