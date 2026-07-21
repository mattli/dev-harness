import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("dashboard page — c2 elapsed is anchored by a stable id the poller fills", () => {
  test("GET / carries an element with id=\"elapsed\" (not just a volatile value)", async () => {
    const s = await launch(fx("complete"));
    const body = await getText(`${s.url}/`);
    // A stable anchor the client poller targets by id — resilient to the
    // ever-changing elapsed string.
    expect(body).toMatch(/id=["']elapsed["']/);
  });

  test("GET / renders every required field label from the complete fixture", async () => {
    const dir = fx("complete");
    const state = readJson(join(dir, "state.json"));
    const s = await launch(dir);
    const body = await getText(`${s.url}/`);

    // Goal text (human line), current round, current step/phase all present.
    expect(body).toContain("Build the read-only dashboard.");
    expect(body).toContain(String(state.contractVersion)); // current round
    expect(body).toContain("DECIDE"); // current step = last trace line's phase
    // Sprint number + title (title HTML-escaped: "&" → "&amp;").
    expect(body).toContain(String(state.currentSprint));
    expect(body).toContain(
      state.sprints[state.currentSprint].title.replace(/&/g, "&amp;"),
    );
    // A per-sprint score value drawn from the EVALUATE path.
    expect(body).toContain("91");
    // Spend rendered when budgetSpentUsd present.
    expect(body).toContain(String(state.budgetSpentUsd));
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
    // anchored to the #spend element the poller also fills.
    expect(body).toMatch(
      new RegExp(`id=["']spend["']>\\s*${PLACEHOLDER}`),
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
