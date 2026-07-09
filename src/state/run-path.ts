import { basename, join } from "node:path";
import { slugify } from "../workspace/worktree.js";

/** Human-readable project slug from the --project path (its folder name). */
export function projectSlug(projectPath: string): string {
  const base = basename(projectPath.replace(/\/+$/, ""));
  return slugify(base) || "project";
}

/** YYYY-MM-DD for an epoch-ms instant, in UTC (deterministic across machines). */
export function runDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** runs/<project>/<date>-<title>, with -2/-3… appended on collision.
 *  `siblings` is the list of existing entry names under runs/<project>/ — the
 *  caller reads the filesystem so this stays pure and unit-testable. */
export function buildRunDir(
  runsDir: string, projectPath: string, title: string, nowMs: number, siblings: string[],
): string {
  const stem = `${runDate(nowMs)}-${slugify(title) || "run"}`;
  const taken = new Set(siblings);
  let name = stem;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`;
  return join(runsDir, projectSlug(projectPath), name);
}
