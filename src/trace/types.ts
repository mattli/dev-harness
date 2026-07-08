import type { Contract } from "../contract/types.js";

export type Phase = "PLAN" | "NEGOTIATE" | "GENERATE" | "EVALUATE" | "DECIDE";
export type AgentRole = "planner" | "generator" | "evaluator" | "system";
export interface TraceEvent {
  ts: string; runId: string; sprint: number; phase: Phase;
  agentRole: AgentRole; contractVersion: number;
  inputDigest: string; toolCalls: string[]; outputDigest: string;
  tokens: number; costUsd: number;
  /** The frozen contract, present only on NEGOTIATE events, so trace.jsonl is
   *  self-contained: a reader can see exactly what each score was measured
   *  against without loading another file. */
  contract?: Contract;
}
