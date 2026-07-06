import { Command } from "commander";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../config/load.js";
import { runLoop } from "../orchestrator/run.js";
import { wireDeps } from "./wire.js";

const program = new Command();
program
  .command("run")
  .requiredOption("--goal <goal>")
  .requiredOption("--project <path>")
  .option("--eval-model <model>")
  .option("--dollar-ceiling <n>", "override $ ceiling", parseFloat)
  .option("--test-cmd <cmd>", "verifier command")
  .action(async (opts) => {
    const runId = `${Date.now().toString(36)}`;
    const config = loadConfig({
      runId, goal: opts.goal, projectPath: opts.project,
      models: opts.evalModel ? { evaluator: opts.evalModel } : undefined,
      caps: opts.dollarCeiling ? { dollarCeiling: opts.dollarCeiling } : undefined,
      verifier: opts.testCmd ? { command: opts.testCmd } : undefined,
    });
    console.log(`[dev-harness] run ${runId} — goal: ${config.goal}`);
    const state = await runLoop(config, wireDeps(config, query as any));
    console.log(`[dev-harness] status=${state.status} reason=${state.haltReason ?? "-"} spent=$${state.budgetSpentUsd.toFixed(2)}`);
    console.log(`[dev-harness] branch run/... left in ${config.projectPath}; transcript in runs/${runId}/transcript.md`);
  });
program.parseAsync();
