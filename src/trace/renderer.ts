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

/** The stage's final score, from the structured field on the LAST EVALUATE event
 *  (not scraped from the digest text). Returns null when the last evaluation had
 *  no numeric score — e.g. an evaluator-parse-error halt — so a stage that ended
 *  on a grading failure is not mislabeled with an earlier retry's score. */
function scoreOf(events: TraceEvent[]): number | null {
  const evalEv = [...events].reverse().find((e) => e.phase === "EVALUATE");
  return typeof evalEv?.score === "number" ? evalEv.score : null;
}

function criteriaLines(events: TraceEvent[]): string[] {
  // Guard the arrays: the renderer parses trace.jsonl back from disk, so a
  // format-skewed or hand-edited line must degrade to no section, not throw.
  const neg = events.find((e) => e.phase === "NEGOTIATE" && e.contract);
  const criteria = neg?.contract?.criteria ?? [];
  // Scope is shown to the human reader (it's what the change was meant to stay
  // within) even though the blind scorer never grades it — the transcript is a
  // product surface, not the grader's input.
  const scope = neg?.contract?.scope ?? [];
  const reqLines = criteria.length
    ? ["  Requirements:", ...criteria.map((c) => `    - ${oneLine(c.description)}`)]
    : [];
  const scopeLines = scope.length
    ? ["  Scope (not graded — enforced at review):", ...scope.map((s) => `    - ${oneLine(s.description)}`)]
    : [];
  return [...reqLines, ...scopeLines];
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
  // reporting only the first attempt undercounts both cost and work done. Guard
  // each field — finalize() parses trace.jsonl back from disk, which may be
  // format-skewed or hand-edited (see criteriaLines).
  const gens = events.filter((e) => e.phase === "GENERATE");
  const cost = gens.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  const tools = gens.flatMap((e) => e.toolCalls ?? []);
  const score = scoreOf(events);

  if (s === "stopped" && gens.length === 0) {
    return [`## Stage ${sprint.id} — ${sprint.title}   [✗ stopped]`,
      `  The run stopped while preparing this stage${haltReason ? ` (${haltReason})` : ""}.`,
      ...criteriaLines(events), ""];
  }

  const marker = s === "done"
    ? (score === null ? "✓ done" : `✓ ${score}/100`)
    : (score === null ? "✗ stopped" : `✗ stopped (last score ${score}/100)`);
  // For a stopped stage, always surface why — even when it generated code and the
  // final grade was a parse error (score null), the reason must not vanish.
  const reasonNote = s === "stopped" && haltReason ? [`  Stopped: ${haltReason}.`] : [];
  return [
    `## Stage ${sprint.id} — ${sprint.title}   [${marker}] · $${cost.toFixed(2)}`,
    `  ${narrate(tools)}.`,
    ...reasonNote,
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
    // A stage with GENERATE events was reached even if currentSprint disagrees
    // (guards against a disk/memory divergence that would otherwise drop real
    // work under a "not reached" label).
    let s = stageState(sprint.id, state);
    if (s === "pending" && stageEvents.some((e) => e.phase === "GENERATE")) s = "stopped";
    // Only the stage that actually stopped (currentSprint) carries the run-level
    // halt reason, so a later stage reclassified via the fallback above can't
    // also claim to be where the run died.
    const reason = sprint.id === state.currentSprint ? state.haltReason : null;
    lines.push(...stageBlock(sprint, stageEvents, s, reason));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
