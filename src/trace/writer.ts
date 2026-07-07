import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TraceEvent } from "./types.js";

export class TraceWriter {
  // One writer == one run. Truncate at construction so a reused runId starts a
  // clean trace (matching state.json's overwrite-per-run); events then stream via
  // append. Without this, a rerun appends onto the prior run and finalize()
  // renders both into transcript.md.
  constructor(private filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "");
  }
  write(event: TraceEvent): void {
    appendFileSync(this.filePath, JSON.stringify(event) + "\n");
  }
}
