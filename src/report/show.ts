import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "../state/types.js";
import { projectSlug } from "../state/run-path.js";
import { renderSummary } from "./summary.js";

/** Render the summary of a project's most recent run (folders are date-prefixed,
 *  so the lexically-last folder is the newest). Throws if the project has none. */
export function latestRunSummary(runsDir: string, projectPath: string): string {
  const dir = join(runsDir, projectSlug(projectPath));
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { entries = []; }
  if (!entries.length) throw new Error(`no runs found for project at ${projectPath}`);
  const latest = entries[entries.length - 1];
  const state = JSON.parse(readFileSync(join(dir, latest, "state.json"), "utf8")) as RunState;
  return renderSummary(state);
}
