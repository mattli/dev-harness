import { invokeAgent, type QueryFn } from "./invoke.js";
import { loadPrompt } from "./prompts.js";
import type { Contract } from "../contract/types.js";
import type { VerifierResult } from "../verifier/types.js";

export interface EvaluatorDeps { queryFn: QueryFn; model: string; }

export async function critiqueContract(
  deps: EvaluatorDeps, contract: Contract,
): Promise<{ agreed: boolean; contract: Contract }> {
  const res = await invokeAgent({
    queryFn: deps.queryFn, model: deps.model,
    systemPrompt: loadPrompt("evaluator"),
    prompt: `Critique this proposed contract:\n${JSON.stringify(contract, null, 2)}`,
  });
  return { agreed: /^AGREEMENT:\s*yes/im.test(res.text), contract };
}

/** Extract the evaluator's 0–100 score. Returns `null` when NO score is present,
 *  so callers can distinguish "no score found" (a parse/format failure) from a
 *  genuine grade of 0 — the two must never be conflated when driving advance /
 *  no-progress decisions. Tolerant of markdown wrapping (`**SCORE:** 88`,
 *  `## Score: 90`) and trailing text (`SCORE: 88/100`); takes the LAST score
 *  mention, since the prompt instructs the model to END with the SCORE line. */
export function parseScore(text: string): number | null {
  const matches = [...text.matchAll(/score[^0-9]*(\d{1,3})/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return Math.min(100, parseInt(last[1], 10));
}

// BLIND: prompt carries only contract + artifact summary + verifier result.
export async function evaluateArtifact(
  deps: EvaluatorDeps, contract: Contract, verifier: VerifierResult,
): Promise<{ score: number | null; findings: string[] }> {
  const res = await invokeAgent({
    queryFn: deps.queryFn, model: deps.model,
    systemPrompt: loadPrompt("evaluator"),
    prompt: [
      `Contract:\n${JSON.stringify(contract, null, 2)}`,
      `Verifier: ${verifier.passed ? "PASSED" : "FAILED"}`,
      verifier.findings.length ? `Verifier findings:\n${verifier.findings.join("\n")}` : "",
    ].filter(Boolean).join("\n\n"),
  });
  const score = parseScore(res.text);
  const findings = res.text.split("\n").filter((l) => /^[-*]\s/.test(l)).map((l) => l.trim());
  return { score, findings };
}
