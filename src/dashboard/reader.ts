import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunState, RunStatus } from "../state/types.js";
import type { Phase, TraceEvent } from "../trace/types.js";

/** One per-sprint score. `sprint` is null when the value came from the flat
 *  `state.scores[]` append-log (which is run-wide, not per-sprint) rather than
 *  from an EVALUATE trace event that carries its own `sprint`. */
export interface ScoreEntry {
  sprint: number | null;
  score: number;
}

/** The display-mapped, plain-JS view the dashboard renders. Every field is
 *  either a real run-folder value or a null/placeholder — nothing here throws,
 *  so a mid-write or missing input degrades instead of blowing up. */
export interface DashboardData {
  runId: string | null;
  goal: string | null;
  currentSprint: number | null;
  currentSprintTitle: string | null;
  contractVersion: number | null;
  phase: Phase | null;
  status: RunStatus | null;
  haltReason: string | null;
  contractFreezeReason: string | null;
  budgetSpentUsd: number | null;
  runDir: string | null;
  startedAt: string | null;
  elapsedMs: number | null;
  scores: ScoreEntry[];
  /** True ONLY when state.json could not be parsed (corrupt/half-written): the
   *  explicit "updating" / last-known-good discriminator. A merely-incomplete or
   *  missing-optional-field state is NOT degraded. */
  degraded: boolean;
  /** The explicit "updating"/stale signal for the /data endpoint, set to the
   *  same condition as {@link degraded}: true ONLY when state.json is
   *  corrupt/half-written/absent so the reader is serving fallbacks rather than
   *  a freshly-parsed state. Named separately from `degraded` because the
   *  contract requires a stable `stale` discriminator on the wire; the page and
   *  poller can key off either. A merely-incomplete or missing-optional-field
   *  state is NOT stale. */
  stale: boolean;
}

/** Read a file to text, returning null on any read failure (absent/unreadable).
 *  Kept separate from JSON parsing so an absent trace and a corrupt state are
 *  distinguishable at the call sites. */
function readTextOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Parse trace.jsonl into events, tolerating a truncated final line (a live run
 *  appends, so the last line may be caught mid-write). Non-parsing lines are
 *  skipped rather than throwing. */
function parseTrace(text: string | null): TraceEvent[] {
  if (!text) return [];
  const events: TraceEvent[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // Skip a half-written or malformed line; keep the good ones.
    }
  }
  return events;
}

/** Per-sprint scores. Prefer EVALUATE events (each carries its own sprint+score)
 *  in trace order. Fall back to the flat state.scores[] append-log — which is
 *  run-wide, so each entry maps to a null sprint, never a fabricated index. */
function deriveScores(events: TraceEvent[], stateScores: unknown): ScoreEntry[] {
  const evals = events.filter(
    (e) => e.phase === "EVALUATE" && typeof e.score === "number",
  );
  if (evals.length > 0) {
    return evals.map((e) => ({
      sprint: typeof e.sprint === "number" ? e.sprint : null,
      score: e.score as number,
    }));
  }
  if (Array.isArray(stateScores)) {
    return stateScores
      .filter((s): s is number => typeof s === "number")
      .map((score) => ({ sprint: null, score }));
  }
  return [];
}

/** Elapsed wall-clock in ms: caller-supplied `now` minus startedAt. Null when
 *  startedAt is absent or unparseable — never NaN. */
function computeElapsedMs(nowMs: number, startedAt: unknown): number | null {
  if (typeof startedAt !== "string") return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return nowMs - started;
}

/** The current step/phase: the phase of the LAST trace.jsonl line, whatever its
 *  phase type. Null when there are no parseable trace events. */
function currentPhase(events: TraceEvent[]): Phase | null {
  if (events.length === 0) return null;
  const last = events[events.length - 1];
  return (last?.phase as Phase | undefined) ?? null;
}

/** The all-null baseline used when state.json is corrupt/absent: the dashboard
 *  still renders (placeholders everywhere) and marks itself `degraded` so the UI
 *  can show an explicit "updating" signal instead of a blank error. */
function emptyData(scores: ScoreEntry[], phase: Phase | null): DashboardData {
  return {
    runId: null,
    goal: null,
    currentSprint: null,
    currentSprintTitle: null,
    contractVersion: null,
    phase,
    status: null,
    haltReason: null,
    contractFreezeReason: null,
    budgetSpentUsd: null,
    runDir: null,
    startedAt: null,
    elapsedMs: null,
    scores,
    degraded: true,
    stale: true,
  };
}

/** Pull a field off a loosely-typed parsed state, coercing absent/wrong-typed
 *  values to null so a missing optional field renders as a placeholder. */
function pick<T>(obj: Record<string, unknown>, key: string): T | null {
  const v = obj[key];
  return v === undefined || v === null ? null : (v as T);
}

/**
 * Assemble a run's live display state from an explicit run-folder path.
 *
 * Pure and import-safe: reads state.json + trace.jsonl from `runDir`, performs
 * NO writes, binds no port, starts no server. `nowMs` is caller-supplied so
 * elapsed time is deterministic (not read from Date.now() internally).
 *
 * Graceful degradation is core: a missing optional field surfaces as null with
 * `degraded === false`; a corrupt/half-written state.json that does not parse
 * returns a non-null object with `degraded === true` rather than throwing; an
 * empty/absent trace yields `phase === null`.
 */
export function assembleDashboardData(runDir: string, nowMs: number): DashboardData {
  const traceEvents = parseTrace(readTextOrNull(join(runDir, "trace.jsonl")));
  const phase = currentPhase(traceEvents);

  const stateText = readTextOrNull(join(runDir, "state.json"));
  let state: Record<string, unknown>;
  try {
    if (stateText === null) throw new Error("state.json absent");
    const parsed = JSON.parse(stateText);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("state.json is not an object");
    }
    state = parsed as Record<string, unknown>;
  } catch {
    // Corrupt / half-written / absent state.json: degrade, don't throw.
    return emptyData(deriveScores(traceEvents, undefined), phase);
  }

  const scores = deriveScores(traceEvents, state.scores);
  const sprints = Array.isArray(state.sprints) ? (state.sprints as { title?: string }[]) : [];
  const currentSprint = pick<number>(state, "currentSprint");
  const currentSprintTitle =
    currentSprint !== null && sprints[currentSprint]
      ? sprints[currentSprint].title ?? null
      : null;

  return {
    runId: pick<string>(state, "runId"),
    goal: pick<string>(state, "goal"),
    currentSprint,
    currentSprintTitle,
    contractVersion: pick<number>(state, "contractVersion"),
    phase,
    status: pick<RunStatus>(state, "status"),
    haltReason: pick<string>(state, "haltReason"),
    contractFreezeReason: pick<string>(state, "contractFreezeReason"),
    budgetSpentUsd: pick<number>(state, "budgetSpentUsd"),
    runDir: pick<string>(state, "runDir"),
    startedAt: pick<string>(state, "startedAt"),
    elapsedMs: computeElapsedMs(nowMs, state.startedAt),
    scores,
    degraded: false,
    stale: false,
  };
}

/**
 * Auto-discover the most-recently-modified run folder under `runsDir`.
 *
 * Returns the newest (highest mtime) sub-directory's absolute path, or null when
 * `runsDir` is empty, absent, or contains no sub-directories. Never throws.
 *
 * Note: the layout nests runs under runs/<project>/<run>. This helper returns
 * the newest immediate child directory of the given path, so callers can point
 * it at either runs/ or runs/<project>/ depending on their target selection.
 */
export function findLatestRunDir(runsDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(runsDir);
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    const full = join(runsDir, name);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      if (best === null || st.mtimeMs > best.mtimeMs) {
        best = { path: full, mtimeMs: st.mtimeMs };
      }
    } catch {
      // Unreadable entry: skip it.
    }
  }
  return best ? best.path : null;
}

/** Convenience: assemble against an explicit path when given, otherwise against
 *  the auto-discovered latest run under `runsDir`. Returns a degraded object when
 *  no run can be found rather than throwing. */
export function resolveAndAssemble(
  opts: { runDir?: string; runsDir?: string; nowMs: number },
): DashboardData {
  const target =
    opts.runDir ?? (opts.runsDir ? findLatestRunDir(opts.runsDir) : null);
  if (!target) return emptyData([], null);
  return assembleDashboardData(target, opts.nowMs);
}
