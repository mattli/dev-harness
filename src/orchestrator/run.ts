import { join } from "node:path";
import type { RunConfig } from "../config/types.js";
import type { RunState, Sprint } from "../state/types.js";
import type { Contract, FreezeReason } from "../contract/types.js";
import type { AgentResult } from "../agents/invoke.js";
import type { VerifierResult } from "../verifier/types.js";
import { StateStore } from "../state/store.js";
import { TraceWriter } from "../trace/writer.js";
import { renderTranscript } from "../trace/renderer.js";
import { BudgetTracker, BudgetHalt } from "../budget/tracker.js";
import { negotiate, type PriorRound } from "../contract/negotiate.js";
import { reserveRunDir, runBranch } from "../state/run-path.js";
import { readFileSync, writeFileSync } from "node:fs";

export interface LoopDeps {
  nowMs: () => number;
  runsDir: string;
  planRun: (goal: string) => Promise<{ title: string; sprints: Sprint[] }>;
  proposeContract: (sprint: Sprint, prev: PriorRound | null, cwd: string) => Promise<Contract>;
  critiqueContract: (sprint: Sprint, c: Contract) => Promise<{ agreed: boolean; contract: Contract; critique: string }>;
  generateCode: (sprint: Sprint, c: Contract, cwd: string) => Promise<AgentResult>;
  runVerifier: (cwd: string) => Promise<VerifierResult>;
  worktreeDiff: (worktreePath: string) => Promise<string>;
  evaluateArtifact: (c: Contract, artifactDiff: string, v: VerifierResult) => Promise<{ score: number | null; findings: string[] }>;
  createWorktree: (projectPath: string, root: string, branch: string) => Promise<{ path: string; branch: string }>;
  commitWorktree: (worktreePath: string, message: string) => Promise<boolean>;
  removeWorktree: (projectPath: string, path: string) => Promise<void>;
}

export async function runLoop(config: RunConfig, deps: LoopDeps): Promise<RunState> {
  // Plan first: the run folder name needs the planner's title, so the whole run
  // directory (state.json, trace.jsonl, transcript.md) is created only after we
  // know it. The internal runId still identifies the run in state + the branch.
  // Read the clock once: startedAt, the folder date, and the budget start must
  // all reference the same instant (and adding clock reads here must not shift
  // the budget's start time — a backstop regression).
  const startMs = deps.nowMs();
  const startedAt = new Date(startMs).toISOString();

  // A planner failure must still leave an inspectable run on disk (as it did
  // before planning moved ahead of run-dir creation). Catch it, fall back to the
  // goal for the folder name, and halt below with a persisted record.
  let plan: { title: string; sprints: Sprint[] };
  let planError: unknown = null;
  try {
    plan = await deps.planRun(config.goal);
  } catch (e) {
    planError = e;
    plan = { title: config.goal, sprints: [] };
  }

  // reserveRunDir creates the folder atomically so two concurrent same-title runs
  // on the same day can't compute the same path and clobber each other.
  const runDir = reserveRunDir(deps.runsDir, config.projectPath, plan.title, startMs);
  const store = new StateStore(join(runDir, "state.json"));
  const trace = new TraceWriter(join(runDir, "trace.jsonl"));
  const budget = new BudgetTracker(config.caps, config.thresholds, startMs);
  const branch = runBranch(config.goal, config.runId);

  const state: RunState = {
    runId: config.runId, goal: config.goal, title: plan.title, startedAt, runDir, status: "running",
    sprints: plan.sprints, currentSprint: 0, contractVersion: 0, scores: [], iterations: 0,
    budgetSpentUsd: 0, haltReason: null, contractFreezeReason: null,
  };
  store.init(state);

  // Single source of truth for run state: keep the in-memory `state` authoritative
  // and persist the same patch. traceEvent, the halt commit message, and the
  // transcript all read the in-memory `state`, so disk and memory must never
  // diverge (a prior bug persisted currentSprint/contractVersion to disk only,
  // leaving every trace event stuck at sprint 0 / contract v0).
  const update = (patch: Partial<RunState>): void => {
    Object.assign(state, patch);
    store.update(patch);
  };

  const traceEvent = (over: Partial<Parameters<TraceWriter["write"]>[0]>) =>
    trace.write({
      ts: new Date(deps.nowMs()).toISOString(), runId: config.runId, sprint: state.currentSprint,
      phase: "PLAN", agentRole: "system", contractVersion: state.contractVersion,
      inputDigest: "", toolCalls: [], outputDigest: "", tokens: 0, costUsd: 0, ...over,
    });

  // Planning failed: persist a halted, inspectable run and stop before creating
  // any worktree (nothing to clean up on this path).
  if (planError) {
    traceEvent({ phase: "PLAN", agentRole: "planner", outputDigest: "planner-error" });
    update({ status: "halted", haltReason: "planner-error", budgetSpentUsd: budget.spent });
    finalize(runDir, trace, state);
    return store.read();
  }

  const wt = await deps.createWorktree(config.projectPath, config.worktreeRoot, branch);

  const halt = (reason: string): RunState => {
    update({ status: "halted", haltReason: reason, budgetSpentUsd: budget.spent });
    return store.read();
  };

  // Halt gracefully: commit whatever partial work exists so a rejected/halted run
  // stays reviewable on the branch (the commit is for review, not endorsement —
  // the score + transcript carry the quality signal), then render + mark halted.
  // The outer finally still removes the worktree; the branch + its commits survive.
  const haltRun = async (reason: string): Promise<RunState> => {
    await deps.commitWorktree(wt.path, `sprint ${state.currentSprint}: partial work — halted (${reason})`);
    traceEvent({ phase: "DECIDE", outputDigest: `halt:${reason}` });
    // Set status/haltReason on `state` BEFORE rendering, or the transcript is
    // written while the run still looks "running" — the outcome line and the
    // per-stage stop reason would both be missing from the on-disk transcript.
    const result = halt(reason);
    finalize(runDir, trace, state);
    return result;
  };

  try {
    traceEvent({ phase: "PLAN", agentRole: "planner", outputDigest: `${plan.sprints.length} sprints` });

    for (const sprint of plan.sprints) {
      update({ currentSprint: sprint.id });
      budget.resetSprint(deps.nowMs());

      let contract: Contract;
      let freezeReason: FreezeReason;
      try {
        const outcome = await negotiate({
          propose: (prev) => deps.proposeContract(sprint, prev, wt.path),
          critique: (c) => deps.critiqueContract(sprint, c),
          maxRounds: config.caps.negotiationRounds,
          // Enforce the wall-clock/$ backstops at the top of every negotiation
          // round, before the next pair of Opus calls — otherwise a long
          // negotiation could overshoot the caps between DECIDE-point checks.
          checkStop: () => {
            const r = budget.checkStops(deps.nowMs());
            if (r) throw new BudgetHalt(r);
          },
        });
        contract = outcome.contract;
        freezeReason = outcome.freezeReason;
      } catch (e) {
        if (e instanceof BudgetHalt) {
          return await haltRun(e.reason); // outer finally still removes the worktree; branch survives
        }
        throw e;
      }
      update({ contractVersion: contract.version, contractFreezeReason: freezeReason });
      traceEvent({ phase: "NEGOTIATE", contractVersion: contract.version, outputDigest: `frozen (${freezeReason})`, contract });

      let passed = false;
      while (!passed) {
        budget.recordIteration();
        const gen = await deps.generateCode(sprint, contract, wt.path);
        budget.recordCost(gen.costUsd);
        traceEvent({ phase: "GENERATE", agentRole: "generator", costUsd: gen.costUsd, tokens: gen.tokens, toolCalls: gen.toolCalls });

        const verified = await deps.runVerifier(wt.path);
        // The evaluator grades the ARTIFACT (diff of the produced changes) against
        // the frozen contract — blind to the goal/sprint, the generator's
        // transcript, and commit messages (none of which it receives).
        const artifactDiff = await deps.worktreeDiff(wt.path);
        const evalRes = await deps.evaluateArtifact(contract, artifactDiff, verified);

        // An unparseable score is an ERROR, never a 0 — a flaky parse must not be
        // able to silently drive an advance or a no-progress decision.
        if (evalRes.score === null) {
          traceEvent({ phase: "EVALUATE", agentRole: "evaluator", outputDigest: "score UNPARSEABLE" });
          return await haltRun("evaluator-parse-error");
        }

        budget.recordScore(evalRes.score);
        state.scores.push(evalRes.score);
        update({ scores: state.scores, budgetSpentUsd: budget.spent });
        traceEvent({ phase: "EVALUATE", agentRole: "evaluator", outputDigest: `score ${evalRes.score}`, score: evalRes.score });

        if (evalRes.score >= config.thresholds.advanceScore) {
          // Commit this sprint's work to the run branch BEFORE cleanup, so it
          // survives removeWorktree's --force and is actually reviewable.
          await deps.commitWorktree(wt.path, `sprint ${sprint.id} "${sprint.title}" passed (score ${evalRes.score})`);
          traceEvent({ phase: "DECIDE", outputDigest: `advance (score ${evalRes.score})` });
          passed = true;
          break;
        }

        const stop = budget.checkStops(deps.nowMs());
        if (stop) { return await haltRun(stop); }
      }
    }

    update({ status: "passed", budgetSpentUsd: budget.spent });
    finalize(runDir, trace, state);
    return store.read();
  } catch (e) {
    // A BudgetHalt from ANY agent call (generate/evaluate/propose/critique) —
    // most importantly a subscription usage-limit — halts gracefully: commit the
    // partial work, mark halted, render. Non-BudgetHalt errors still throw.
    if (e instanceof BudgetHalt) return await haltRun(e.reason);
    throw e;
  } finally {
    await deps.removeWorktree(config.projectPath, wt.path); // branch survives for review
  }
}

function finalize(runDir: string, trace: TraceWriter, state: RunState): void {
  const events = readFileSync(join(runDir, "trace.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  writeFileSync(join(runDir, "transcript.md"), renderTranscript(events, state));
}
