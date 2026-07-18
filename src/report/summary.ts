import type { RunState } from "../state/types.js";
import { runBranch } from "../state/run-path.js";

const HALT_TEXT: Record<string, string> = {
  "wall-clock": "Paused — hit the per-sprint time limit (your work so far is saved)",
  "dollar-ceiling": "Paused — hit the spending limit you set",
  "usage-limit": "Paused — hit your Anthropic subscription usage limit (your work so far is saved)",
  "max-iteration": "Stopped — no improvement after the retry limit",
  "no-progress": "Stopped — the score stopped improving",
  "evaluator-parse-error": "Stopped — an internal grading error",
  "planner-error": "Stopped — could not plan the run (the planner returned unusable output)",
};

const APPROX_CAP_REASONS = new Set(["wall-clock", "dollar-ceiling", "usage-limit"]);

/** One plain-English sentence describing how the run ended. No recommendations. */
export function describeOutcome(state: RunState): string {
  if (state.status === "passed") return "Finished successfully — all stages passed";
  if (state.status === "running") return "Still running";
  const reason = state.haltReason ?? "unknown";
  const base = HALT_TEXT[reason] ?? `Stopped — ${reason}`;
  if (reason === "dollar-ceiling") return `${base} ($${state.budgetSpentUsd.toFixed(2)})`;
  if (APPROX_CAP_REASONS.has(reason)) return `${base}. Caps are checked between steps, so a run can go a little past them.`;
  return base;
}

/** The plain-English summary block. Single source for the transcript header,
 *  the terminal print, and the `show` command. Descriptive only. */
export function renderSummary(state: RunState): string {
  const total = state.sprints.length;
  const finished = state.status === "passed" ? total : state.currentSprint;
  const quality = state.scores.length
    ? `scored ${state.scores.join(", ")} out of 100`
    : "no stages scored yet";
  const date = state.startedAt ? state.startedAt.slice(0, 10) : "unknown date";
  return [
    `${state.title || state.goal} — ${date}`,
    `Outcome:  ${describeOutcome(state)}`,
    `Progress: ${finished} of ${total} stages finished`,
    `Quality:  ${quality}`,
    `Spent:    $${state.budgetSpentUsd.toFixed(2)}`,
    `Code:     branch ${runBranch(state.goal, state.runId)} in ${state.projectPath ?? "(unknown project path)"}`,
    `Records:  ${state.runDir ?? "(unknown)"}`,
    "",
  ].join("\n");
}
