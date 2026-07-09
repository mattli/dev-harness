import type { Contract } from "../contract/types.js";

export type Phase = "PLAN" | "NEGOTIATE" | "GENERATE" | "EVALUATE" | "DECIDE";
export type AgentRole = "planner" | "generator" | "evaluator" | "system";
export interface TraceEvent {
  ts: string; runId: string; sprint: number; phase: Phase;
  agentRole: AgentRole; contractVersion: number;
  inputDigest: string; toolCalls: string[]; outputDigest: string;
  tokens: number; costUsd: number;
  /** The evaluator's numeric score, set on EVALUATE events. Structured so the
   *  transcript reads it directly instead of scraping it back out of the digest
   *  string (see the project lesson on emitting a marker, not parsing prose). */
  score?: number;
  /** The frozen contract, present only on NEGOTIATE events, so trace.jsonl is
   *  self-contained: a reader can see exactly what each score was measured
   *  against without loading another file. */
  contract?: Contract;
}
