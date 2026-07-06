import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TraceEvent } from "./types.js";

export class TraceWriter {
  constructor(private filePath: string) { mkdirSync(dirname(filePath), { recursive: true }); }
  write(event: TraceEvent): void {
    appendFileSync(this.filePath, JSON.stringify(event) + "\n");
  }
}
