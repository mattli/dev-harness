import type { RunConfig } from "../config/types.js";
import type { LoopDeps } from "../orchestrator/run.js";
import type { QueryFn } from "../agents/invoke.js";
import { planSprints } from "../agents/planner.js";
import { proposeContract, generateCode } from "../agents/generator.js";
import { critiqueContract, evaluateArtifact } from "../agents/evaluator.js";
import { createWorktree, removeWorktree } from "../workspace/worktree.js";
import { TestSuiteVerifier } from "../verifier/test-suite.js";

export function wireDeps(config: RunConfig, queryFn: QueryFn): LoopDeps {
  const verifier = new TestSuiteVerifier(config.verifier.command);
  return {
    nowMs: () => Date.now(),
    runsDir: "runs",
    planSprints: (goal) => planSprints({ queryFn, model: config.models.planner, goal }),
    proposeContract: (prev, cwd) => proposeContract({ queryFn, model: config.models.generator, cwd }, prev),
    critiqueContract: (c) => critiqueContract({ queryFn, model: config.models.evaluator }, c),
    generateCode: (c, cwd) => generateCode({ queryFn, model: config.models.generator, cwd }, c),
    runVerifier: (cwd) => verifier.verify(cwd),
    evaluateArtifact: (c, v) => evaluateArtifact({ queryFn, model: config.models.evaluator }, c, v),
    createWorktree,
    removeWorktree,
  };
}
