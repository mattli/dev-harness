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

/** The last recorded score for the stage, read from the structured field on the
 *  EVALUATE event (not scraped from the digest text). */
function scoreOf(events: TraceEvent[]): number | null {
  const evalEv = [...events].reverse().find((e) => e.phase === "EVALUATE" && typeof e.score === "number");
  return evalEv?.score ?? null;
}

function criteriaLines(events: TraceEvent[]): string[] {
  // Guard the array: the renderer parses trace.jsonl back from disk, so a
  // format-skewed or hand-edited line must degrade to no section, not throw.
  const neg = events.find((e) => e.phase === "NEGOTIATE" && e.contract);
  const criteria = neg?.contract?.criteria ?? [];
  if (!criteria.length) return [];
  return ["  Requirements:", ...criteria.map((c) => `    - ${oneLine(c.description)}`)];
}

// A stage is "done" (completed), "stopped" (the stage the run died on), or
// "pending" (a later stage the run never reached). currentSprint is the stage in
// progress when the run ended, so for a halted run it is the one that stopped —
// mislabeling it "not reached" hides where the run actually died.
type StageState = "done" | "stopped" | "pending";
function stageState(sprintId: number, state: RunState): StageState {
  if (state.status === "passed") return "done";
  if (sprintId < state.currentSprint) return "done";
  if (sprintId === state.currentSprint) return "stopped";
  return "pending";
}

function stageBlock(sprint: Sprint, events: TraceEvent[], s: StageState, haltReason: string | null): string[] {
  if (s === "pending") {
    return [`## Stage ${sprint.id} — ${sprint.title}   (not reached)`,
      `  Not started — the run stopped at an earlier stage.`, ""];
  }
  // Sum across every GENERATE attempt: a stage can regenerate several times, and
  // reporting only the first attempt undercounts both cost and work done.
  const gens = events.filter((e) => e.phase === "GENERATE");
  const cost = gens.reduce((sum, e) => sum + e.costUsd, 0);
  const tools = gens.flatMap((e) => e.toolCalls);
  const score = scoreOf(events);

  if (s === "stopped" && gens.length === 0) {
    return [`## Stage ${sprint.id} — ${sprint.title}   [✗ stopped]`,
      `  The run stopped while preparing this stage${haltReason ? ` (${haltReason})` : ""}.`,
      ...criteriaLines(events), ""];
  }

  const marker = s === "done"
    ? (score === null ? "✓ done" : `✓ ${score}/100`)
    : (score === null ? "✗ stopped" : `✗ stopped (last score ${score}/100)`);
  return [
    `## Stage ${sprint.id} — ${sprint.title}   [${marker}] · $${cost.toFixed(2)}`,
    `  ${narrate(tools)}.`,
    ...criteriaLines(events),
    "",
  ];
}

/** Transcript = the plain-English summary, then a readable per-stage narrative
 *  built from data already in the trace (titles, scores, costs, tool counts).
 *  Deeper detail (reasoning, the generated code) is deliberately out of scope. */
export function renderTranscript(events: TraceEvent[], state: RunState): string {
  const lines: string[] = [renderSummary(state), "────────────────────────────────────────────", ""];
  for (const sprint of state.sprints) {
    const stageEvents = events.filter((e) => e.sprint === sprint.id);
    lines.push(...stageBlock(sprint, stageEvents, stageState(sprint.id, state), state.haltReason));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
