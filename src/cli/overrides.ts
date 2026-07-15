import type { RawConfig } from "../config/load.js";

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
