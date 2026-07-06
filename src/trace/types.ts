export type Phase = "PLAN" | "NEGOTIATE" | "GENERATE" | "EVALUATE" | "DECIDE";
export type AgentRole = "planner" | "generator" | "evaluator" | "system";
export interface TraceEvent {
  ts: string; runId: string; sprint: number; phase: Phase;
  agentRole: AgentRole; contractVersion: number;
  inputDigest: string; toolCalls: string[]; outputDigest: string;
  tokens: number; costUsd: number;
}
