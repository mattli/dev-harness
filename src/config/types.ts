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
    dollarCeiling: number | null; // null = off (informational only); set to opt into a $ halt
    wallClockMsPerSprint: number; // primary cap, scoped per sprint
  };
  verifier: { kind: "test-suite"; command: string };
}
