import { Command } from "commander";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../config/load.js";
import { runLoop } from "../orchestrator/run.js";
import { wireDeps } from "./wire.js";
import { renderSummary } from "../report/summary.js";
import { latestRunSummary } from "../report/show.js";

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
    console.log("\n" + renderSummary(state));
  });

program
  .command("show")
  .requiredOption("--project <path>")
  .action((opts) => {
    try {
      console.log(latestRunSummary("runs", opts.project));
    } catch (e) {
      console.error(`[dev-harness] ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

program.parseAsync();
