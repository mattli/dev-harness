import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { argv, env } from "node:process";
import { resolveAndAssemble, findLatestRunDir, type DashboardData } from "./reader.js";

/** Options for {@link start}. Either an explicit `runDir` (what tests always
 *  pass) or a `runsDir` to auto-discover the latest run under; `port` defaults
 *  to 0 (an OS-assigned ephemeral port) so tests fully control lifecycle. */
export interface StartOptions {
  /** Explicit run-folder path to serve. Takes precedence over `runsDir`. */
  runDir?: string;
  /** Root under which to auto-discover the most-recent run when `runDir` is
   *  omitted. */
  runsDir?: string;
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
    return resolveAndAssemble({ runDir: opts.runDir, runsDir: opts.runsDir, nowMs });
  } catch {
    // Defensive: resolveAndAssemble is designed never to throw, but if a future
    // change regresses that, still respond rather than 500.
    return {
      runId: null,
      goal: null,
      currentSprint: null,
      currentSprintTitle: null,
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
function renderPage(data: DashboardData): string {
  const scoresText =
    data.scores.length === 0
      ? "—"
      : data.scores
          .map((s) => (s.sprint === null ? `#? = ${s.score}` : `#${s.sprint} = ${s.score}`))
          .join(", ");
  const spend = data.budgetSpentUsd === null ? "—" : `$${esc(data.budgetSpentUsd)}`;
  const sprintLine =
    data.currentSprint === null
      ? "—"
      : `#${esc(data.currentSprint)} ${orDash(data.currentSprintTitle)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>dev-harness dashboard${data.runId ? " — " + esc(data.runId) : ""}</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem; line-height: 1.5; }
  h1 { font-size: 1.2rem; }
  .field { margin: 0.25rem 0; }
  .label { color: #666; display: inline-block; min-width: 11rem; }
  pre.goal { white-space: pre-wrap; background: #f5f5f5; padding: 0.75rem; border-radius: 4px; }
  .degraded { color: #b00; }
</style>
</head>
<body>
<h1>dev-harness live run <span id="runId">${orDash(data.runId)}</span></h1>
<div class="field"><span class="label">Status</span><span id="status">${orDash(data.status)}</span>
  <span id="degraded" class="degraded">${data.stale ? "(updating…)" : ""}</span></div>
<div class="field"><span class="label">Current sprint</span><span id="currentSprint">${sprintLine}</span></div>
<div class="field"><span class="label">Current round</span><span id="contractVersion">${orDash(data.contractVersion)}</span></div>
<div class="field"><span class="label">Current step</span><span id="phase">${orDash(data.phase)}</span></div>
<div class="field"><span class="label">Per-sprint scores</span><span id="scores">${esc(scoresText)}</span></div>
<div class="field"><span class="label">Elapsed</span><span id="elapsed">${esc(formatElapsed(data.elapsedMs))}</span></div>
<div class="field"><span class="label">Spend</span><span id="spend">${spend}</span></div>
<div class="field"><span class="label">Halt reason</span><span id="haltReason">${orDash(data.haltReason)}</span></div>
<div class="field"><span class="label">Freeze reason</span><span id="contractFreezeReason">${orDash(data.contractFreezeReason)}</span></div>
<h2>Goal</h2>
<pre class="goal" id="goal">${orDash(data.goal)}</pre>
<script>
(function () {
  function fmtElapsed(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return "—";
    var total = Math.max(0, Math.floor(ms / 1000));
    var s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
    var pad = function (n) { return String(n).padStart(2, "0"); };
    return h + ":" + pad(m) + ":" + pad(s);
  }
  function dash(v) { return (v === null || v === undefined) ? "—" : String(v); }
  function set(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
  function apply(d) {
    set("runId", dash(d.runId));
    set("status", dash(d.status));
    set("degraded", d.stale ? "(updating…)" : "");
    set("currentSprint", d.currentSprint === null ? "—" : "#" + d.currentSprint + " " + dash(d.currentSprintTitle));
    set("contractVersion", dash(d.contractVersion));
    set("phase", dash(d.phase));
    set("scores", (d.scores && d.scores.length)
      ? d.scores.map(function (s) { return (s.sprint === null ? "#?" : "#" + s.sprint) + " = " + s.score; }).join(", ")
      : "—");
    set("elapsed", fmtElapsed(d.elapsedMs));
    set("spend", d.budgetSpentUsd === null || d.budgetSpentUsd === undefined ? "—" : "$" + d.budgetSpentUsd);
    set("haltReason", dash(d.haltReason));
    set("contractFreezeReason", dash(d.contractFreezeReason));
    set("goal", dash(d.goal));
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
  // Default target root when nothing explicit was given: auto-discover under
  // runs/ (findLatestRunDir tolerates an absent dir, degrading gracefully).
  if (opts.runDir === undefined && opts.runsDir === undefined) {
    opts.runsDir = "runs";
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
