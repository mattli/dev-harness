export type ModelId = string;
export interface RunConfig {
  runId: string;
  goal: string;
  projectPath: string;
  worktreeRoot: string;
  models: { planner: ModelId; generator: ModelId; evaluator: ModelId };
  thresholds: { advanceScore: number; noProgressDelta: number; noProgressWindow: number };
  caps: {
    maxIterationsPerSprint: number;
    negotiationRounds: number;
    dollarCeiling: number;
    wallClockMs: number;
  };
  verifier: { kind: "test-suite"; command: string };
}
