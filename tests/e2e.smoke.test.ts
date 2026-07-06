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

  const config = loadConfig({
    runId: "e2e", goal: "Add sum.js exporting sum(a,b)=a+b with a passing node:test",
    projectPath: project, worktreeRoot: join(project, ".wt"),
    caps: { dollarCeiling: 2, maxIterationsPerSprint: 3, wallClockMs: 5 * 60 * 1000 },
    verifier: { command: "node --test" },
  });
  const state = await runLoop(config, wireDeps(config, query as any));
  expect(["passed", "halted"]).toContain(state.status);
}, 300000);
