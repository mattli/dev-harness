export type RunStatus = "running" | "passed" | "halted";
export interface Sprint { id: number; title: string; description: string; }
export interface RunState {
  runId: string; goal: string; status: RunStatus;
  sprints: Sprint[]; currentSprint: number; contractVersion: number;
  scores: number[]; iterations: number; budgetSpentUsd: number;
  haltReason: string | null;
}
