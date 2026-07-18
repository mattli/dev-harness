import type { FreezeReason } from "../contract/types.js";

export type RunStatus = "running" | "passed" | "halted";
export interface Sprint { id: number; title: string; description: string; }
export interface RunState {
  runId: string; goal: string; title: string; startedAt: string; status: RunStatus;
  sprints: Sprint[]; currentSprint: number; contractVersion: number;
  scores: number[]; iterations: number; budgetSpentUsd: number;
  haltReason: string | null;
  /** Where this run's artifacts live (runs/<project>/<date>-<title>/). Optional
   *  because runs written before this field existed won't carry it. */
  runDir?: string;
  /** The target project's absolute path (from config.projectPath). Optional,
   *  mirroring runDir, because runs written before this field existed won't
   *  carry it. */
  projectPath?: string;
  /** Why the current/most-recent contract froze — a snapshot mirroring
   *  contractVersion. Per-sprint history lives in the trace; this is the
   *  single-point state view. Null before the first contract freezes. */
  contractFreezeReason: FreezeReason | null;
}
