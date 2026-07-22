import type { RawConfig } from "../config/load.js";

/** The one-line banner printed at the top of a run so the always-on dashboard
 *  URL streams into the terminal (and Claude Code) ready to click. The URL is
 *  machine-specific, so it is read from the DEV_HARNESS_DASHBOARD_URL env var
 *  rather than hard-coded into the repo; returns null (print nothing) when the
 *  var is unset or blank, so the CLI is silent on machines without a dashboard. */
export function dashboardBanner(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const url = env.DEV_HARNESS_DASHBOARD_URL?.trim();
  return url ? `[dev-harness] dashboard: ${url}` : null;
}

export function buildRunOverrides(
  opts: {
    goal: string;
    project: string;
    evalModel?: string;
    testCmd?: string;
    dollarCeiling?: number;
    wallClockMs?: number;
    maxIterations?: number;
  },
  runId: string
): RawConfig {
  const caps: Record<string, number> = {};
  if (opts.dollarCeiling !== undefined) caps.dollarCeiling = opts.dollarCeiling;
  if (opts.wallClockMs !== undefined) caps.wallClockMsPerSprint = opts.wallClockMs;
  if (opts.maxIterations !== undefined) caps.maxIterationsPerSprint = opts.maxIterations;
  return {
    runId,
    goal: opts.goal,
    projectPath: opts.project,
    models: opts.evalModel ? { evaluator: opts.evalModel } : undefined,
    caps: Object.keys(caps).length ? caps : undefined,
    verifier: opts.testCmd ? { command: opts.testCmd } : undefined,
  };
}
