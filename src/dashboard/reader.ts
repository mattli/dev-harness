import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { RunState, RunStatus } from "../state/types.js";
import type { Phase, TraceEvent } from "../trace/types.js";

/** One per-sprint score. `sprint` is null when the value came from the flat
 *  `state.scores[]` append-log (which is run-wide, not per-sprint) rather than
 *  from an EVALUATE trace event that carries its own `sprint`. */
export interface ScoreEntry {
  sprint: number | null;
  score: number;
}

/** One row of the per-sprint breakdown: what the sprint was, how many
 *  negotiation rounds its contract took to freeze, its latest score, and whether
 *  it's the one currently running. All derived from existing run-folder data
 *  (state.sprints + trace NEGOTIATE/EVALUATE events) — nothing new is emitted. */
export interface SprintSummary {
  index: number;
  title: string | null;
  /** The sprint's plan-time description — "what this sprint did". Null absent. */
  description: string | null;
  /** Negotiation rounds = the frozen `contractVersion` on this sprint's
   *  NEGOTIATE trace event. Null when the sprint hasn't negotiated yet. */
  rounds: number | null;
  /** Build attempts = the count of GENERATE trace events for this sprint.
   *  DERIVED from the trace, never read from `state.iterations` (which is
   *  initialized to 0 and never updated — see design decisions "Latent
   *  finding"). Null when the sprint has no GENERATE events yet. */
  attempts: number | null;
  /** File edits = the count of "Edit" entries across this sprint's GENERATE
   *  events' `toolCalls[]` arrays. Null when the sprint has no GENERATE events
   *  yet. */
  edits: number | null;
  /** Cost = the sum of `costUsd` across this sprint's trace events. Null when
   *  the sprint has no cost-bearing trace events yet. */
  cost: number | null;
  /** Latest score for this sprint, or null when not yet evaluated. */
  score: number | null;
  /** The lifecycle state of this sprint for the v2 card: "done" (completed with
   *  a score), "running" (the current sprint of a live run), "halted" (the
   *  current sprint of a paused/stopped run), or "pending" (not reached yet). */
  state: "done" | "running" | "halted" | "pending";
  /** The active phase index (0=Negotiate,1=Generate,2=Evaluate,3=Decide) for a
   *  running/halted sprint, derived from that sprint's last trace event. Null
   *  for done/pending sprints. */
  activePhase: number | null;
  current: boolean;
}

/** The display-mapped, plain-JS view the dashboard renders. Every field is
 *  either a real run-folder value or a null/placeholder — nothing here throws,
 *  so a mid-write or missing input degrades instead of blowing up. */
export interface DashboardData {
  runId: string | null;
  goal: string | null;
  /** The one-line goal lifted VERBATIM from `goal`: its first meaningful line
   *  with any YAML frontmatter block and a leading "#" markdown heading skipped.
   *  Never AI-summarized. Null when there is no goal text. */
  oneLineGoal: string | null;
  /** The repo name that leads the goal-first header: the basename of
   *  `state.projectPath`, falling back to the basename of `state.runDir`, then
   *  the served runDir. Null when none can be derived. */
  repoName: string | null;
  currentSprint: number | null;
  currentSprintTitle: string | null;
  /** Total planned sprints = state.sprints.length (0 when absent). */
  totalSprints: number;
  /** Per-sprint breakdown (count, rounds, score) — one row per planned sprint. */
  sprintBreakdown: SprintSummary[];
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

/** The v2 phase pipeline order used for the active-sprint stepper and the
 *  `activePhase` index. NEGOTIATE→0, GENERATE→1, EVALUATE→2, DECIDE→3. PLAN
 *  events precede any sprint's pipeline and map to no pipeline index. */
const PHASE_INDEX: Record<string, number> = {
  NEGOTIATE: 0,
  GENERATE: 1,
  EVALUATE: 2,
  DECIDE: 3,
};

/** Per-sprint breakdown from existing data: rounds = the frozen contractVersion
 *  on each sprint's NEGOTIATE event; score = that sprint's latest EVALUATE
 *  score; attempts = the count of GENERATE events for the sprint (NOT
 *  state.iterations); edits = the count of "Edit" entries across those GENERATE
 *  events' toolCalls[]; cost = the sum of costUsd across the sprint's trace
 *  events. One row per planned sprint, in order. */
function deriveSprintBreakdown(
  sprints: { title?: string; description?: string }[],
  events: TraceEvent[],
  scores: ScoreEntry[],
  currentSprint: number | null,
  status: RunStatus | null,
): SprintSummary[] {
  const roundsBySprint = new Map<number, number>();
  const attemptsBySprint = new Map<number, number>();
  const editsBySprint = new Map<number, number>();
  const costBySprint = new Map<number, number>();
  const lastPhaseBySprint = new Map<number, string>();
  for (const e of events) {
    if (typeof e.sprint !== "number") continue;
    const sp = e.sprint;
    if (e.phase === "NEGOTIATE" && typeof e.contractVersion === "number") {
      roundsBySprint.set(sp, e.contractVersion);
    }
    if (e.phase === "GENERATE") {
      // Build attempts: count of GENERATE trace events for this sprint. This is
      // the authoritative source — state.iterations is known-stale.
      attemptsBySprint.set(sp, (attemptsBySprint.get(sp) ?? 0) + 1);
      // File edits: count "Edit" entries in this GENERATE event's toolCalls[].
      const calls = Array.isArray(e.toolCalls) ? e.toolCalls : [];
      const edits = calls.filter((c) => c === "Edit").length;
      editsBySprint.set(sp, (editsBySprint.get(sp) ?? 0) + edits);
    }
    if (typeof e.costUsd === "number" && Number.isFinite(e.costUsd)) {
      costBySprint.set(sp, (costBySprint.get(sp) ?? 0) + e.costUsd);
    }
    if (e.phase in PHASE_INDEX) lastPhaseBySprint.set(sp, e.phase);
  }
  // Latest score per sprint (last EVALUATE wins) for the "done" card, and the
  // best/highest score per sprint for the halted card's "best N" — a paused
  // sprint reports the best score it reached, not merely its final attempt.
  const scoreBySprint = new Map<number, number>();
  const bestScoreBySprint = new Map<number, number>();
  for (const s of scores) {
    if (s.sprint !== null) {
      scoreBySprint.set(s.sprint, s.score);
      const prevBest = bestScoreBySprint.get(s.sprint);
      if (prevBest === undefined || s.score > prevBest) {
        bestScoreBySprint.set(s.sprint, s.score);
      }
    }
  }
  const finished = status === "passed" || status === "halted";
  return sprints.map((sp, i) => {
    const isCurrent = i === currentSprint;
    const latest = scoreBySprint.has(i) ? (scoreBySprint.get(i) as number) : null;
    // Lifecycle state for the v2 card:
    //   - the current sprint of a halted run is "halted",
    //   - the current sprint of a live run is "running",
    //   - a sprint at-or-before the current index (or any sprint in a finished
    //     run) counts as "done", the rest are "pending".
    let cardState: SprintSummary["state"];
    if (isCurrent && status === "halted") cardState = "halted";
    else if (isCurrent && status === "running") cardState = "running";
    else if (currentSprint !== null && i < currentSprint) cardState = "done";
    else if (finished && (currentSprint === null || i <= currentSprint)) cardState = "done";
    else cardState = "pending";
    const active =
      cardState === "running" || cardState === "halted"
        ? PHASE_INDEX[lastPhaseBySprint.get(i) ?? "GENERATE"] ?? 1
        : null;
    // A halted card shows the BEST score the sprint reached ("best N"); every
    // other card shows the latest score.
    const score =
      cardState === "halted" && bestScoreBySprint.has(i)
        ? (bestScoreBySprint.get(i) as number)
        : latest;
    return {
      index: i,
      title: sp?.title ?? null,
      description: sp?.description ?? null,
      rounds: roundsBySprint.has(i) ? (roundsBySprint.get(i) as number) : null,
      attempts: attemptsBySprint.has(i) ? (attemptsBySprint.get(i) as number) : null,
      edits: editsBySprint.has(i) ? (editsBySprint.get(i) as number) : null,
      cost: costBySprint.has(i) ? (costBySprint.get(i) as number) : null,
      score,
      state: cardState,
      activePhase: active,
      current: isCurrent,
    };
  });
}

/** Lift the one-line goal VERBATIM from the full goal text: skip a leading YAML
 *  frontmatter block (`---` … `---`), skip a leading "#" markdown heading, and
 *  return the first remaining non-empty line trimmed. Never summarizes; returns
 *  null when there is no meaningful line. */
function deriveOneLineGoal(goal: string | null): string | null {
  if (typeof goal !== "string") return null;
  const lines = goal.split("\n");
  let i = 0;
  // Skip a leading YAML frontmatter block delimited by --- on its own line.
  if (lines[i]?.trim() === "---") {
    i++;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    if (i < lines.length) i++; // consume the closing ---
  }
  // Walk forward to the first meaningful line, skipping blanks and a leading
  // "#"-prefixed markdown heading.
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (line.startsWith("#")) continue;
    return line;
  }
  return null;
}

/** Derive the repo name (basename) from projectPath, then runDir, then the
 *  served run-folder path. Null when none is available. */
function deriveRepoName(
  projectPath: string | null,
  runDirField: string | null,
  servedRunDir: string | null,
): string | null {
  for (const candidate of [projectPath, runDirField, servedRunDir]) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      const base = basename(candidate.replace(/[/\\]+$/, ""));
      if (base) return base;
    }
  }
  return null;
}

/** The latest trace-event timestamp in ms, or null when no event carries a
 *  parseable `ts`. Takes the max rather than trusting positional order. */
function lastEventTsMs(events: TraceEvent[]): number | null {
  let max: number | null = null;
  for (const e of events) {
    const t = typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
    if (!Number.isNaN(t)) max = max === null ? t : Math.max(max, t);
  }
  return max;
}

/** Elapsed wall-clock in ms. For a LIVE run (status "running", or unknown) this
 *  counts up: `nowMs` minus startedAt. For a FINISHED run (status "passed" or
 *  "halted") it FREEZES at the run's real length — the last trace event's
 *  timestamp minus startedAt — so a completed run shows how long it actually
 *  took instead of ticking upward forever. Null when startedAt is absent or
 *  unparseable — never NaN. */
function computeElapsedMs(
  nowMs: number,
  startedAt: unknown,
  status: RunStatus | null,
  events: TraceEvent[],
): number | null {
  if (typeof startedAt !== "string") return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  const finished = status === "passed" || status === "halted";
  const lastTs = finished ? lastEventTsMs(events) : null;
  const endMs = lastTs ?? nowMs;
  return Math.max(0, endMs - started);
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
function emptyData(
  scores: ScoreEntry[],
  phase: Phase | null,
  repoName: string | null = null,
): DashboardData {
  return {
    runId: null,
    goal: null,
    oneLineGoal: null,
    repoName,
    currentSprint: null,
    currentSprintTitle: null,
    totalSprints: 0,
    sprintBreakdown: [],
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
    // Corrupt / half-written / absent state.json: degrade, don't throw. We can
    // still derive the repo name from the served run-folder path so the
    // goal-first header leads with something meaningful even while updating.
    return emptyData(
      deriveScores(traceEvents, undefined),
      phase,
      deriveRepoName(null, null, runDir),
    );
  }

  const scores = deriveScores(traceEvents, state.scores);
  const sprints = Array.isArray(state.sprints)
    ? (state.sprints as { title?: string; description?: string }[])
    : [];
  const currentSprint = pick<number>(state, "currentSprint");
  const currentSprintTitle =
    currentSprint !== null && sprints[currentSprint]
      ? sprints[currentSprint].title ?? null
      : null;
  const status = pick<RunStatus>(state, "status");
  const sprintBreakdown = deriveSprintBreakdown(sprints, traceEvents, scores, currentSprint, status);
  const goal = pick<string>(state, "goal");
  const runDirField = pick<string>(state, "runDir");
  const projectPath = pick<string>(state, "projectPath");

  return {
    runId: pick<string>(state, "runId"),
    goal,
    oneLineGoal: deriveOneLineGoal(goal),
    repoName: deriveRepoName(projectPath, runDirField, runDir),
    currentSprint,
    currentSprintTitle,
    totalSprints: sprints.length,
    sprintBreakdown,
    contractVersion: pick<number>(state, "contractVersion"),
    phase,
    status,
    haltReason: pick<string>(state, "haltReason"),
    contractFreezeReason: pick<string>(state, "contractFreezeReason"),
    budgetSpentUsd: pick<number>(state, "budgetSpentUsd"),
    runDir: pick<string>(state, "runDir"),
    startedAt: pick<string>(state, "startedAt"),
    elapsedMs: computeElapsedMs(nowMs, state.startedAt, status, traceEvents),
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

/**
 * Auto-discover the newest run folder ACROSS all projects under `runsRoot`.
 *
 * The on-disk layout is runs/<project>/<run>/, so this scans two levels: each
 * immediate child of `runsRoot` is a project, and each of ITS children holding a
 * `state.json` is a run. Returns the run whose `state.json` was written most
 * recently — the best "currently-active" signal, since a live run rewrites
 * state.json every step — or null when none is found. Never throws.
 *
 * This is what an always-on dashboard points at: it follows whatever run is
 * active regardless of which project the harness was aimed at. The `_archive`
 * project is skipped so retired runs are never surfaced as the current one.
 */
export function findLatestRunAcrossProjects(runsRoot: string): string | null {
  let projects: string[];
  try {
    projects = readdirSync(runsRoot);
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const project of projects) {
    if (project === "_archive") continue;
    const projectPath = join(runsRoot, project);
    let runs: string[];
    try {
      if (!statSync(projectPath).isDirectory()) continue;
      runs = readdirSync(projectPath);
    } catch {
      // Not a directory / unreadable project entry: skip it.
      continue;
    }
    for (const run of runs) {
      const runPath = join(projectPath, run);
      try {
        if (!statSync(runPath).isDirectory()) continue;
        // A real run folder always has state.json; rank by when it was last
        // written so the actively-updating run wins over finished ones.
        const mtimeMs = statSync(join(runPath, "state.json")).mtimeMs;
        if (best === null || mtimeMs > best.mtimeMs) {
          best = { path: runPath, mtimeMs };
        }
      } catch {
        // No state.json (not a run folder) or unreadable: skip.
      }
    }
  }
  return best ? best.path : null;
}

/** Convenience: assemble against an explicit path when given, otherwise against
 *  the auto-discovered latest run. Selection precedence: an explicit `runDir`,
 *  else the newest run directly under a single `runsDir`, else the newest run
 *  across all projects under `runsRoot`. Returns a degraded object when no run
 *  can be found rather than throwing. */
export function resolveAndAssemble(
  opts: { runDir?: string; runsDir?: string; runsRoot?: string; nowMs: number },
): DashboardData {
  const target =
    opts.runDir ??
    (opts.runsDir
      ? findLatestRunDir(opts.runsDir)
      : opts.runsRoot
        ? findLatestRunAcrossProjects(opts.runsRoot)
        : null);
  if (!target) return emptyData([], null);
  return assembleDashboardData(target, opts.nowMs);
}
