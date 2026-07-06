import { z } from "zod";
import { DEFAULTS } from "./defaults.js";
import type { RunConfig } from "./types.js";

const schema = z.object({
  runId: z.string().min(1),
  goal: z.string().min(1),
  projectPath: z.string().min(1),
  worktreeRoot: z.string(),
  models: z.object({ planner: z.string(), generator: z.string(), evaluator: z.string() }),
  thresholds: z.object({
    advanceScore: z.number().min(0).max(100),
    noProgressDelta: z.number().min(0),
    noProgressWindow: z.number().int().min(1),
  }),
  caps: z.object({
    maxIterationsPerSprint: z.number().int().min(1),
    negotiationRounds: z.number().int().min(1),
    dollarCeiling: z.number().positive(),
    wallClockMs: z.number().int().positive(),
  }),
  verifier: z.object({ kind: z.literal("test-suite"), command: z.string().min(1) }),
});

export type RawConfig = {
  runId: string; goal: string; projectPath: string;
  worktreeRoot?: string;
  models?: Partial<RunConfig["models"]>;
  thresholds?: Partial<RunConfig["thresholds"]>;
  caps?: Partial<RunConfig["caps"]>;
  verifier?: Partial<RunConfig["verifier"]>;
};

export function loadConfig(overrides: RawConfig): RunConfig {
  const merged = {
    runId: overrides.runId,
    goal: overrides.goal,
    projectPath: overrides.projectPath,
    worktreeRoot: overrides.worktreeRoot ?? DEFAULTS.worktreeRoot,
    models: { ...DEFAULTS.models, ...overrides.models },
    thresholds: { ...DEFAULTS.thresholds, ...overrides.thresholds },
    caps: { ...DEFAULTS.caps, ...overrides.caps },
    verifier: { ...DEFAULTS.verifier, ...overrides.verifier },
  };
  return schema.parse(merged);
}
