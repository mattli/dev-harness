import { basename, join } from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import { slugify } from "../workspace/worktree.js";

/** The run branch name. Single source shared by the orchestrator (which creates
 *  the branch) and the summary (which reports it) so the two can never drift. */
export function runBranch(runId: string): string {
  return `run-${runId}`;
}

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

/** Atomically reserve a unique run directory. buildRunDir alone races: two
 *  concurrent runs with the same project+title+date both scan siblings, see no
 *  collision, and pick the same path. Here we create the leaf dir with
 *  recursive:false (which fails EEXIST if another run won the race) and retry
 *  against a fresh sibling scan until the mkdir succeeds. */
export function reserveRunDir(
  runsDir: string, projectPath: string, title: string, nowMs: number,
): string {
  const projDir = join(runsDir, projectSlug(projectPath));
  mkdirSync(projDir, { recursive: true });
  for (let attempt = 0; attempt < 1000; attempt++) {
    const dir = buildRunDir(runsDir, projectPath, title, nowMs, readdirSync(projDir));
    try {
      mkdirSync(dir, { recursive: false });
      return dir;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error("could not reserve a unique run directory");
}
