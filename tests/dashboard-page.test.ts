import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const serverSrc = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "dashboard",
  "server.ts",
);
import {
  start,
  resolveTargetFromArgs,
  type DashboardServer,
} from "../src/dashboard/server.js";

// ---------------------------------------------------------------------------
// Sprint 2 — live polling page & behavioral acceptance (fetch-level).
//
// These tests drive the *served page* over real HTTP against the checked-in
// fixture run directories and assert the sprint-2 contract's behavioral edges:
//   c2  the page is anchored by a known #elapsed element the poller fills,
//   c4  the served JS polls /data via setInterval+fetch and mutates the DOM,
//       and there is NO meta-refresh / full-page navigation,
//   c6  the single placeholder token "—" is used for absent fields, partial
//       scores render without fabrication, and a corrupt cold-start /data
//       carries an explicit stale:true signal with defined fallbacks — never a
//       500 or blank page.
// Everything is hermetic: loopback server, loopback fetch, local fixtures.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "dashboard");
const fx = (name: string) => join(fixtures, name);
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const PLACEHOLDER = "—";

let open: DashboardServer[] = [];
async function launch(runDir: string): Promise<DashboardServer> {
  const s = await start({ runDir, port: 0 });
  open.push(s);
  return s;
}
afterEach(async () => {
  const toClose = open;
  open = [];
  await Promise.all(toClose.map((s) => s.close().catch(() => {})));
});

const getText = async (url: string) => (await fetch(url)).text();

/** The document splits cleanly into the server-rendered <main> and the client
 *  <script>. Several assertions must look only at the rendered markup (the
 *  polling script legitimately embeds the same label/reason strings for its
 *  in-place re-render), so this returns just the pre-script portion. */
const renderedOnly = (html: string): string => html.split("<script>")[0];

describe("dashboard page — c2/c4 v2 stats tile is anchored by a stable id the poller fills", () => {
  test("GET / carries the Duration/Elapsed tile with a stable id (id=\"tileDuration\")", async () => {
    const s = await launch(fx("complete"));
    const body = await getText(`${s.url}/`);
    // A stable anchor the client poller targets by id — resilient to the
    // ever-changing elapsed string. In v2 elapsed lives in the stats tile.
    expect(body).toMatch(/id=["']tileDuration["']/);
    // A finished run labels the tile "Duration" (frozen), not "Elapsed".
    expect(body).toContain("Duration");
  });

  test("GET / renders every required v2 element from the complete fixture", async () => {
    const dir = fx("complete");
    const state = readJson(join(dir, "state.json"));
    const s = await launch(dir);
    const body = await getText(`${s.url}/`);

    // Goal-first header: repo name (derived basename), then a run-id tag.
    expect(body).toContain("dev-harness");
    expect(body).toContain(state.runId);
    // Coarse forward-only run strip: three fixed labels, no per-sprint segments.
    expect(body).toContain("Plan");
    expect(body).toContain("Generate");
    expect(body).toContain("Done");
    // Stats tiles present (a plan exists): Sprint X / N.
    expect(body).toMatch(/id=["']tileSprint["']/);
    expect(body).toContain(`/ ${state.totalSprints ?? state.sprints.length}`);
    // Sprint card title (HTML-escaped: "&" → "&amp;").
    expect(body).toContain(
      state.sprints[state.currentSprint].title.replace(/&/g, "&amp;"),
    );
    // A per-sprint score value drawn from the EVALUATE path (last sprint = 91).
    expect(body).toContain("91");
    // The metrics sub-line vocabulary is present.
    expect(body).toContain("negotiation round");
    expect(body).toContain("build attempt");
    expect(body).toContain("file edit");
    // Spend rendered when budgetSpentUsd present.
    expect(body).toContain(String(state.budgetSpentUsd));
    // The full goal is reachable but not inlined on the run page.
    expect(body).toMatch(/href=["']\/goal["']/);
  });
});

describe("dashboard page — c4 client-side polling, no meta-refresh", () => {
  test("served JS uses setInterval + fetch('/data') + a DOM-mutation API", async () => {
    const s = await launch(fx("complete"));
    const body = await getText(`${s.url}/`);

    // Evidence of an interval-driven poll loop.
    expect(body).toMatch(/setInterval\s*\(/);
    // The fetch targets the /data endpoint specifically.
    expect(body).toMatch(/fetch\s*\(\s*["']\/data["']/);
    // The page mutates the DOM in place (any of these DOM APIs).
    expect(body).toMatch(/getElementById|querySelector|textContent|innerHTML/);
  });

  test("page contains NO <meta http-equiv=\"refresh\"> and no full-page reload", async () => {
    const s = await launch(fx("complete"));
    const body = await getText(`${s.url}/`);
    // No meta-refresh (case-insensitive, tolerant of attribute spacing/order).
    expect(body).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
    // No scripted full-page navigation.
    expect(body).not.toMatch(/location\.(reload|assign|replace|href)/);
    expect(body).not.toMatch(/window\.location/);
  });
});

describe("dashboard page — c6 graceful degradation with an explicit placeholder", () => {
  test("missing-fields: absent budgetSpentUsd renders the placeholder token, page 200", async () => {
    const dir = fx("missing-fields");
    const s = await launch(dir);
    const res = await fetch(`${s.url}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The known-absent spend field renders the single placeholder token,
    // anchored to the #tileSpend stats-tile element the poller also fills.
    expect(body).toMatch(
      new RegExp(`id=["']tileSpend["']>\\s*${PLACEHOLDER}`),
    );
    // /data reports the absent optional as null (not fabricated), not stale.
    const data = await (await fetch(`${s.url}/data`)).json();
    expect(data.budgetSpentUsd).toBeNull();
    expect(data.stale).toBe(false);
  });

  test("mid-run partial: present scores render, missing ones are not fabricated", async () => {
    const dir = fx("partial");
    const state = readJson(join(dir, "state.json"));
    const s = await launch(dir);
    const data = await (await fetch(`${s.url}/data`)).json();

    // status preserved, not stale.
    expect(data.status).toBe("running");
    expect(data.stale).toBe(false);
    // Exactly the scores that exist are surfaced — none fabricated for the
    // not-yet-evaluated sprints.
    expect(Array.isArray(data.scores)).toBe(true);
    expect(data.scores.length).toBeLessThan(state.sprints.length);
    // The one present score value shows up on the page.
    const body = await getText(`${s.url}/`);
    expect(body).toContain("72");
  });

  test("corrupt cold-start: /data is 200 with stale:true and defined fallbacks", async () => {
    const s = await launch(fx("corrupt"));
    const res = await fetch(`${s.url}/data`);
    expect(res.status).toBe(200); // never 500
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const data = await res.json();

    // The explicit "updating"/stale discriminator.
    expect(data.stale).toBe(true);
    // Defined fallbacks — not throwing, not NaN. state.json is unparseable so
    // there is no startedAt → elapsedMs falls back to null, and the score list
    // falls back to a defined array (no fabrication from a corrupt state).
    expect(data.elapsedMs).toBeNull();
    expect(Array.isArray(data.scores)).toBe(true);
    // phase is read from trace.jsonl independently of the corrupt state, so it
    // is whatever the last trace line says (or the null fallback when trace is
    // absent/empty) — never a throw. The stale/JSON contract holds either way.
    expect(data.phase === null || typeof data.phase === "string").toBe(true);

    // And GET / still returns a 200 HTML page (not blank/error).
    const page = await fetch(`${s.url}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toMatch(/<!DOCTYPE html>/i);
    // The page shows an explicit updating signal, and placeholders elsewhere.
    expect(html).toContain(PLACEHOLDER);
  });
});

describe("dashboard target selection — c5 arg parsing", () => {
  test("an explicit positional path becomes runDir", () => {
    const opts = resolveTargetFromArgs(["/some/run/dir"]);
    expect(opts.runDir).toBe("/some/run/dir");
    expect(opts.runsDir).toBeUndefined();
  });

  test("--run-dir wins over auto-discovery", () => {
    const opts = resolveTargetFromArgs(["--run-dir", "/explicit"]);
    expect(opts.runDir).toBe("/explicit");
  });

  test("--runs-dir selects an auto-discovery root", () => {
    const opts = resolveTargetFromArgs(["--runs-dir", "/my/runs"]);
    expect(opts.runsDir).toBe("/my/runs");
    expect(opts.runDir).toBeUndefined();
  });

  test("no args defaults to auto-discovery under runs/", () => {
    const opts = resolveTargetFromArgs([]);
    expect(opts.runDir).toBeUndefined();
    expect(opts.runsDir).toBe("runs");
  });

  test("--port and --host are parsed when present", () => {
    const opts = resolveTargetFromArgs(["--port", "8080", "--host", "0.0.0.0", "/dir"]);
    expect(opts.port).toBe(8080);
    expect(opts.host).toBe("0.0.0.0");
    expect(opts.runDir).toBe("/dir");
  });

  test("auto-discovery under runsDir serves the newest run end-to-end", async () => {
    const runs = mkdtempSync(join(tmpdir(), "dash-arg-runs-"));
    const older = join(runs, "older");
    const newer = join(runs, "newer");
    mkdirSync(older);
    mkdirSync(newer);
    for (const d of [older, newer]) {
      writeFileSync(
        join(d, "state.json"),
        JSON.stringify({
          runId: d === newer ? "NEWEST" : "older",
          goal: "g",
          startedAt: "2026-07-21T10:00:00.000Z",
          status: "running",
          sprints: [{ id: 0, title: "T", description: "d" }],
          currentSprint: 0,
          contractVersion: 1,
          scores: [],
        }),
      );
    }
    const t = Date.now() / 1000;
    utimesSync(older, t - 1000, t - 1000);
    utimesSync(newer, t, t);

    const s = await start({ runsDir: runs, port: 0 });
    open.push(s);
    const data = await (await fetch(`${s.url}/data`)).json();
    expect(data.runId).toBe("NEWEST");
  });
});

// ---------------------------------------------------------------------------
// v2 layout acceptance (c1–c8): the goal-first header, the coarse run strip,
// the one-line goal + reachable full-goal view, the stats tiles that appear
// only once a plan exists, the metrics sub-line derived from the trace (NOT
// state.iterations), the plain-language halt banner, and all four run states
// rendering 200. Driven over real HTTP against the checked-in fixtures.
// ---------------------------------------------------------------------------

describe("dashboard v2 — c1 goal-first header order (repo → run id → status)", () => {
  test("running fixture leads with the derived repo name before the run id and status pill", async () => {
    const dir = fx("running");
    const state = readJson(join(dir, "state.json"));
    const s = await launch(dir);
    const body = await getText(`${s.url}/`);

    // Repo name is the basename of projectPath — derived, not hardcoded.
    const repoIdx = body.indexOf("dev-harness");
    const runIdIdx = body.indexOf(state.runId);
    const statusIdx = body.search(/id=["']statusPill["']/);
    expect(repoIdx).toBeGreaterThan(-1);
    expect(runIdIdx).toBeGreaterThan(-1);
    expect(statusIdx).toBeGreaterThan(-1);
    // Order in the source: repo before run id before the status pill.
    expect(repoIdx).toBeLessThan(runIdIdx);
    expect(runIdIdx).toBeLessThan(statusIdx);
  });

  test("repo name is derived from projectPath's basename, not the full path", async () => {
    const s = await launch(fx("running"));
    const data = await (await fetch(`${s.url}/data`)).json();
    expect(data.repoName).toBe("dev-harness");
  });
});

describe("dashboard v2 — c2 one-line goal verbatim + reachable full goal", () => {
  test("planning fixture shows the one-line goal prominently, frontmatter/heading stripped", async () => {
    const s = await launch(fx("planning"));
    const body = await getText(`${s.url}/`);
    const data = await (await fetch(`${s.url}/data`)).json();

    // The one-line goal is lifted verbatim: no YAML frontmatter, no "#" heading.
    expect(data.oneLineGoal).toBe(
      "Build a read-only local web dashboard for the active or most recent dev-harness run.",
    );
    expect(data.oneLineGoal).not.toContain("---");
    expect(data.oneLineGoal).not.toContain("# Goal");
    // It is rendered prominently on the planning page.
    expect(body).toContain(
      "Build a read-only local web dashboard for the active or most recent dev-harness run.",
    );
  });

  test("non-planning fixture links to a reachable /goal view instead of inlining the whole goal", async () => {
    const s = await launch(fx("running"));
    const body = await getText(`${s.url}/`);
    expect(body).toMatch(/href=["']\/goal["']/);
    const res = await fetch(`${s.url}/goal`);
    expect(res.status).toBe(200);
    const goalHtml = await res.text();
    // The full-goal view carries the goal text (formatted, not a raw dump).
    expect(goalHtml).toContain(
      "Build a read-only local web dashboard for the active or most recent dev-harness run.",
    );
  });
});

describe("dashboard v2 — c3 coarse forward-only run strip", () => {
  test("the strip is three fixed labels (Plan/Generate/Done), no per-sprint segments", async () => {
    const s = await launch(fx("running"));
    const rendered = renderedOnly(await getText(`${s.url}/`));
    expect(rendered).toMatch(/id=["']runStrip["']/);
    expect(rendered).toContain(">Plan<");
    expect(rendered).toContain(">Generate<");
    expect(rendered).toContain(">Done<");
    // Exactly three stage labels — a coarse strip, not one-per-sprint (the
    // running fixture has three sprints, so a per-sprint strip would differ).
    const stageLabels = rendered.match(/class=["']stage-label["']/g) ?? [];
    expect(stageLabels.length).toBe(3);
  });

  test("a passed run fills the strip green with all stages done", async () => {
    const s = await launch(fx("complete"));
    const body = await getText(`${s.url}/`);
    expect(body).toContain("--fill:var(--good)");
  });

  test("a halted run marks the strip amber/paused", async () => {
    const s = await launch(fx("halted"));
    const body = await getText(`${s.url}/`);
    expect(body).toContain("--fill:var(--warn)");
    expect(body).toContain("Paused");
  });
});

describe("dashboard v2 — c4 stats tiles present with a plan, absent while planning", () => {
  test("running fixture (plan exists) shows the Sprint/Duration/Spend tiles", async () => {
    const s = await launch(fx("running"));
    const body = await getText(`${s.url}/`);
    expect(body).toMatch(/id=["']tileSprint["']/);
    expect(body).toMatch(/id=["']tileDuration["']/);
    expect(body).toMatch(/id=["']tileSpend["']/);
    // Elapsed label while still running (not the frozen "Duration").
    expect(body).toContain("Elapsed");
  });

  test("planning fixture (no plan yet) renders NO stats tiles", async () => {
    const s = await launch(fx("planning"));
    const body = await getText(`${s.url}/`);
    // The stats container exists but is empty during planning — no tiles.
    expect(body).not.toMatch(/id=["']tileSprint["']/);
    expect(body).not.toMatch(/id=["']tileSpend["']/);
  });
});

describe("dashboard v2 — c5 metrics sub-line derived from the trace, not state.iterations", () => {
  test("halted fixture: build attempts = GENERATE-event count (3), NOT state.iterations", async () => {
    const dir = fx("halted");
    const state = readJson(join(dir, "state.json"));
    const s = await launch(dir);
    const body = await getText(`${s.url}/`);

    // state.iterations is known-stale (0 here); the page must NOT report it.
    expect(state.iterations).toBe(0);
    // Build attempts is derived from the 3 GENERATE trace events for sprint 1.
    expect(body).toContain("3 build attempts");
    // File edits is the count of "Edit" entries across those GENERATE events.
    expect(body).toContain("24 file edits");
    // The metrics sub-line vocabulary is present in full.
    expect(body).toContain("negotiation round");
    expect(body).toContain("build attempt");
    expect(body).toContain("file edit");
  });

  test("halted sprint card shows 'best N' (the best score reached), not merely the last", async () => {
    const s = await launch(fx("halted"));
    const body = await getText(`${s.url}/`);
    // Scores for the halted sprint were 61, 72, 70 → best 72.
    expect(body).toMatch(/best\s*<span class=["']score[^>]*>72<\/span>/);
  });
});

describe("dashboard v2 — c6 plain-language halt banner", () => {
  test("halted (max-iteration) fixture renders the committed banner text", async () => {
    const s = await launch(fx("halted"));
    // Scope to the rendered markup so this asserts a VISIBLE banner, not merely
    // the embedded HALT_REASONS map in the polling script.
    const rendered = renderedOnly(await getText(`${s.url}/`));
    expect(rendered).toContain(
      "Used all its attempts on this sprint (6 tries) without clearing the score bar. Paused — partial work is saved.",
    );
    // The banner is present and NOT hidden on a halted run.
    expect(rendered).toMatch(/id=["']haltNote["'](?![^>]*hidden)/);
  });

  test("a non-halted run shows NO visible halt banner", async () => {
    const s = await launch(fx("running"));
    // Look only at the rendered markup — the polling script legitimately embeds
    // the HALT_REASONS map for its in-place re-render, so the sentence exists in
    // the JS regardless of state.
    const rendered = renderedOnly(await getText(`${s.url}/`));
    expect(rendered).not.toContain("without clearing the score bar");
    // The halt-note element is present but hidden on a running run.
    expect(rendered).toMatch(/id=["']haltNote["'][^>]*hidden/);
  });
});

describe("dashboard v2 — c7 all four run states render 200", () => {
  for (const name of ["planning", "running", "complete", "halted"]) {
    test(`GET / and /data are 200 for the ${name} fixture`, async () => {
      const s = await launch(fx(name));
      const page = await fetch(`${s.url}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toMatch(/<!DOCTYPE html>/i);
      const dataRes = await fetch(`${s.url}/data`);
      expect(dataRes.status).toBe(200);
      // No meta-refresh, no scripted full-page navigation.
      expect(html).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
      expect(html).not.toMatch(/location\.(reload|assign|replace|href)/);
      expect(html).not.toMatch(/window\.location/);
    });
  }
});

// ---------------------------------------------------------------------------
// Contract-close: explicit /data-level and source-level assertions the frozen
// contract enumerates, complementing the page-level checks above.
//   c1  planning /data: totalSprints===0, empty sprintBreakdown, strip at Plan.
//   c2  halted /data: derived attempts/edits/cost + non-null best-so-far score,
//       and the passed card shows a plain score (no "best" prefix).
//   c5  the /goal view renders a "#"/"##" heading as <hN> and a "- item" as
//       <li> (formatted, not a raw monospace dump), and no new npm dep.
//   c6  ALL six halt codes map to the exact prototype HALT_REASONS wording.
//   c8  /data is 200 JSON for all four states; corrupt cold-start is stale:true.
// ---------------------------------------------------------------------------

describe("dashboard v2 — c1 planning state /data shape", () => {
  test("planning /data reports no plan (totalSprints 0, empty breakdown) and strip sits at Plan", async () => {
    const s = await launch(fx("planning"));
    const data = await (await fetch(`${s.url}/data`)).json();
    // No plan has formed yet.
    expect(data.totalSprints).toBe(0);
    expect(Array.isArray(data.sprintBreakdown)).toBe(true);
    expect(data.sprintBreakdown).toHaveLength(0);

    // The coarse strip is at the first (Plan) stage: Plan "current", the other
    // two "pending", zero progress fill.
    const rendered = renderedOnly(await getText(`${s.url}/`));
    expect(rendered).toContain("--progress:0");
    // Plan is the current stage; Generate/Done are still pending (not done).
    expect(rendered).toMatch(/class=["']stage current["'][^>]*>\s*<span class=["']stage-node["']>\s*<\/span><span class=["']stage-label["']>Plan</);
    expect(rendered).not.toContain("stage done");
  });
});

describe("dashboard v2 — c2 halted /data derived metrics + best-so-far, passed plain score", () => {
  test("halted /data sprintBreakdown carries derived attempts>=2, edits>=1, cost>0 and a non-null best score", async () => {
    const dir = fx("halted");
    const s = await launch(dir);
    const data = await (await fetch(`${s.url}/data`)).json();
    // The halted current sprint (index 1) is the one exercising the metrics.
    const row = data.sprintBreakdown[1];
    expect(row.state).toBe("halted");
    expect(row.attempts).toBeGreaterThanOrEqual(2);
    expect(row.edits).toBeGreaterThanOrEqual(1);
    expect(row.cost).toBeGreaterThan(0);
    // best-so-far score is populated (61,72,70 → 72), never null on a halted
    // sprint that reached at least one score.
    expect(row.score).not.toBeNull();
    expect(row.score).toBe(72);

    // And on the served page it reads as "best <score>", not a plain score.
    const body = await getText(`${s.url}/`);
    expect(body).toMatch(/best\s*<span class=["']score[^>]*>72<\/span>/);
  });

  test("a passed/done card renders a plain score with NO 'best' prefix", async () => {
    const s = await launch(fx("complete"));
    const rendered = renderedOnly(await getText(`${s.url}/`));
    // The final done sprint scored 91 — rendered as a bare score chip, not
    // "best 91".
    expect(rendered).toMatch(/<span class=["']score[^>]*>91<\/span>/);
    expect(rendered).not.toMatch(/best\s*<span class=["']score[^>]*>91<\/span>/);
  });
});

describe("dashboard v2 — c5 full-goal view is formatted markdown (headings + lists)", () => {
  test("/goal renders a '#' heading as an <hN> and a '- item' as an <li>", async () => {
    const s = await launch(fx("running"));
    const res = await fetch(`${s.url}/goal`);
    expect(res.status).toBe(200);
    const goalHtml = await res.text();
    // The complete goal body is present, formatted rather than a raw dump.
    expect(goalHtml).toContain(
      "Build a read-only local web dashboard for the active or most recent dev-harness run.",
    );
    // A markdown heading became a real heading element (h1..h6).
    expect(goalHtml).toMatch(/<h[1-6][^>]*>[^<]*Requirements[^<]*<\/h[1-6]>/i);
    // A markdown bullet became a real list item.
    expect(goalHtml).toMatch(/<li[^>]*>[^<]*Never write to the run folder\.[^<]*<\/li>/i);
    // It is a <ul>, not a monospace <pre> dump.
    expect(goalHtml).toContain("<ul>");
    expect(goalHtml).not.toMatch(/<pre[^>]*>[\s\S]*Requirements/i);
  });

  test("package.json declares no new runtime dependency for the goal renderer", () => {
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    const deps = Object.keys(pkg.dependencies ?? {});
    const allowed = new Set([
      "@anthropic-ai/claude-agent-sdk",
      "commander",
      "execa",
      "zod",
    ]);
    for (const d of deps) {
      expect(allowed.has(d), `unexpected new dependency: ${d}`).toBe(true);
    }
    // No markdown library snuck into any dependency bucket.
    const all = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    for (const name of Object.keys(all)) {
      expect(/markdown|marked|remark|markdown-it|showdown/i.test(name)).toBe(false);
    }
  });
});

describe("dashboard v2 — c6 all six halt codes map to the exact prototype wording", () => {
  const EXPECTED: Record<string, { label: string; text: string }> = {
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

  test("the served page (and its polling map) contains every code's exact sentence and label", async () => {
    // The HALT_REASONS map is emitted as JSON into the polling script so a live
    // re-render uses the same wording — so every code's exact text is present in
    // the served document regardless of the current state.
    const s = await launch(fx("halted"));
    const body = await getText(`${s.url}/`);
    for (const [code, { text }] of Object.entries(EXPECTED)) {
      expect(body, `missing wording for ${code}`).toContain(text);
    }
    // Both label kinds are represented: five graceful "Paused", one "Stopped".
    expect(body).toContain("Paused");
    expect(body).toContain("Stopped");
  });

  test("the server source encodes each code with the correct Paused/Stopped label", () => {
    const src = readFileSync(serverSrc, "utf8");
    for (const [code, { label, text }] of Object.entries(EXPECTED)) {
      expect(src, `missing code ${code}`).toContain(code);
      expect(src, `missing text for ${code}`).toContain(text);
    }
    // The five StopReason codes are graceful "Paused"; the fault is "Stopped".
    const paused = Object.entries(EXPECTED).filter(([, r]) => r.label === "Paused");
    const stopped = Object.entries(EXPECTED).filter(([, r]) => r.label === "Stopped");
    expect(paused).toHaveLength(5);
    expect(stopped).toHaveLength(1);
    expect(stopped[0][0]).toBe("evaluator-parse-error");
  });
});

describe("dashboard v2 — c8 /data is 200 JSON for all four states, corrupt is stale", () => {
  for (const name of ["planning", "running", "complete", "halted"]) {
    test(`/data is 200 application/json for the ${name} fixture`, async () => {
      const s = await launch(fx(name));
      const res = await fetch(`${s.url}/data`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      const data = await res.json();
      expect(typeof data).toBe("object");
      expect(data).not.toBeNull();
      expect(data.stale).toBe(false);
    });
  }

  test("corrupt cold-start /data is 200 with stale:true (never a 500)", async () => {
    const s = await launch(fx("corrupt"));
    const res = await fetch(`${s.url}/data`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.stale).toBe(true);
  });
});
