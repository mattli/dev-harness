import { expect, test } from "vitest";
import { execa } from "execa";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createWorktree, removeWorktree, slugify } from "../src/workspace/worktree.js";

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "target-"));
  await execa("git", ["init"], { cwd: dir });
  await execa("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "t"], { cwd: dir });
  await execa("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

test("slugify normalizes goals", () => {
  expect(slugify("Build X, fast!")).toBe("build-x-fast");
});

test("returns an absolute, on-disk path even when worktreeRoot is relative", async () => {
  // The CLI default worktreeRoot is relative (".dev-harness-worktrees"). git -C
  // <project> anchors a relative path to the project, but the returned path is
  // handed to the SDK as the agent's cwd, resolved against process.cwd(). If the
  // path stays relative those disagree whenever project !== cwd, and spawn fails
  // with ENOENT on a nonexistent cwd. The returned path must be absolute and real.
  const repo = await initRepo();
  const wt = await createWorktree(repo, ".dev-harness-worktrees", "run/test-rel");
  expect(isAbsolute(wt.path)).toBe(true);
  expect(existsSync(wt.path)).toBe(true);
  await removeWorktree(repo, wt.path);
});

test("creates then removes a worktree, keeping the branch", async () => {
  const repo = await initRepo();
  const wt = await createWorktree(repo, join(repo, ".wt"), "run/test-r1");
  expect(existsSync(wt.path)).toBe(true);
  await removeWorktree(repo, wt.path);
  expect(existsSync(wt.path)).toBe(false);
  const { stdout } = await execa("git", ["branch", "--list", "run/test-r1"], { cwd: repo });
  expect(stdout).toContain("run/test-r1"); // branch survived
});
