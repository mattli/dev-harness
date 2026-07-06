import type { TraceEvent } from "./types.js";

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
      "",
    );
  }
  return lines.filter((l) => l !== "").join("\n") + "\n";
}
