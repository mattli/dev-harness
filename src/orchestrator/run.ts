import { join } from "node:path";
import type { RunConfig } from "../config/types.js";
import type { RunState, Sprint } from "../state/types.js";
import type { Contract } from "../contract/types.js";
import type { AgentResult } from "../agents/invoke.js";
import type { VerifierResult } from "../verifier/types.js";
import { StateStore } from "../state/store.js";
import { TraceWriter } from "../trace/writer.js";
import { renderTranscript } from "../trace/renderer.js";
import { BudgetTracker } from "../budget/tracker.js";
import { negotiate } from "../contract/negotiate.js";
import { slugify } from "../workspace/worktree.js";
import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";

export interface LoopDeps {
  nowMs: () => number;
  runsDir: string;
  planSprints: (goal: string) => Promise<Sprint[]>;
  proposeContract: (prev: Contract | null, cwd: string) => Promise<Contract>;
  critiqueContract: (c: Contract) => Promise<{ agreed: boolean; contract: Contract }>;
  generateCode: (c: Contract, cwd: string) => Promise<AgentResult>;
  runVerifier: (cwd: string) => Promise<VerifierResult>;
  evaluateArtifact: (c: Contract, v: VerifierResult) => Promise<{ score: number; findings: string[] }>;
  createWorktree: (projectPath: string, root: string, branch: string) => Promise<{ path: string; branch: string }>;
  removeWorktree: (projectPath: string, path: string) => Promise<void>;
}

export async function runLoop(config: RunConfig, deps: LoopDeps): Promise<RunState> {
  const runDir = join(deps.runsDir, config.runId);
  const store = new StateStore(join(runDir, "state.json"));
  const trace = new TraceWriter(join(runDir, "trace.jsonl"));
  const budget = new BudgetTracker(config.caps, config.thresholds, deps.nowMs());
  const branch = `run/${slugify(config.goal)}-${config.runId}`;

  const state: RunState = {
    runId: config.runId, goal: config.goal, status: "running", sprints: [],
    currentSprint: 0, contractVersion: 0, scores: [], iterations: 0,
    budgetSpentUsd: 0, haltReason: null,
  };
  store.init(state);

  const traceEvent = (over: Partial<Parameters<TraceWriter["write"]>[0]>) =>
    trace.write({
      ts: new Date(deps.nowMs()).toISOString(), runId: config.runId, sprint: state.currentSprint,
      phase: "PLAN", agentRole: "system", contractVersion: state.contractVersion,
      inputDigest: "", toolCalls: [], outputDigest: "", tokens: 0, costUsd: 0, ...over,
    });

  const wt = await deps.createWorktree(config.projectPath, config.worktreeRoot, branch);

  const halt = (reason: string): RunState => {
    store.update({ status: "halted", haltReason: reason, budgetSpentUsd: budget.spent });
    return store.read();
  };

  try {
    const sprints = await deps.planSprints(config.goal);
    store.update({ sprints });
    traceEvent({ phase: "PLAN", agentRole: "planner", outputDigest: `${sprints.length} sprints` });

    for (const sprint of sprints) {
      store.update({ currentSprint: sprint.id });
      budget.resetSprint();

      const contract = await negotiate({
        propose: (prev) => deps.proposeContract(prev, wt.path),
        critique: deps.critiqueContract,
        maxRounds: config.caps.negotiationRounds,
      });
      store.update({ contractVersion: contract.version });
      traceEvent({ phase: "NEGOTIATE", contractVersion: contract.version, outputDigest: "frozen" });

      let passed = false;
      while (!passed) {
        budget.recordIteration();
        const gen = await deps.generateCode(contract, wt.path);
        budget.recordCost(gen.costUsd);
        traceEvent({ phase: "GENERATE", agentRole: "generator", costUsd: gen.costUsd, tokens: gen.tokens, toolCalls: gen.toolCalls });

        const verified = await deps.runVerifier(wt.path);
        const evalRes = await deps.evaluateArtifact(contract, verified);
        budget.recordScore(evalRes.score);
        state.scores.push(evalRes.score);
        store.update({ scores: state.scores, budgetSpentUsd: budget.spent });
        traceEvent({ phase: "EVALUATE", agentRole: "evaluator", outputDigest: `score ${evalRes.score}` });

        if (evalRes.score >= config.thresholds.advanceScore) { passed = true; break; }

        const stop = budget.checkStops(deps.nowMs());
        if (stop) { finalize(runDir, trace); return halt(stop); }
      }
    }

    store.update({ status: "passed", budgetSpentUsd: budget.spent });
    finalize(runDir, trace);
    return store.read();
  } finally {
    await deps.removeWorktree(config.projectPath, wt.path); // branch survives for review
  }
}

function finalize(runDir: string, trace: TraceWriter): void {
  const events = readFileSync(join(runDir, "trace.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  writeFileSync(join(runDir, "transcript.md"), renderTranscript(events));
}
