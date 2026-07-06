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

// BLIND: prompt carries only contract + artifact summary + verifier result.
export async function evaluateArtifact(
  deps: EvaluatorDeps, contract: Contract, verifier: VerifierResult,
): Promise<{ score: number; findings: string[] }> {
  const res = await invokeAgent({
    queryFn: deps.queryFn, model: deps.model,
    systemPrompt: loadPrompt("evaluator"),
    prompt: [
      `Contract:\n${JSON.stringify(contract, null, 2)}`,
      `Verifier: ${verifier.passed ? "PASSED" : "FAILED"}`,
      verifier.findings.length ? `Verifier findings:\n${verifier.findings.join("\n")}` : "",
    ].filter(Boolean).join("\n\n"),
  });
  const m = res.text.match(/^SCORE:\s*(\d{1,3})/im);
  const score = m ? Math.min(100, parseInt(m[1], 10)) : 0;
  const findings = res.text.split("\n").filter((l) => /^[-*]\s/.test(l)).map((l) => l.trim());
  return { score, findings };
}
