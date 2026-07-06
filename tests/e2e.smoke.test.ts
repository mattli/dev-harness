import { expect, test } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execa } from "execa";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/load.js";
import { runLoop } from "../src/orchestrator/run.js";
import { wireDeps } from "../src/cli/wire.js";

const maybe = process.env.RUN_E2E === "1" ? test : test.skip;

maybe("2+2 goal runs the full loop end to end for a few cents", async () => {
  const project = mkdtempSync(join(tmpdir(), "e2e-"));
  await execa("git", ["init"], { cwd: project });
  await execa("git", ["config", "user.email", "t@t.com"], { cwd: project });
  await execa("git", ["config", "user.name", "t"], { cwd: project });
  await execa("git", ["commit", "--allow-empty", "-m", "init"], { cwd: project });

  // Tight caps so the loop returns fast and cheap — this is a smoke test that
  // proves the pipeline turns end to end against the real SDK, not a quality bar.
  // maxIterationsPerSprint:1 means each sprint gets one generate+evaluate then
  // advances (score >= 85) or halts (max-iteration); dollarCeiling is the hard
  // backstop. A clean {passed|halted} return is the proof.
  const config = loadConfig({
    runId: "e2e", goal: "Add sum.js exporting sum(a,b)=a+b with a passing node:test",
    projectPath: project, worktreeRoot: join(project, ".wt"),
    caps: { dollarCeiling: 1, maxIterationsPerSprint: 1, negotiationRounds: 2, wallClockMs: 3 * 60 * 1000 },
    verifier: { command: "node --test" },
  });
  const state = await runLoop(config, wireDeps(config, query as any));
  expect(["passed", "halted"]).toContain(state.status);

  // (a) C1: the on-goal artifact is actually committed on the surviving branch —
  // not just present in a discarded working tree. Find the run branch, and assert
  // some committed file references "sum" and implements a + b.
  const branchList = await execa("git", ["-C", project, "branch", "--list", "run/*"], { reject: false });
  const branch = branchList.stdout.split("\n")[0].replace(/^\*?\s*/, "").trim();
  expect(branch).toMatch(/^run\//);
  const tree = await execa("git", ["-C", project, "ls-tree", "-r", "--name-only", branch], { reject: false });
  const files = tree.stdout.split("\n").filter(Boolean);
  let onGoal = false;
  for (const f of files) {
    const c = await execa("git", ["-C", project, "show", `${branch}:${f}`], { reject: false });
    if (/sum/i.test(f + c.stdout) && /a\s*\+\s*b/.test(c.stdout)) { onGoal = true; break; }
  }
  expect(onGoal, `expected an on-goal sum implementation committed; branch files: ${files.join(", ")}`).toBe(true);
}, 420000); // vitest timeout MUST exceed caps.wallClockMs so the loop can halt and return
