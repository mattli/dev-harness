import { expect, test } from "vitest";
import { execa } from "execa";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop, type LoopDeps } from "../src/orchestrator/run.js";
import { loadConfig } from "../src/config/load.js";
import { createWorktree, commitWorktree, worktreeDiff, removeWorktree } from "../src/workspace/worktree.js";

// Real git + real worktree/commit/remove; agents are faked but generateCode
// writes a REAL file into the worktree. This exercises the boundary the unit
// tests fake away — the exact gap where "the branch survives for review" was
// hollow because generated work was never committed and removeWorktree --force
// discarded it. Written to FAIL against the pre-fix (no-commit) behavior.

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "commit-gate-"));
  await execa("git", ["init"], { cwd: dir });
  await execa("git", ["config", "user.email", "t@t.com"], { cwd: dir });
  await execa("git", ["config", "user.name", "t"], { cwd: dir });
  await execa("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

function realGitDeps(runsDir: string, score: number): LoopDeps {
  return {
    nowMs: () => 0,
    runsDir,
    planRun: async () => ({ title: "add-sum", sprints: [{ id: 0, title: "add sum", description: "d" }] }),
    proposeContract: async (_sprint, prev) => ({ version: (prev?.contract.version ?? 0) + 1, criteria: [], frozen: false }),
    critiqueContract: async (_sprint, c) => ({ agreed: true, contract: c, critique: "ok" }),
    generateCode: async (_sprint, _c, cwd) => {
      writeFileSync(join(cwd, "sum.js"), "module.exports.sum = (a, b) => a + b;\n");
      return { text: "wrote sum.js", costUsd: 0, tokens: 0, toolCalls: ["Write"] };
    },
    runVerifier: async () => ({ passed: true, findings: [] }),
    worktreeDiff,
    evaluateArtifact: async () => ({ score, findings: [] }),
    createWorktree,
    commitWorktree,
    removeWorktree,
  };
}

test("passing sprint commits the generated file to the run branch, and it survives cleanup", async () => {
  const project = await initRepo();
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const state = await runLoop(
    loadConfig({ runId: "cg1", goal: "add sum", projectPath: project, worktreeRoot: join(project, ".wt") }),
    realGitDeps(runsDir, 90),
  );

  expect(state.status).toBe("passed");
  const branch = "run-cg1";
  // Branch has a commit beyond init (non-empty), tagged with the passing score...
  const log = await execa("git", ["-C", project, "log", branch, "--oneline"], { reject: false });
  expect(log.stdout).toMatch(/passed \(score 90\)/);
  // ...and its tree actually includes the generated file (not just a working-tree ghost).
  const show = await execa("git", ["-C", project, "show", `${branch}:sum.js`], { reject: false });
  expect(show.exitCode).toBe(0);
  expect(show.stdout).toContain("a + b");
  // Worktree removed, branch survives.
  const wtList = await execa("git", ["-C", project, "worktree", "list"]);
  expect(wtList.stdout).not.toContain("run-add-sum-cg1");
  const branches = await execa("git", ["-C", project, "branch", "--list", branch]);
  expect(branches.stdout).toContain(branch);
});

test("halted sprint still commits partial generated work to the run branch", async () => {
  const project = await initRepo();
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const state = await runLoop(
    loadConfig({
      runId: "cg2", goal: "add sum", projectPath: project, worktreeRoot: join(project, ".wt"),
      caps: { maxIterationsPerSprint: 1 },
    }),
    realGitDeps(runsDir, 10), // below threshold → one shot then halt max-iteration
  );

  expect(state.status).toBe("halted");
  expect(state.haltReason).toBe("max-iteration");
  const branch = "run-cg2";
  // Rejected work is still on the branch for review (commit is for review, not endorsement).
  const show = await execa("git", ["-C", project, "show", `${branch}:sum.js`], { reject: false });
  expect(show.exitCode).toBe(0);
  expect(show.stdout).toContain("a + b");
});
