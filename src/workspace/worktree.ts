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

export async function removeWorktree(projectPath: string, path: string): Promise<void> {
  await execa("git", ["-C", projectPath, "worktree", "remove", "--force", path], { stdio: "pipe" });
}
