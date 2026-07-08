import type { TraceEvent } from "./types.js";

// Collapse any internal whitespace/newlines so a model-authored field (criteria
// come straight from LLM JSON) can't split one criterion across multiple
// transcript lines and mangle the structure a reviewer reads.
const oneLine = (s: string): string => String(s).replace(/\s*\n\s*/g, " ").trim();

function renderCriteria(contract: NonNullable<TraceEvent["contract"]>): string[] {
  // Guard the array: the renderer parses trace.jsonl back from disk, so a
  // format-skewed or hand-edited line must degrade to "(none)", not throw.
  const criteria = contract.criteria ?? [];
  if (!criteria.length) return ["- criteria: (none)"];
  return ["- criteria:", ...criteria.map((c) => `  - ${oneLine(c.id)}: ${oneLine(c.description)} [verify: ${oneLine(c.verifyBy)}]`)];
}

export function renderTranscript(events: TraceEvent[]): string {
  const runId = events[0]?.runId ?? "unknown";
  const lines: string[] = [`# Run ${runId}`, ""];
  let lastSprint = -1;
  for (const e of events) {
    if (e.sprint !== lastSprint) { lines.push(`## Sprint ${e.sprint}`, ""); lastSprint = e.sprint; }
    lines.push(
      `### ${e.phase} — ${e.agentRole} (contract v${e.contractVersion})`,
      `- tokens: ${e.tokens}, cost: $${e.costUsd.toFixed(4)}`,
      e.toolCalls.length ? `- tools: ${e.toolCalls.join(", ")}` : "",
      `- in: ${e.inputDigest}`,
      `- out: ${e.outputDigest}`,
      ...(e.contract ? renderCriteria(e.contract) : []),
      "",
    );
  }
  return lines.filter((l) => l !== "").join("\n") + "\n";
}
