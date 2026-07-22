import { Command } from "commander";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../config/load.js";
import { runLoop } from "../orchestrator/run.js";
import { wireDeps } from "./wire.js";
import { renderSummary } from "../report/summary.js";
import { latestRunSummary } from "../report/show.js";
import { buildRunOverrides, dashboardBanner } from "./overrides.js";

const program = new Command();
program
  .command("run")
  .requiredOption("--goal <goal>")
  .requiredOption("--project <path>")
  .option("--eval-model <model>")
  .option("--dollar-ceiling <n>", "opt-in $ ceiling (off by default)", parseFloat)
  .option("--wall-clock-ms <n>", "per-sprint wall-clock cap in ms", (v) => parseInt(v, 10))
  .option("--max-iterations <n>", "generate/evaluate retries per sprint", (v) => parseInt(v, 10))
  .option("--test-cmd <cmd>", "verifier command")
  .action(async (opts) => {
    const runId = `${Date.now().toString(36)}`;
    const config = loadConfig(buildRunOverrides(opts, runId));
    console.log(`[dev-harness] run ${runId} — goal: ${config.goal}`);
    const banner = dashboardBanner();
    if (banner) console.log(banner);
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
