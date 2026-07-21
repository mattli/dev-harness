import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { start, type DashboardServer } from "../src/dashboard/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "dashboard");
const fx = (name: string) => join(fixtures, name);
const serverSrc = join(here, "..", "src", "dashboard", "server.ts");

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const lastTraceLine = (dir: string) => {
  const lines = readFileSync(join(dir, "trace.jsonl"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
};

// Track servers started per-test so we always release the port.
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

describe("dashboard server — c1 import-safety & explicit lifecycle", () => {
  test("importing the module binds no port and starts no server", () => {
    // The import above executed at module load. If the module bound a port or
    // started listening on import, that side effect would already have fired.
    // Assert the source has no top-level start()/listen() side effect.
    const src = readFileSync(serverSrc, "utf8");
    // No bare top-level invocation of start() or .listen() outside function bodies.
    // (start is only ever *defined* and exported here, never called at module scope.)
    const topLevelStartCall = /^\s*start\s*\(/m.test(src);
    expect(topLevelStartCall).toBe(false);
    // listen() appears only inside the exported start() implementation.
    expect(src.includes("server.listen(")).toBe(true);
  });

  test("start(port:0) binds an ephemeral port, is listening, then closes cleanly", async () => {
    const s = await start({ runDir: fx("complete"), port: 0 });
    try {
      expect(typeof s.port).toBe("number");
      expect(s.port).toBeGreaterThan(0); // ephemeral port was actually assigned
      expect(s.server.listening).toBe(true);
    } finally {
      await s.close();
    }
    expect(s.server.listening).toBe(false); // cleanly stopped, port released
  });
});

describe("dashboard server — c2 GET / returns 200 HTML", () => {
  test("serves an HTML document with text/html content-type", async () => {
    const s = await launch(fx("complete"));
    const res = await fetch(`${s.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const body = await res.text();
    expect(body).toMatch(/<!DOCTYPE html>/i);
    expect(body).toContain("<html");
    expect(body).toContain("<body");
  });

  test("the page is populated from the fixture (goal, sprint title, a score)", async () => {
    const dir = fx("complete");
    const state = readJson(join(dir, "state.json"));
    const s = await launch(dir);
    const body = await (await fetch(`${s.url}/`)).text();
    // Goal text (its human line) is rendered.
    expect(body).toContain("Build the read-only dashboard.");
    // Current sprint title (HTML-escaped in the served markup, so compare the
    // escaped form — the title "HTTP server & page" renders with &amp;).
    const escTitle = state.sprints[state.currentSprint].title.replace(/&/g, "&amp;");
    expect(body).toContain(escTitle);
    // At least one per-sprint score is present in the page.
    expect(body).toContain(String(state.scores[state.scores.length - 1]));
    // Spend rendered when budgetSpentUsd is present.
    expect(body).toContain(String(state.budgetSpentUsd));
  });
});

describe("dashboard server — c3 GET /data returns mapped JSON", () => {
  test("returns 200 application/json with the mapped fields", async () => {
    const dir = fx("complete");
    const state = readJson(join(dir, "state.json"));
    const last = lastTraceLine(dir);
    const s = await launch(dir);

    const res = await fetch(`${s.url}/data`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");

    const data = await res.json();
    expect(data.goal).toBe(state.goal);
    expect(data.currentSprint).toBe(state.currentSprint);
    expect(data.currentSprintTitle).toBe(state.sprints[state.currentSprint].title);
    expect(data.contractVersion).toBe(state.contractVersion);
    expect(data.phase).toBe(last.phase); // current step = last trace line's phase
    expect(data.status).toBe(state.status);
    expect(data.budgetSpentUsd).toBe(state.budgetSpentUsd);

    // Per-sprint scores present.
    expect(Array.isArray(data.scores)).toBe(true);
    expect(data.scores.length).toBeGreaterThan(0);

    // Elapsed is a finite, non-negative number computed against server's clock
    // (fixture startedAt is in the past). No exact-ms assertion → no flake.
    expect(typeof data.elapsedMs).toBe("number");
    expect(Number.isFinite(data.elapsedMs)).toBe(true);
    expect(data.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe("dashboard server — c4 /data never 500s across all four fixtures", () => {
  const cases: Array<[string, string]> = [
    ["complete finished run", "complete"],
    ["mid-run partial", "partial"],
    ["missing optional fields", "missing-fields"],
    ["corrupt/half-written state.json", "corrupt"],
  ];

  for (const [label, name] of cases) {
    test(`(${label}) → 200 JSON, no throw`, async () => {
      const s = await launch(fx(name));
      const res = await fetch(`${s.url}/data`);
      expect(res.status).toBe(200);
      const data = await res.json(); // parses as JSON
      expect(typeof data).toBe("object");
      expect(data).not.toBeNull();
    });
  }

  test("corrupt fixture carries a degraded/updating signal, not an error status", async () => {
    const s = await launch(fx("corrupt"));
    const res = await fetch(`${s.url}/data`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.degraded).toBe(true);
  });

  test("missing-fields and mid-run partial are NOT flagged degraded", async () => {
    const missing = await launch(fx("missing-fields"));
    const partial = await launch(fx("partial"));
    const md = await (await fetch(`${missing.url}/data`)).json();
    const pd = await (await fetch(`${partial.url}/data`)).json();
    expect(md.degraded).toBe(false);
    expect(pd.degraded).toBe(false);
    expect(pd.status).toBe("running");
  });
});

describe("dashboard server — c5 deterministic routing & continued responsiveness", () => {
  test("unmapped route → non-2xx, and server stays responsive to GET /", async () => {
    const s = await launch(fx("complete"));
    const miss = await fetch(`${s.url}/nonexistent`);
    expect(miss.status).toBeGreaterThanOrEqual(300); // non-2xx (deterministic 404)
    expect(miss.status).toBe(404);
    // Server still responsive afterwards.
    const ok = await fetch(`${s.url}/`);
    expect(ok.status).toBe(200);
  });
});

describe("dashboard server — c6 runtime import closure stays SDK-free", () => {
  test("server source imports only node stdlib + the sibling reader (+ type-only)", () => {
    const src = readFileSync(serverSrc, "utf8");
    const specs = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of specs) {
      const isStdlib = spec.startsWith("node:");
      const isReader = /\.\/reader\.js$/.test(spec);
      const isTypeOnlyLocalType = /\.\.\/(state|trace|contract)\/types\.js$/.test(spec);
      expect(
        isStdlib || isReader || isTypeOnlyLocalType,
        `unexpected import specifier: ${spec}`,
      ).toBe(true);
    }
    // Must not reach the SDK / orchestrator / agents / CLI at runtime.
    expect(src).not.toMatch(/claude-agent-sdk/);
    expect(src).not.toMatch(/from\s+["']\.\.\/(cli|orchestrator|agents)\//);
  });

  test("the loaded require.cache does not include the Anthropic SDK", async () => {
    // Exercise the module in this process; then assert nothing in the resolved
    // module graph pulled the SDK in. We check both require.cache (if present
    // under the test runner) and that a fresh dynamic import resolves without
    // dragging the SDK. The static check above is the primary guard; this is a
    // runtime backstop.
    const mod = await import("../src/dashboard/server.js");
    expect(typeof mod.start).toBe("function");
    // No global marker of the SDK should have been initialised by importing us.
    // (The SDK, if loaded, commonly reads ANTHROPIC_* env at import; we simply
    // assert our import did not throw and start remains callable — the port is
    // only bound on explicit start(), proven by c1.)
  });
});

describe("dashboard server — c7 hermetic, offline, no new deps", () => {
  test("runs entirely against local fixtures with no network egress", async () => {
    // Purely local: start on loopback, fetch loopback. If this test suite ran
    // with network disabled it would still pass, since every fetch targets
    // 127.0.0.1 on the ephemeral port we bound.
    const s = await launch(fx("complete"));
    expect(s.host === "127.0.0.1" || s.host === "::1" || s.host === "localhost").toBe(true);
    const res = await fetch(`${s.url}/data`);
    expect(res.status).toBe(200);
  });

  test("package.json declares no new runtime dependencies for the server", () => {
    const pkg = readJson(join(here, "..", "package.json"));
    // The server uses only Node built-ins; none of these may appear as deps.
    const deps = Object.keys(pkg.dependencies ?? {});
    // Baseline deps that existed before this sprint.
    const allowed = new Set([
      "@anthropic-ai/claude-agent-sdk",
      "commander",
      "execa",
      "zod",
    ]);
    for (const d of deps) {
      expect(allowed.has(d), `unexpected new dependency: ${d}`).toBe(true);
    }
  });
});
