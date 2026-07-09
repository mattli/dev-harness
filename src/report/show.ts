import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "../state/types.js";
import { projectSlug } from "../state/run-path.js";
import { renderSummary } from "./summary.js";

/** Render the summary of a project's most recent run, chosen by start time (not
 *  by lexical folder order, which missorts collision suffixes like -2 vs -10).
 *  Folders without a readable state.json (a stray dir, or a run that crashed
 *  before writing state) are skipped. Throws if the project has no valid run. */
export function latestRunSummary(runsDir: string, projectPath: string): string {
  const dir = join(runsDir, projectSlug(projectPath));
  let entries: string[];
  try { entries = readdirSync(dir); } catch { entries = []; }
  const runs: { name: string; state: RunState }[] = [];
  for (const name of entries) {
    try {
      runs.push({ name, state: JSON.parse(readFileSync(join(dir, name, "state.json"), "utf8")) as RunState });
    } catch { /* not a run directory, or state.json unreadable — skip it */ }
  }
  if (!runs.length) throw new Error(`no runs found for project at ${projectPath}`);
  // Sort by start time, then by folder name as a deterministic tiebreak: runs
  // sharing a timestamp (concurrent runs, or both missing startedAt) must not
  // fall back to non-deterministic readdir order.
  runs.sort((a, b) =>
    (a.state.startedAt ?? "").localeCompare(b.state.startedAt ?? "") ||
    a.name.localeCompare(b.name));
  return renderSummary(runs[runs.length - 1].state);
}
