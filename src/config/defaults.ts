export const DEFAULTS = {
  models: { planner: "claude-opus-4-8", generator: "claude-opus-4-8", evaluator: "claude-opus-4-8" },
  thresholds: { advanceScore: 85, noProgressDelta: 5, noProgressWindow: 2 },
  caps: {
    maxIterationsPerSprint: 6,
    negotiationRounds: 5,
    dollarCeiling: null,
    wallClockMsPerSprint: 30 * 60 * 1000,
  },
  verifier: { kind: "test-suite" as const, command: "npm test" },
  worktreeRoot: ".dev-harness-worktrees",
};
