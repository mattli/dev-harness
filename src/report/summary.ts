import type { RunState } from "../state/types.js";
import { slugify } from "../workspace/worktree.js";

const HALT_TEXT: Record<string, string> = {
  "dollar-ceiling": "Stopped early — hit the spending limit",
  "wall-clock": "Stopped early — hit the time limit",
  "max-iteration": "Stopped — no improvement after the retry limit",
  "no-progress": "Stopped — the score stopped improving",
  "evaluator-parse-error": "Stopped — an internal grading error",
};

/** One plain-English sentence describing how the run ended. No recommendations. */
export function describeOutcome(state: RunState): string {
  if (state.status === "passed") return "Finished successfully — all stages passed";
  if (state.status === "running") return "Still running";
  const reason = state.haltReason ?? "unknown";
  const base = HALT_TEXT[reason] ?? `Stopped — ${reason}`;
  if (reason === "dollar-ceiling") return `${base} ($${state.budgetSpentUsd.toFixed(2)})`;
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
  const branch = `run/${slugify(state.goal)}-${state.runId}`;
  return [
    `${state.title || state.goal} — ${state.startedAt.slice(0, 10)}`,
    `Outcome:  ${describeOutcome(state)}`,
    `Progress: ${finished} of ${total} stages finished`,
    `Quality:  ${quality}`,
    `Spent:    $${state.budgetSpentUsd.toFixed(2)}`,
    `Code:     saved on branch ${branch} in the target project`,
    "",
  ].join("\n");
}
