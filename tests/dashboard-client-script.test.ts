import { afterEach, describe, expect, test } from "vitest";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { start, type DashboardServer } from "../src/dashboard/server.js";

// ---------------------------------------------------------------------------
// Guardrail: the served client <script> must actually COMPILE and RUN, not just
// contain the right substrings.
//
// Why this file exists: the polling script is emitted as text from inside a
// backtick template in server.ts. A `\/` in a regex there is eaten by the
// template literal, so `/\/+$/` shipped to the browser as `//+$/` — where `//`
// starts a comment, swallowing the rest of the line and making the ENTIRE
// script fail to parse. The whole dashboard then froze on its first snapshot,
// on every device. The pre-existing page tests missed it because they assert on
// substrings (`location.pathname.replace(` was still present) and never execute
// the JS. These tests close that gap by (1) compiling the served script and
// (2) running it in a simulated DOM and watching the elapsed clock advance.
//
// Hermetic: loopback server against the checked-in fixtures, no network.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => join(here, "fixtures", "dashboard", name);

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

/** Concatenate every inline <script> block from the served document. */
function extractClientScript(html: string): string {
  const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
  return blocks.join("\n;\n");
}

describe("dashboard client script — the served JS is valid, executable code", () => {
  // Every run state emits the same polling script; compile all of them so a
  // broken emit is caught regardless of which fixture is newest in production.
  for (const name of ["planning", "running", "complete", "halted", "corrupt"]) {
    test(`GET / for the ${name} fixture emits a client script that PARSES`, async () => {
      const s = await launch(fx(name));
      const html = await (await fetch(`${s.url}/`)).text();
      const js = extractClientScript(html);
      expect(js.length).toBeGreaterThan(0);
      // new vm.Script compiles WITHOUT running — it throws SyntaxError on the
      // exact class of bug that froze the dashboard (a regex backslash eaten by
      // the template literal, yielding `//...` that comments out the line).
      expect(() => new vm.Script(js)).not.toThrow();
    });
  }
});

describe("dashboard client script — the elapsed clock ticks locally every second", () => {
  test("running fixture: the clock advances one second at a time between polls", async () => {
    const s = await launch(fx("running"));
    const url = s.url;
    const html = await (await fetch(`${url}/`)).text();
    const js = extractClientScript(html);
    // Use the fixture's REAL /data payload so the shape matches production.
    const payload = await (await fetch(`${url}/data`)).json();
    expect(payload.status).toBe("running"); // a live run → clock must tick
    expect(typeof payload.elapsedMs).toBe("number");

    // A minimal DOM: getElementById auto-creates a stub node per id, so the
    // ticker's target (#tileDuration) exists and we can read what it writes.
    const els: Record<string, { innerHTML: string; textContent: string; hidden: boolean }> = {};
    const makeEl = () => ({ innerHTML: "", textContent: "", hidden: false });
    let now = 1_000_000_000;
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const sandbox: Record<string, unknown> = {
      document: {
        getElementById: (id: string) => (els[id] ??= makeEl()),
      },
      location: { pathname: "/dashboard" },
      // Stub fetch → the fixture payload, so the immediate poll() anchors the clock.
      fetch: () => Promise.resolve({ json: () => Promise.resolve(payload) }),
      setInterval: (fn: () => void, ms: number) => {
        intervals.push({ fn, ms });
        return intervals.length;
      },
      setTimeout: (fn: () => void) => {
        fn();
        return 0;
      },
      Date: { now: () => now },
      console,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInNewContext(js, sandbox);
    // Let the immediate poll()'s fetch promise resolve → apply() → syncClock().
    await new Promise((r) => setTimeout(r, 20));

    const ticker = intervals.find((iv) => iv.ms === 1000);
    expect(ticker, "a 1000ms tick interval must be registered").toBeTruthy();

    const readClock = () => els.tileDuration?.textContent ?? "";
    const anchored = readClock();

    // Advance the simulated wall clock three seconds, ticking once per second.
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      now += 1000;
      ticker!.fn();
      seen.push(readClock());
    }

    // Each second produces a distinct, strictly-later HH:MM:SS value — the clock
    // is driven locally, not by the (here, one-shot) network poll.
    expect(new Set(seen).size).toBe(3);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1]).not.toBe(seen[2]);
    // Sanity: the ticked values look like a clock and moved on from the anchor.
    expect(seen[2]).toMatch(/^\d+:\d{2}:\d{2}$/);
    expect(seen.includes(anchored) && anchored !== "").toBe(false);
  });

  test("finished (complete) fixture: the clock does NOT tick (shows a frozen duration)", async () => {
    const s = await launch(fx("complete"));
    const url = s.url;
    const js = extractClientScript(await (await fetch(`${url}/`)).text());
    const payload = await (await fetch(`${url}/data`)).json();
    expect(payload.status).toBe("passed"); // finished → clock is frozen

    const els: Record<string, { innerHTML: string; textContent: string; hidden: boolean }> = {};
    const makeEl = () => ({ innerHTML: "", textContent: "", hidden: false });
    let now = 2_000_000_000;
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const sandbox: Record<string, unknown> = {
      document: { getElementById: (id: string) => (els[id] ??= makeEl()) },
      location: { pathname: "/dashboard" },
      fetch: () => Promise.resolve({ json: () => Promise.resolve(payload) }),
      setInterval: (fn: () => void, ms: number) => {
        intervals.push({ fn, ms });
        return intervals.length;
      },
      setTimeout: (fn: () => void) => {
        fn();
        return 0;
      },
      Date: { now: () => now },
      console,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.runInNewContext(js, sandbox);
    await new Promise((r) => setTimeout(r, 20));

    // Seed a sentinel, then advance time and tick: a finished run must leave it
    // untouched (clockLive === false).
    els.tileDuration = makeEl();
    els.tileDuration.textContent = "FROZEN";
    const ticker = intervals.find((iv) => iv.ms === 1000);
    expect(ticker).toBeTruthy();
    now += 5000;
    ticker!.fn();
    expect(els.tileDuration.textContent).toBe("FROZEN");
  });
});
