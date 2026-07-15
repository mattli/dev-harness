export type StopReason = "max-iteration" | "no-progress" | "dollar-ceiling" | "wall-clock" | "usage-limit";

/** Thrown to abort work mid-flight when a hard stop trips somewhere the DECIDE
 *  point can't reach it (inside negotiation, or a usage-limit raised from an
 *  agent call). The orchestrator catches it and routes through the graceful
 *  halt-and-return path. */
export class BudgetHalt extends Error {
  constructor(public readonly reason: StopReason) {
    super(`budget halt: ${reason}`);
    this.name = "BudgetHalt";
  }
}

interface Caps { maxIterationsPerSprint: number; negotiationRounds: number; dollarCeiling: number | null; wallClockMsPerSprint: number; }
interface Thresholds { advanceScore: number; noProgressDelta: number; noProgressWindow: number; }

export class BudgetTracker {
  private spentUsd = 0;
  private iterations = 0;
  private flatCount = 0;
  private lastScore: number | null = null;
  private sprintStartMs: number;

  constructor(private caps: Caps, private thr: Thresholds, startMs: number) {
    this.sprintStartMs = startMs;
  }

  recordCost(usd: number): void { this.spentUsd += usd; }
  recordIteration(): void { this.iterations += 1; }

  recordScore(score: number): void {
    if (this.lastScore !== null && score - this.lastScore < this.thr.noProgressDelta) {
      this.flatCount += 1;
    } else {
      this.flatCount = 0;
    }
    this.lastScore = score;
  }

  /** Call when starting a new sprint. Iteration/progress counters AND the
   *  wall-clock baseline are per-sprint, so pass the current clock. */
  resetSprint(nowMs: number): void {
    this.iterations = 0; this.flatCount = 0; this.lastScore = null;
    this.sprintStartMs = nowMs;
  }

  get spent(): number { return this.spentUsd; }

  checkStops(nowMs: number): StopReason | null {
    if (this.caps.dollarCeiling !== null && this.spentUsd >= this.caps.dollarCeiling) return "dollar-ceiling";
    if (nowMs - this.sprintStartMs >= this.caps.wallClockMsPerSprint) return "wall-clock";
    if (this.iterations >= this.caps.maxIterationsPerSprint) return "max-iteration";
    if (this.flatCount >= this.thr.noProgressWindow) return "no-progress";
    return null;
  }
}
