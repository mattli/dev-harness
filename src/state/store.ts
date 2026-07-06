import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunState } from "./types.js";

export class StateStore {
  constructor(private filePath: string) { mkdirSync(dirname(filePath), { recursive: true }); }
  init(state: RunState): void { this.persist(state); }
  read(): RunState { return JSON.parse(readFileSync(this.filePath, "utf8")); }
  update(patch: Partial<RunState>): void { this.persist({ ...this.read(), ...patch }); }
  private persist(state: RunState): void {
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.filePath);
  }
}
