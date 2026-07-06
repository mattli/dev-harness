export type StopReason = "max-iteration" | "no-progress" | "dollar-ceiling" | "wall-clock";

interface Caps { maxIterationsPerSprint: number; negotiationRounds: number; dollarCeiling: number; wallClockMs: number; }
interface Thresholds { advanceScore: number; noProgressDelta: number; noProgressWindow: number; }

export class BudgetTracker {
  private spentUsd = 0;
  private iterations = 0;
  private flatCount = 0;
  private lastScore: number | null = null;

  constructor(private caps: Caps, private thr: Thresholds, private startMs: number) {}

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

  /** Call when starting a new sprint — iteration and progress counters are per-sprint. */
  resetSprint(): void { this.iterations = 0; this.flatCount = 0; this.lastScore = null; }

  get spent(): number { return this.spentUsd; }

  checkStops(nowMs: number): StopReason | null {
    if (this.spentUsd >= this.caps.dollarCeiling) return "dollar-ceiling";
    if (nowMs - this.startMs >= this.caps.wallClockMs) return "wall-clock";
    if (this.iterations >= this.caps.maxIterationsPerSprint) return "max-iteration";
    if (this.flatCount >= this.thr.noProgressWindow) return "no-progress";
    return null;
  }
}
