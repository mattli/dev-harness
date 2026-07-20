import type { RunConfig } from "../config/types.js";
import type { LoopDeps } from "../orchestrator/run.js";
import type { QueryFn } from "../agents/invoke.js";
import { planRun } from "../agents/planner.js";
import { proposeContract, generateCode } from "../agents/generator.js";
import { critiqueContract, evaluateArtifact } from "../agents/evaluator.js";
import { createWorktree, commitWorktree, worktreeDiff, removeWorktree } from "../workspace/worktree.js";
import { TestSuiteVerifier } from "../verifier/test-suite.js";

export function wireDeps(config: RunConfig, queryFn: QueryFn): LoopDeps {
  const verifier = new TestSuiteVerifier(config.verifier.command);
  const goal = config.goal;
  return {
    nowMs: () => Date.now(),
    runsDir: "runs",
    planRun: (g) => planRun({ queryFn, model: config.models.planner, goal: g }),
    proposeContract: (sprint, prev, cwd) => proposeContract({ queryFn, model: config.models.generator, cwd, goal }, sprint, prev),
    critiqueContract: (sprint, c, cwd) => critiqueContract({ queryFn, model: config.models.evaluator, goal }, sprint, c, cwd),
    generateCode: (sprint, c, cwd) => generateCode({ queryFn, model: config.models.generator, cwd, goal }, sprint, c),
    runVerifier: (cwd) => verifier.verify(cwd),
    worktreeDiff,
    evaluateArtifact: (view, diff, v) => evaluateArtifact({ queryFn, model: config.models.evaluator, goal }, view, diff, v),
    createWorktree,
    commitWorktree,
    removeWorktree,
  };
}
