import { execa } from "execa";
import { join } from "node:path";

export function slugify(goal: string): string {
  return goal.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export async function createWorktree(
  projectPath: string, worktreeRoot: string, branch: string,
): Promise<{ path: string; branch: string }> {
  const path = join(worktreeRoot, branch.replace(/\//g, "-"));
  await execa("git", ["-C", projectPath, "worktree", "add", "-b", branch, path], { stdio: "pipe" });
  return { path, branch };
}

/** Commit whatever the generator produced in the worktree to the run branch,
 *  so it survives `removeWorktree`'s --force (which discards uncommitted work).
 *  This is what makes the surviving branch actually reviewable. Returns true if
 *  a commit was made, false if the working tree had nothing to commit. */
export async function commitWorktree(worktreePath: string, message: string): Promise<boolean> {
  await execa("git", ["-C", worktreePath, "add", "-A"], { stdio: "pipe" });
  // `diff --cached --quiet` exits 0 when nothing is staged → nothing to commit.
  const staged = await execa("git", ["-C", worktreePath, "diff", "--cached", "--quiet"], { reject: false, stdio: "pipe" });
  if (staged.exitCode === 0) return false;
  await execa("git", ["-C", worktreePath, "commit", "-m", message], { stdio: "pipe" });
  return true;
}

/** The produced artifact as a diff: stage everything (incl. new untracked files)
 *  and diff against HEAD. This is what the blind evaluator grades — the actual
 *  changed code, with no commit messages and no generator transcript. */
export async function worktreeDiff(worktreePath: string): Promise<string> {
  await execa("git", ["-C", worktreePath, "add", "-A"], { stdio: "pipe" });
  const res = await execa("git", ["-C", worktreePath, "diff", "--cached", "HEAD"], { stdio: "pipe" });
  return res.stdout;
}

export async function removeWorktree(projectPath: string, path: string): Promise<void> {
  await execa("git", ["-C", projectPath, "worktree", "remove", "--force", path], { stdio: "pipe" });
}
