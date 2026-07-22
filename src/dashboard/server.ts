import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { argv, env } from "node:process";
import { resolveAndAssemble, findLatestRunDir, type DashboardData, type SprintSummary } from "./reader.js";

/** Options for {@link start}. Either an explicit `runDir` (what tests always
 *  pass) or a `runsDir` to auto-discover the latest run under; `port` defaults
 *  to 0 (an OS-assigned ephemeral port) so tests fully control lifecycle. */
export interface StartOptions {
  /** Explicit run-folder path to serve. Takes precedence over `runsDir`. */
  runDir?: string;
  /** A single project's runs root under which to auto-discover the most-recent
   *  run (runs/<run>/) when `runDir` is omitted. */
  runsDir?: string;
  /** The top-level runs/ root under which to auto-discover the newest run
   *  ACROSS all projects (runs/<project>/<run>/). What the always-on dashboard
   *  points at so it follows whatever run is active. Used only when neither
   *  `runDir` nor `runsDir` is given. */
  runsRoot?: string;
  /** Port to bind. 0 (the default) asks the OS for an ephemeral port. */
  port?: number;
  /** Host to bind. Defaults to 127.0.0.1 — localhost only, never public. */
  host?: string;
}

/** A running server handle. `port` is the actually-bound port (resolved even
 *  when 0 was requested); `close()` stops listening and frees the port. */
export interface DashboardServer {
  /** The underlying Node http.Server, exposed for advanced lifecycle control. */
  server: Server;
  /** The concrete bound port (never 0 once listening). */
  port: number;
  /** The bound host. */
  host: string;
  /** Base URL, e.g. http://127.0.0.1:<port>, for convenience in tests. */
  url: string;
  /** Stop listening and release the port. Idempotent-safe to await once. */
  close: () => Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";

/** Resolve the current dashboard data for a request against the configured
 *  target. Never throws: the reader degrades (returns a `degraded` object)
 *  rather than raising on corrupt/missing input, and target resolution is
 *  guarded so a bad path yields a degraded payload instead of a 500. */
function currentData(opts: StartOptions): DashboardData {
  const nowMs = Date.now();
  try {
    // resolveAndAssemble uses the explicit runDir when given, else auto-discovers
    // the latest run under runsDir, else returns a degraded object — it never
    // throws, so /data can always answer 200.
    return resolveAndAssemble({ runDir: opts.runDir, runsDir: opts.runsDir, runsRoot: opts.runsRoot, nowMs });
  } catch {
    // Defensive: resolveAndAssemble is designed never to throw, but if a future
    // change regresses that, still respond rather than 500.
    return {
      runId: null,
      goal: null,
      oneLineGoal: null,
      repoName: null,
      currentSprint: null,
      currentSprintTitle: null,
      totalSprints: 0,
      sprintBreakdown: [],
      contractVersion: null,
      phase: null,
      status: null,
      haltReason: null,
      contractFreezeReason: null,
      budgetSpentUsd: null,
      runDir: null,
      startedAt: null,
      elapsedMs: null,
      scores: [],
      degraded: true,
      stale: true,
    };
  }
}

/** HTML-escape a value for safe interpolation into text/attribute contexts. */
function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render an absent value as an explicit placeholder rather than empty/error. */
function orDash(value: unknown): string {
  return value === null || value === undefined ? "—" : esc(value);
}

/** Milliseconds → a compact H:MM:SS-ish elapsed string; placeholder when null. */
function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}`;
}

/** Build the initial server-rendered HTML page. The page carries the fixture's
 *  current fields inline (so a plain GET / is populated even before the first
 *  poll) plus a small polling script that refreshes them from /data in place —
 *  no meta-refresh, no full-page navigation. */
/** Spend rounded to cents. Null → placeholder. */
function fmtSpend(v: number | null): string {
  return v === null || v === undefined ? "—" : `$${Number(v).toFixed(2)}`;
}

/** A finished run is one that reached a terminal status. While it's finished the
 *  "current sprint/step" framing is wrong — those became the FINAL sprint/step —
 *  and elapsed is a fixed duration, so labels flip accordingly. */
function isFinished(status: string | null): boolean {
  return status === "passed" || status === "halted";
}

/** The v2 phase pipeline names, in order, shown on the active sprint card. */
const PHASES = ["Negotiate", "Generate", "Evaluate", "Decide"] as const;

/** The coarse, monotonic run-strip stage labels. Deliberately three fixed
 *  stages (no per-sprint segments): only the fill/color advances. */
const STRIP_LABELS = ["Plan", "Generate", "Done"] as const;

/** The raw `haltReason` codes (src/budget/tracker.ts `StopReason` + the
 *  evaluator-parse-error fault) mapped to plain-language sentences. The five
 *  StopReason codes are graceful "Paused"; `evaluator-parse-error` is a
 *  "Stopped" fault. Wording is VERBATIM from the committed v2 prototype's
 *  HALT_REASONS map — this is the product surface, not a debug log. */
const HALT_ORDER = [
  "wall-clock",
  "max-iteration",
  "no-progress",
  "usage-limit",
  "dollar-ceiling",
  "evaluator-parse-error",
] as const;
const HALT_REASONS: Record<string, { label: string; text: string }> = {
  "wall-clock": {
    label: "Paused",
    text: "Reached the 30-minute limit for this sprint. Paused, not failed — the partial work is committed to the run branch.",
  },
  "max-iteration": {
    label: "Paused",
    text: "Used all its attempts on this sprint (6 tries) without clearing the score bar. Paused — partial work is saved.",
  },
  "no-progress": {
    label: "Paused",
    text: "The score stopped improving across several attempts, so it stopped rather than spin. Paused — partial work is saved.",
  },
  "usage-limit": {
    label: "Paused",
    text: "Hit your Claude subscription's usage limit. Paused — pick back up when the limit resets.",
  },
  "dollar-ceiling": {
    label: "Paused",
    text: "Reached the spending limit you set for this run. Paused — partial work is saved.",
  },
  "evaluator-parse-error": {
    label: "Stopped",
    text: "The grader returned an unreadable score, so the run stopped to be safe. This is a fault, not a normal pause.",
  },
};

/** A finished run has landed on a plan (has sprints). Stats tiles appear only
 *  once a plan exists; during planning there is no plan yet. */
function hasPlan(data: DashboardData): boolean {
  return data.totalSprints > 0;
}

/** The run is still planning when no plan has landed yet (no sprints) and it
 *  has not reached a terminal status. */
function isPlanning(data: DashboardData): boolean {
  return !hasPlan(data) && !isFinished(data.status);
}

/** The coarse run-strip configuration for the current run state: the three
 *  fixed stages' classes, a 0..1 progress fill, and the fill color. Monotonic —
 *  only advances. */
function stripConfig(data: DashboardData): { stages: string[]; progress: number; fill: string } {
  if (data.status === "passed") {
    return { stages: ["done", "done", "done"], progress: 1, fill: "var(--good)" };
  }
  if (data.status === "halted") {
    return { stages: ["done", "stopped", "paused"], progress: 1, fill: "var(--warn)" };
  }
  if (isPlanning(data)) {
    return { stages: ["current", "pending", "pending"], progress: 0, fill: "var(--accent)" };
  }
  // Live/running with a plan: Plan done, Generate in progress.
  return { stages: ["done", "current", "pending"], progress: 0.5, fill: "var(--accent)" };
}

/** The status shown in the header pill: falls back to "planning" when a live
 *  run has no plan yet, else the real status. */
function statusLabel(data: DashboardData): string {
  if (data.status) return data.status;
  return isPlanning(data) ? "planning" : "running";
}

/** ✓ for done, ❚❚ for paused, empty otherwise — the run-strip node glyph. */
function stageGlyph(cls: string): string {
  return cls === "done" ? "✓" : cls === "paused" ? "❚❚" : "";
}

/** The run-strip markup: three fixed stages, colored by outcome. */
function renderStrip(data: DashboardData): string {
  const cfg = stripConfig(data);
  const stages = cfg.stages
    .map(
      (cls, i) =>
        `<div class="stage ${cls}"><span class="stage-node">${stageGlyph(cls)}</span>` +
        `<span class="stage-label">${STRIP_LABELS[i]}</span></div>`,
    )
    .join("");
  return (
    `<div class="run-strip" id="runStrip" style="--progress:${cfg.progress};--fill:${cfg.fill}">` +
    `${stages}</div>`
  );
}

/** The goal-first header: repo name, then run ID, then the status pill. */
function renderHeader(data: DashboardData): string {
  const status = statusLabel(data);
  return (
    `<header class="run-head"><div class="context-strip">` +
    `<span class="repo" id="repo">${orDash(data.repoName)}</span>` +
    `<span class="run-id-tag"><span class="id-key">Run ID:</span>` +
    `<span id="runId">${orDash(data.runId)}</span></span>` +
    `<span class="pill ${esc(status)}" id="statusPill">${esc(status)}</span>` +
    `</div></header>`
  );
}

/** The goal area: the one-line goal shown prominently while planning, else a
 *  small "View goal" link. Both link to the reachable full-goal view. */
function renderGoalArea(data: DashboardData): string {
  const oneLine = data.oneLineGoal;
  if (isPlanning(data)) {
    return (
      `<div class="goal-area" id="goalArea">` +
      `<div class="goal-eyebrow">Goal</div>` +
      `<p class="goal-line" id="goalLine">${orDash(oneLine)}</p>` +
      `<a class="goal-link" id="viewGoal" href="/goal">View full goal ↗</a>` +
      `</div>`
    );
  }
  return (
    `<div class="goal-area" id="goalArea">` +
    `<a class="goal-link small" id="viewGoal" href="/goal">View goal ↗</a>` +
    `</div>`
  );
}

/** A single stats tile. */
function tile(label: string, valueHTML: string, id: string): string {
  return `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value" id="${id}">${valueHTML}</div></div>`;
}

/** The stats tiles (Sprint X/N, Elapsed→Duration, Spend) — present only once a
 *  plan exists, absent entirely during planning. */
function renderStats(data: DashboardData): string {
  if (!hasPlan(data)) return `<div class="stats" id="stats"></div>`;
  const finished = isFinished(data.status);
  const durLabel = finished ? "Duration" : "Elapsed";
  const sprintNum = data.currentSprint === null ? "—" : data.currentSprint + 1;
  const sprintValue = `${esc(sprintNum)}<span class="sub"> / ${esc(data.totalSprints)}</span>`;
  const tiles = [
    tile("Sprint", sprintValue, "tileSprint"),
    tile(durLabel, esc(formatElapsed(data.elapsedMs)), "tileDuration"),
    tile("Spend", fmtSpend(data.budgetSpentUsd), "tileSpend"),
  ].join("");
  return `<div class="stats" id="stats" style="grid-template-columns:repeat(3,1fr)">${tiles}</div>`;
}

/** The plain-language halt banner, shown only on a halted run. Maps the raw
 *  haltReason code to its committed sentence; an unknown code degrades to the
 *  raw code text rather than throwing. */
function renderHaltNote(data: DashboardData): string {
  if (data.status !== "halted") return `<div class="callout halt-note" id="haltNote" hidden></div>`;
  const key = data.haltReason ?? "";
  const r = HALT_REASONS[key];
  const label = r ? r.label : "Paused";
  const text = r ? r.text : `The run paused (${key || "unknown reason"}).`;
  return (
    `<div class="callout halt-note" id="haltNote">` +
    `<b id="haltLabel">${esc(label)}</b><span id="haltText">${esc(text)}</span></div>`
  );
}

/** The Negotiate → Generate → Evaluate → Decide phase pipeline for the active
 *  (running/halted) sprint. */
function renderPipe(s: SprintSummary): string {
  const active = s.activePhase ?? 0;
  const stopped = s.state === "halted";
  const parts = PHASES.map((name, i) => {
    const cls = i < active ? "done" : i === active ? (stopped ? "stopped" : "active") : "";
    return `<span class="phase ${cls}"><span class="dot"></span>${name}${i < active ? " ✓" : ""}</span>`;
  });
  return `<div class="pipe">${parts.join('<span class="arrow">→</span>')}</div>`;
}

/** Pluralize a count with its word ("1 file edit", "5 file edits"). */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The quiet per-sprint metrics sub-line, reading exactly:
 *  "<N> negotiation rounds · <N> build attempts · <N> file edits · $<cost>". */
function renderMetrics(s: SprintSummary): string {
  const bits: string[] = [];
  if (s.rounds !== null) bits.push(plural(s.rounds, "negotiation round"));
  if (s.attempts !== null) bits.push(plural(s.attempts, "build attempt"));
  if (s.edits !== null) bits.push(plural(s.edits, "file edit"));
  if (s.cost !== null) bits.push(`$${s.cost.toFixed(2)}`);
  if (bits.length === 0) return "";
  return `<div class="step-metrics">${esc(bits.join(" · "))}</div>`;
}

/** A score chip, colored good/warn by threshold. */
function scoreChip(score: number): string {
  return `<span class="score ${score >= 85 ? "good" : "warn"}">${esc(score)}</span>`;
}

/** One sprint card: title + score (score when done, "best N" when halted), the
 *  phase pipeline on the active sprint, and the metrics sub-line. The plan-time
 *  description is intentionally NOT rendered — it is a dense technical contract,
 *  not human-readable; the concise title carries the meaning. (A plain-language
 *  per-sprint summary is a separate upstream task.) Mirrored by the client-side
 *  builder so a poll rebuilds it. */
function renderSprintItem(s: SprintSummary): string {
  const n = s.index;
  const node = s.state === "done" ? "✓" : s.state === "halted" ? "❚❚" : String(n + 1);
  let headRight = "";
  if (s.state === "done" && s.score !== null) {
    headRight = `<span class="step-meta">${scoreChip(s.score)}</span>`;
  } else if (s.state === "halted" && s.score !== null) {
    headRight = `<span class="step-meta">best ${scoreChip(s.score)}</span>`;
  }
  const pipe = s.state === "running" || s.state === "halted" ? renderPipe(s) : "";
  return (
    `<div class="step ${s.state}"><div class="node">${node}</div><div class="step-body">` +
    `<div class="step-head"><span class="step-title">${orDash(s.title)}</span>${headRight}</div>` +
    `${pipe}${renderMetrics(s)}</div></div>`
  );
}

/** The sprints section: a planning placeholder while the plan is being built,
 *  else one card per sprint. */
function renderSprints(data: DashboardData): string {
  if (isPlanning(data)) {
    return (
      `<section class="steps" id="steps">` +
      `<div class="planning-card"><span class="spin"></span>` +
      `Breaking the goal into sprints… the plan appears here once the planner finishes.</div>` +
      `</section>`
    );
  }
  const cards =
    data.sprintBreakdown.length === 0
      ? ""
      : data.sprintBreakdown.map(renderSprintItem).join("");
  return `<section class="steps" id="steps">${cards}</section>`;
}

/** A minimal, stdlib-only markdown renderer for the full-goal view. Handles
 *  the small subset a goal doc uses — "#"/"##" headings, "-"/"*" bullet lists,
 *  and paragraphs — with everything HTML-escaped first so it is injection-safe.
 *  No markdown library is added. */
function renderGoalMarkdown(goal: string | null): string {
  if (goal === null || goal === undefined || goal.trim() === "") {
    return `<p class="lead">—</p>`;
  }
  const lines = goal.split("\n");
  const out: string[] = [];
  let inList = false;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${esc(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  let i = 0;
  // Skip a leading YAML frontmatter block.
  if (lines[i]?.trim() === "---") {
    i++;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    if (i < lines.length) i++;
  }
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const level = Math.min(h[1].length, 2) + 1; // # → h1-ish, ## → h2
      out.push(`<h${level}>${esc(h[2])}</h${level}>`);
      continue;
    }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) {
      flushPara();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${esc(b[1])}</li>`);
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("\n");
}

/** The full-goal page: a back link and the complete state.goal rendered as
 *  formatted markdown (never a raw monospace dump). */
function renderGoalPage(data: DashboardData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dev-harness dashboard — goal${data.runId ? " — " + esc(data.runId) : ""}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f8fb; --surface:#fff; --text:#16202c; --muted:#5b6675; --faint:#93a0b0; --accent:#2f6bff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1216; --surface:#171b21; --text:#e7ecf3; --muted:#96a1b1; --faint:#6a7686; --accent:#5c92ff; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.55; -webkit-text-size-adjust:100%; }
  .wrap { max-width: 44rem; margin: 0 auto; padding: clamp(1.4rem,4vw,2.25rem) clamp(1rem,4vw,1.75rem) 4rem; }
  .back-link { font-family: ui-monospace, Menlo, monospace; font-size:.8rem; color:var(--accent); text-decoration:none; display:inline-block; margin-bottom:1.75rem; }
  .back-link:hover { text-decoration: underline; }
  .goal-doc h1 { font-size:1.5rem; letter-spacing:-.02em; margin:0 0 .5rem; }
  .goal-doc h2 { font-family: ui-monospace, Menlo, monospace; font-size:.8rem; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); margin:1.9rem 0 .7rem; }
  .goal-doc .lead { font-size:1.05rem; margin:0 0 1.75rem; }
  .goal-doc p { margin:0 0 1rem; max-width:60ch; }
  .goal-doc ul { margin:0 0 1rem; padding-left:1.2rem; }
  .goal-doc li { margin:.35rem 0; max-width:58ch; }
</style>
</head>
<body>
<main class="wrap goal-page">
<a class="back-link" href="/">← Back to run</a>
<div class="goal-doc" id="goalDoc">${renderGoalMarkdown(data.goal)}</div>
</main>
</body>
</html>`;
}

function renderPage(data: DashboardData): string {
  const updating = data.stale
    ? `<span id="degraded" class="updating">(updating…)</span>`
    : `<span id="degraded" class="updating" hidden></span>`;
  // The HALT_REASONS map is shared with the client so a live poll re-renders the
  // same plain-language banner without a page reload. It is emitted as JSON.
  const haltJson = JSON.stringify(HALT_REASONS);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dev-harness dashboard${data.runId ? " — " + esc(data.runId) : ""}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#f6f8fb; --surface:#fff; --surface-2:#eef1f6; --border:#dde3ec; --border-strong:#c6d0dd;
    --text:#16202c; --muted:#5b6675; --faint:#93a0b0; --accent:#2f6bff; --accent-soft:#e4ecff;
    --good:#1f9d63; --good-soft:#dff3e8; --warn:#c67f16; --warn-soft:#f7ecd4; --spine:#d4dbe6;
    --shadow:0 1px 2px rgba(20,32,48,.06),0 6px 20px rgba(20,32,48,.05); --radius:12px;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0f1216; --surface:#171b21; --surface-2:#1e242c; --border:#262d37; --border-strong:#333c48;
      --text:#e7ecf3; --muted:#96a1b1; --faint:#6a7686; --accent:#5c92ff; --accent-soft:#17233d;
      --good:#46c288; --good-soft:#12271d; --warn:#e0a13a; --warn-soft:#2a2113; --spine:#2c343f;
      --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.28);
    }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:var(--sans); line-height:1.55; -webkit-text-size-adjust:100%; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:40rem; margin:0 auto; padding: clamp(1.4rem,4vw,2.25rem) clamp(1rem,4vw,1.75rem) 4rem; }
  .run-head { margin-bottom:1.3rem; }
  .context-strip { display:flex; align-items:center; gap:.65rem; flex-wrap:wrap; }
  .repo { font-family:var(--mono); font-size:.9rem; font-weight:600; color:var(--text); }
  .run-id-tag { font-family:var(--mono); font-size:.74rem; color:var(--muted); background:var(--surface-2); border:1px solid var(--border); border-radius:6px; padding:.12rem .5rem; }
  .id-key { color:var(--faint); text-transform:uppercase; letter-spacing:.06em; font-size:.63rem; margin-right:.32rem; }
  .context-strip .pill { margin-left:auto; }
  .pill { font-family:var(--mono); font-size:.72rem; font-weight:600; letter-spacing:.03em; text-transform:uppercase; padding:.2rem .6rem; border-radius:999px; display:inline-flex; align-items:center; gap:.4rem; }
  .pill::before { content:""; width:7px; height:7px; border-radius:50%; background:currentColor; }
  .pill.passed { color:var(--good); background:var(--good-soft); }
  .pill.running { color:var(--accent); background:var(--accent-soft); }
  .pill.halted { color:var(--warn); background:var(--warn-soft); }
  .pill.planning { color:var(--muted); background:var(--surface-2); }
  .updating { font-family:var(--mono); font-size:.7rem; color:var(--warn); margin-left:.4rem; }
  .run-strip { position:relative; display:flex; width:100%; margin:0 0 1.7rem; }
  .run-strip::before, .run-strip::after { content:""; position:absolute; top:13px; height:2px; border-radius:2px; }
  .run-strip::before { left:16.667%; right:16.667%; background:var(--spine); }
  .run-strip::after { left:16.667%; width:calc(66.666% * var(--progress,0)); background:var(--fill,var(--accent)); transition:width .3s ease; }
  .stage { flex:1; display:flex; flex-direction:column; align-items:center; gap:.6rem; position:relative; z-index:1; }
  .stage-node { width:26px; height:26px; border-radius:50%; display:grid; place-items:center; font-size:.72rem; background:var(--surface); border:2px solid var(--border-strong); color:var(--muted); }
  .stage.done .stage-node { background:var(--good); border-color:var(--good); color:#fff; }
  .stage.current .stage-node { background:var(--accent); border-color:var(--accent); color:#fff; box-shadow:0 0 0 5px var(--accent-soft); }
  .stage.stopped .stage-node, .stage.paused .stage-node { background:var(--warn); border-color:var(--warn); color:#fff; }
  .stage-label { font-family:var(--mono); font-size:.74rem; letter-spacing:.05em; text-transform:uppercase; color:var(--muted); }
  .stage.current .stage-label { color:var(--accent); font-weight:600; }
  .stage.done .stage-label { color:var(--text); }
  .stage.paused .stage-label { color:var(--warn); font-weight:600; }
  .goal-area { margin:0 0 1.7rem; }
  .goal-eyebrow { font-family:var(--mono); font-size:.66rem; letter-spacing:.13em; text-transform:uppercase; color:var(--faint); margin-bottom:.45rem; }
  .goal-line { font-family:var(--sans); font-size:1.3rem; font-weight:650; line-height:1.32; letter-spacing:-.012em; margin:0 0 .7rem; text-wrap:pretty; }
  .goal-link { font-family:var(--sans); font-size:.88rem; color:var(--accent); text-decoration:none; display:inline-flex; align-items:center; gap:.2rem; }
  .goal-link:hover { text-decoration:underline; }
  .goal-link.small { font-size:.8rem; color:var(--muted); }
  .stats { display:grid; gap:.75rem; margin-bottom:1.9rem; }
  .stats:empty { display:none; }
  .tile { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:.9rem 1rem; box-shadow:var(--shadow); }
  .tile-label { font-family:var(--mono); font-size:.64rem; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); margin-bottom:.4rem; }
  .tile-value { font-family:var(--mono); font-size:1.2rem; font-weight:600; font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
  .tile-value .sub { color:var(--faint); font-weight:400; }
  .callout { display:flex; gap:.6rem; align-items:flex-start; border-radius:10px; padding:.8rem .9rem; font-size:.88rem; color:var(--text); margin-bottom:1.6rem; }
  .callout[hidden] { display:none; }
  .halt-note { background:var(--warn-soft); border:1px solid var(--warn); }
  .halt-note b { color:var(--warn); font-family:var(--mono); font-weight:600; }
  .steps-title { font-family:var(--mono); font-size:.72rem; letter-spacing:.12em; text-transform:uppercase; color:var(--faint); margin:0 0 1rem; }
  .steps { position:relative; }
  .step { position:relative; display:grid; grid-template-columns:32px 1fr; gap:1rem; }
  .step::before { content:""; position:absolute; left:15px; top:30px; bottom:-.2rem; width:2px; background:var(--spine); }
  .step:last-child::before { display:none; }
  .step.done::before { background:var(--good); }
  .node { width:32px; height:32px; border-radius:50%; display:grid; place-items:center; font-family:var(--mono); font-size:.82rem; font-weight:600; position:relative; z-index:1; background:var(--surface); border:2px solid var(--border-strong); color:var(--muted); font-variant-numeric:tabular-nums; }
  .step.done .node { background:var(--good); border-color:var(--good); color:#fff; }
  .step.running .node { background:var(--accent); border-color:var(--accent); color:#fff; box-shadow:0 0 0 4px var(--accent-soft); }
  .step.halted .node { background:var(--warn); border-color:var(--warn); color:#fff; }
  .step-body { padding-bottom:1.7rem; min-width:0; }
  .step-head { display:flex; align-items:baseline; gap:.6rem; flex-wrap:wrap; }
  .step-title { font-weight:600; font-size:1rem; letter-spacing:-.01em; }
  .step.pending .step-title { color:var(--muted); }
  .step-meta { margin-left:auto; font-family:var(--mono); font-size:.8rem; color:var(--muted); white-space:nowrap; font-variant-numeric:tabular-nums; }
  .score { font-weight:600; padding:.05rem .34rem; border-radius:5px; }
  .score.good { color:var(--good); background:var(--good-soft); }
  .score.warn { color:var(--warn); background:var(--warn-soft); }
  .step-metrics { margin-top:.65rem; font-family:var(--mono); font-size:.74rem; color:var(--muted); font-variant-numeric:tabular-nums; line-height:1.5; }
  .pipe { margin-top:.9rem; display:flex; align-items:center; gap:.35rem; flex-wrap:wrap; background:var(--surface-2); border:1px solid var(--border); border-radius:10px; padding:.65rem .7rem; }
  .phase { display:flex; align-items:center; gap:.32rem; font-family:var(--mono); font-size:.74rem; color:var(--faint); }
  .phase .dot { width:8px; height:8px; border-radius:50%; background:var(--border-strong); flex:none; }
  .phase.done { color:var(--muted); } .phase.done .dot { background:var(--good); }
  .phase.active { color:var(--accent); font-weight:600; } .phase.active .dot { background:var(--accent); }
  .phase.stopped { color:var(--warn); font-weight:600; } .phase.stopped .dot { background:var(--warn); }
  .pipe .arrow { color:var(--faint); font-size:.7rem; }
  .planning-card { display:flex; align-items:center; gap:.8rem; background:var(--surface); border:1px dashed var(--border-strong); border-radius:var(--radius); padding:1.25rem; color:var(--muted); font-size:.92rem; }
  .spin { width:17px; height:17px; border-radius:50%; border:2px solid var(--border-strong); border-top-color:var(--accent); animation:spin .8s linear infinite; flex:none; }
  @keyframes spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; } }
</style>
</head>
<body>
<main class="wrap" id="mainView">
  <div id="header">${renderHeader(data)}</div>
  <div id="strip">${renderStrip(data)}</div>
  <div id="goal">${renderGoalArea(data)}</div>
  <div id="statsWrap">${renderStats(data)}</div>
  <div id="haltWrap">${renderHaltNote(data)}</div>
  <div class="steps-title">Sprints ${updating}</div>
  <div id="sprintsWrap">${renderSprints(data)}</div>
</main>
<script>
(function () {
  var HALT_REASONS = ${haltJson};
  var PHASES = ["Negotiate", "Generate", "Evaluate", "Decide"];
  var STRIP_LABELS = ["Plan", "Generate", "Done"];

  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }
  function dash(v) { return (v === null || v === undefined) ? "—" : esc(v); }
  function fmtElapsed(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return "—";
    var total = Math.max(0, Math.floor(ms / 1000));
    var s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return h + ":" + pad(m) + ":" + pad(s);
  }
  function fmtSpend(v) { return (v === null || v === undefined) ? "—" : "$" + Number(v).toFixed(2); }
  function finished(status) { return status === "passed" || status === "halted"; }
  function hasPlan(d) { return d.totalSprints > 0; }
  function isPlanning(d) { return !hasPlan(d) && !finished(d.status); }
  function statusLabel(d) { return d.status ? d.status : (isPlanning(d) ? "planning" : "running"); }
  function byId(id) { return document.getElementById(id); }
  function setHTML(id, html) { var e = byId(id); if (e) e.innerHTML = html; }

  function stripConfig(d) {
    if (d.status === "passed") return { stages:["done","done","done"], progress:1, fill:"var(--good)" };
    if (d.status === "halted") return { stages:["done","stopped","paused"], progress:1, fill:"var(--warn)" };
    if (isPlanning(d)) return { stages:["current","pending","pending"], progress:0, fill:"var(--accent)" };
    return { stages:["done","current","pending"], progress:.5, fill:"var(--accent)" };
  }
  function stageGlyph(cls) { return cls === "done" ? "✓" : (cls === "paused" ? "❚❚" : ""); }
  function stripHTML(d) {
    var cfg = stripConfig(d);
    var stages = cfg.stages.map(function (cls, i) {
      return '<div class="stage ' + cls + '"><span class="stage-node">' + stageGlyph(cls) + '</span><span class="stage-label">' + STRIP_LABELS[i] + '</span></div>';
    }).join("");
    return '<div class="run-strip" id="runStrip" style="--progress:' + cfg.progress + ';--fill:' + cfg.fill + '">' + stages + '</div>';
  }
  function headerHTML(d) {
    var status = statusLabel(d);
    return '<header class="run-head"><div class="context-strip">' +
      '<span class="repo" id="repo">' + dash(d.repoName) + '</span>' +
      '<span class="run-id-tag"><span class="id-key">Run ID:</span><span id="runId">' + dash(d.runId) + '</span></span>' +
      '<span class="pill ' + esc(status) + '" id="statusPill">' + esc(status) + '</span></div></header>';
  }
  function goalHTML(d) {
    if (isPlanning(d)) {
      return '<div class="goal-area" id="goalArea"><div class="goal-eyebrow">Goal</div>' +
        '<p class="goal-line" id="goalLine">' + dash(d.oneLineGoal) + '</p>' +
        '<a class="goal-link" id="viewGoal" href="/goal">View full goal ↗</a></div>';
    }
    return '<div class="goal-area" id="goalArea"><a class="goal-link small" id="viewGoal" href="/goal">View goal ↗</a></div>';
  }
  function tile(label, valueHTML, id) {
    return '<div class="tile"><div class="tile-label">' + label + '</div><div class="tile-value" id="' + id + '">' + valueHTML + '</div></div>';
  }
  function statsHTML(d) {
    if (!hasPlan(d)) return '<div class="stats" id="stats"></div>';
    var durLabel = finished(d.status) ? "Duration" : "Elapsed";
    var sprintNum = d.currentSprint === null ? "—" : d.currentSprint + 1;
    var sprintValue = esc(sprintNum) + '<span class="sub"> / ' + esc(d.totalSprints) + '</span>';
    var tiles = tile("Sprint", sprintValue, "tileSprint") +
      tile(durLabel, esc(fmtElapsed(d.elapsedMs)), "tileDuration") +
      tile("Spend", fmtSpend(d.budgetSpentUsd), "tileSpend");
    return '<div class="stats" id="stats" style="grid-template-columns:repeat(3,1fr)">' + tiles + '</div>';
  }
  function haltHTML(d) {
    if (d.status !== "halted") return '<div class="callout halt-note" id="haltNote" hidden></div>';
    var key = d.haltReason || "";
    var r = HALT_REASONS[key];
    var label = r ? r.label : "Paused";
    var text = r ? r.text : ('The run paused (' + (key || "unknown reason") + ').');
    return '<div class="callout halt-note" id="haltNote"><b id="haltLabel">' + esc(label) + '</b><span id="haltText">' + esc(text) + '</span></div>';
  }
  function pipeHTML(s) {
    var active = s.activePhase == null ? 0 : s.activePhase;
    var stopped = s.state === "halted";
    var parts = PHASES.map(function (name, i) {
      var cls = i < active ? "done" : (i === active ? (stopped ? "stopped" : "active") : "");
      return '<span class="phase ' + cls + '"><span class="dot"></span>' + name + (i < active ? " ✓" : "") + '</span>';
    });
    return '<div class="pipe">' + parts.join('<span class="arrow">→</span>') + '</div>';
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function metricsHTML(s) {
    var bits = [];
    if (s.rounds !== null && s.rounds !== undefined) bits.push(plural(s.rounds, "negotiation round"));
    if (s.attempts !== null && s.attempts !== undefined) bits.push(plural(s.attempts, "build attempt"));
    if (s.edits !== null && s.edits !== undefined) bits.push(plural(s.edits, "file edit"));
    if (s.cost !== null && s.cost !== undefined) bits.push("$" + Number(s.cost).toFixed(2));
    if (!bits.length) return "";
    return '<div class="step-metrics">' + esc(bits.join(" · ")) + '</div>';
  }
  function scoreChip(score) { return '<span class="score ' + (score >= 85 ? "good" : "warn") + '">' + esc(score) + '</span>'; }
  function stepHTML(s) {
    var node = s.state === "done" ? "✓" : (s.state === "halted" ? "❚❚" : String(s.index + 1));
    var headRight = "";
    if (s.state === "done" && s.score !== null && s.score !== undefined) headRight = '<span class="step-meta">' + scoreChip(s.score) + '</span>';
    else if (s.state === "halted" && s.score !== null && s.score !== undefined) headRight = '<span class="step-meta">best ' + scoreChip(s.score) + '</span>';
    var pipe = (s.state === "running" || s.state === "halted") ? pipeHTML(s) : "";
    return '<div class="step ' + s.state + '"><div class="node">' + node + '</div><div class="step-body">' +
      '<div class="step-head"><span class="step-title">' + dash(s.title) + '</span>' + headRight + '</div>' +
      pipe + metricsHTML(s) + '</div></div>';
  }
  function sprintsHTML(d) {
    if (isPlanning(d)) {
      return '<section class="steps" id="steps"><div class="planning-card"><span class="spin"></span>' +
        'Breaking the goal into sprints… the plan appears here once the planner finishes.</div></section>';
    }
    var cards = (d.sprintBreakdown || []).map(stepHTML).join("");
    return '<section class="steps" id="steps">' + cards + '</section>';
  }
  function apply(d) {
    setHTML("header", headerHTML(d));
    setHTML("strip", stripHTML(d));
    setHTML("goal", goalHTML(d));
    setHTML("statsWrap", statsHTML(d));
    setHTML("haltWrap", haltHTML(d));
    setHTML("sprintsWrap", sprintsHTML(d));
    var deg = byId("degraded");
    if (deg) { deg.hidden = !d.stale; deg.textContent = d.stale ? "(updating…)" : ""; }
  }
  function poll() {
    fetch("/data", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(apply)
      .catch(function () { /* keep last-known-good; try again next tick */ });
  }
  setInterval(poll, 2000);
  poll();
})();
</script>
</body>
</html>`;
}

/** Route + serve a single request. Kept synchronous and total: every branch
 *  writes a response, unmapped routes get a deterministic 404, and /data is
 *  wrapped so it always answers 200 with JSON (never 500) even if data assembly
 *  degrades. */
function handle(req: IncomingMessage, res: ServerResponse, opts: StartOptions): void {
  // Only GET is served; the dashboard is strictly read-only.
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  if (method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  if (path === "/") {
    const html = renderPage(currentData(opts));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (path === "/goal") {
    // The reachable full-goal view: the complete state.goal rendered as
    // formatted markdown. Read-only like every other route.
    const html = renderGoalPage(currentData(opts));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (path === "/data") {
    let body: string;
    try {
      body = JSON.stringify(currentData(opts));
    } catch {
      // Extremely defensive: even JSON.stringify shouldn't fail on our plain
      // object, but never let /data 500.
      body = '{"degraded":true,"stale":true,"scores":[]}';
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
}

/**
 * Start the read-only dashboard HTTP server.
 *
 * Import-safe by construction: this function is the ONLY thing that binds a
 * port. Importing this module creates no server and starts no listener — tests
 * (and callers) control lifecycle entirely through start()/close().
 *
 * The server serves exactly two routes over localhost:
 *   - GET /      → a 200 HTML page rendering the current run's mapped fields,
 *                  with a client-side polling script that refreshes /data.
 *   - GET /data  → a 200 JSON payload assembled from state.json + trace.jsonl,
 *                  with elapsed computed against the server's current time.
 *
 * /data never 500s: the underlying reader degrades gracefully on corrupt,
 * mid-write, or missing-field run folders, and this layer guards further.
 */
export function start(opts: StartOptions = {}): Promise<DashboardServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const port = opts.port ?? 0;
  const server = createServer((req, res) => handle(req, res, opts));

  return new Promise<DashboardServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const addr = server.address() as AddressInfo | null;
      const boundPort = addr && typeof addr === "object" ? addr.port : port;
      const boundHost = addr && typeof addr === "object" && addr.address ? addr.address : host;
      resolve({
        server,
        port: boundPort,
        host: boundHost,
        url: `http://${host}:${boundPort}`,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/**
 * Resolve {@link StartOptions} target selection from a raw argv-style token
 * list (the args AFTER the node/script pair). Pure and side-effect free — it
 * reads no files and binds no port — so it is unit-testable and import-safe.
 *
 * Selection rules (mirrors the sprint contract):
 *   - An explicit run-folder path (first positional arg, or `--run-dir <path>`)
 *     wins: it is returned as `runDir`.
 *   - Otherwise, a `--runs-dir <path>` (or the default `runs/`) is returned as
 *     `runsDir`, so {@link start} auto-discovers the most-recently-modified run
 *     under it via {@link findLatestRunDir}.
 *   - An optional `--port <n>` / `--host <h>` are parsed when present.
 *
 * This does NOT touch the filesystem: discovery happens lazily inside start()
 * per request, keeping this helper trivially testable.
 */
export function resolveTargetFromArgs(args: readonly string[]): StartOptions {
  const opts: StartOptions = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--run-dir" || a === "--runDir") {
      opts.runDir = args[++i];
    } else if (a === "--runs-dir" || a === "--runsDir") {
      opts.runsDir = args[++i];
    } else if (a === "--runs-root" || a === "--runsRoot") {
      opts.runsRoot = args[++i];
    } else if (a === "--port") {
      const n = Number(args[++i]);
      if (Number.isFinite(n)) opts.port = n;
    } else if (a === "--host") {
      opts.host = args[++i];
    } else if (a.startsWith("--")) {
      // Unknown flag with no value semantics — ignore rather than crash.
    } else {
      positionals.push(a);
    }
  }
  // A bare positional path is treated as the explicit run dir (unless --run-dir
  // already set one).
  if (opts.runDir === undefined && positionals.length > 0) {
    opts.runDir = positionals[0];
  }
  // Default when nothing explicit was given: auto-discover the newest run
  // ACROSS all projects under runs/ (the real layout is runs/<project>/<run>/,
  // so a single-level runsDir would wrongly land on a project folder). Discovery
  // tolerates an absent dir, degrading gracefully.
  if (
    opts.runDir === undefined &&
    opts.runsDir === undefined &&
    opts.runsRoot === undefined
  ) {
    opts.runsRoot = "runs";
  }
  return opts;
}

/**
 * CLI entrypoint: parse argv, start the server, print the bound URL. Kept as an
 * exported function (never auto-invoked at import) so importing this module has
 * no side effect — the guarded call below only fires when the file is run as the
 * process entrypoint, which never happens under the test runner's import.
 */
export async function main(rawArgv: readonly string[] = argv.slice(2)): Promise<DashboardServer> {
  const opts = resolveTargetFromArgs(rawArgv);
  const s = await start(opts);
  // A tiny operator hint; harmless if stdout is not a TTY.
  process.stdout.write(`dev-harness dashboard listening on ${s.url}\n`);
  return s;
}

// Direct-invocation guard: only run main() when this module is the actual
// process entrypoint (e.g. `tsx src/dashboard/server.ts` or `node .../server.js`).
// Under vitest/import the guard is false, so no server starts and no port binds.
const invokedPath = argv[1] ?? "";
const isEntry =
  invokedPath.endsWith("dashboard/server.ts") ||
  invokedPath.endsWith("dashboard/server.js");
if (isEntry && env.VITEST === undefined) {
  void main();
}
