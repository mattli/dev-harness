import type { FreezeReason } from "../contract/types.js";

export type RunStatus = "running" | "passed" | "halted";
export interface Sprint { id: number; title: string; description: string; }
export interface RunState {
  runId: string; goal: string; status: RunStatus;
  sprints: Sprint[]; currentSprint: number; contractVersion: number;
  scores: number[]; iterations: number; budgetSpentUsd: number;
  haltReason: string | null;
  /** Why the current/most-recent contract froze — a snapshot mirroring
   *  contractVersion. Per-sprint history lives in the trace; this is the
   *  single-point state view. Null before the first contract freezes. */
  contractFreezeReason: FreezeReason | null;
}
