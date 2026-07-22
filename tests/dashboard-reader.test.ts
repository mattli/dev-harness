import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleDashboardData,
  findLatestRunDir,
  resolveAndAssemble,
} from "../src/dashboard/reader.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures", "dashboard");
const fx = (name: string) => join(fixtures, name);

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const lastTraceLine = (dir: string) => {
  const lines = readFileSync(join(dir, "trace.jsonl"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
};

// A fixed clock so elapsed math is deterministic.
const NOW = Date.parse("2026-07-21T10:30:00.000Z");

describe("assembleDashboardData — c1 import-safety & plain object", () => {
  test("returns a plain object on the complete fixture", () => {
    const result = assembleDashboardData(fx("complete"), NOW);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
    expect(Array.isArray(result)).toBe(false);
  });

  test("module source imports only Node stdlib — no http/server/harness entrypoint", () => {
    const src = readFileSync(join(here, "..", "src", "dashboard", "reader.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      const isStdlib = spec.startsWith("node:");
      const isTypeOnlyLocalType = /\.\.\/(state|trace)\/types\.js$/.test(spec);
      expect(isStdlib || isTypeOnlyLocalType).toBe(true);
    }
    expect(src).not.toMatch(/["']node:http["']/);
    expect(src).not.toMatch(/claude-agent-sdk/);
    expect(src).not.toMatch(/from\s+["']\.\.\/(cli|orchestrator|agents)\//);
  });
});

describe("assembleDashboardData — c2 field mapping on complete fixture", () => {
  const state = readJson(join(fx("complete"), "state.json"));
  const last = lastTraceLine(fx("complete"));
  const result = assembleDashboardData(fx("complete"), NOW);

  test("last trace line is a non-EVALUATE phase (proves last-line-wins)", () => {
    expect(last.phase).not.toBe("EVALUATE");
  });

  test("maps each enumerated field to state / last-trace-line", () => {
    expect(result.runId).toBe(state.runId);
    expect(result.goal).toBe(state.goal);
    expect(result.currentSprint).toBe(state.currentSprint);
    expect(result.currentSprintTitle).toBe(state.sprints[state.currentSprint].title);
    expect(result.contractVersion).toBe(state.contractVersion);
    expect(result.phase).toBe(last.phase);
    expect(result.status).toBe(state.status);
    expect(result.haltReason).toBe(state.haltReason);
    expect(result.contractFreezeReason).toBe(state.contractFreezeReason);
    expect(result.budgetSpentUsd).toBe(state.budgetSpentUsd);
    expect(result.startedAt).toBe(state.startedAt);
    expect(result.degraded).toBe(false);
  });

  test("exposes all the stable keys", () => {
    for (const key of [
      "runId", "goal", "currentSprint", "currentSprintTitle", "totalSprints",
      "sprintBreakdown", "contractVersion",
      "phase", "status", "haltReason", "contractFreezeReason", "budgetSpentUsd",
      "startedAt", "elapsedMs", "scores", "degraded",
    ]) {
      expect(result).toHaveProperty(key);
    }
  });
});

describe("assembleDashboardData — sprint breakdown (count, rounds, description, score)", () => {
  const state = readJson(join(fx("complete"), "state.json"));
  const result = assembleDashboardData(fx("complete"), NOW);

  test("totalSprints equals the planned sprint count", () => {
    expect(result.totalSprints).toBe(state.sprints.length);
  });

  test("one breakdown row per planned sprint, in order, with title + description", () => {
    expect(result.sprintBreakdown).toHaveLength(state.sprints.length);
    result.sprintBreakdown.forEach((row, i) => {
      expect(row.index).toBe(i);
      expect(row.title).toBe(state.sprints[i].title);
      expect(row.description).toBe(state.sprints[i].description ?? null);
    });
  });

  test("rounds = the frozen contractVersion on each sprint's NEGOTIATE event", () => {
    const negBySprint = new Map<number, number>();
    for (const l of readFileSync(join(fx("complete"), "trace.jsonl"), "utf8")
      .split("\n").map((x) => x.trim()).filter(Boolean).map((x) => JSON.parse(x))) {
      if (l.phase === "NEGOTIATE") negBySprint.set(l.sprint, l.contractVersion);
    }
    for (const row of result.sprintBreakdown) {
      expect(row.rounds).toBe(negBySprint.has(row.index) ? negBySprint.get(row.index) : null);
    }
  });

  test("score = the sprint's latest EVALUATE score; current flag marks currentSprint", () => {
    // sprint 0 was evaluated 72 then 88 (retry) → latest 88; sprint 1 → 91.
    const byIndex = Object.fromEntries(result.sprintBreakdown.map((r) => [r.index, r]));
    expect(byIndex[0].score).toBe(88);
    expect(byIndex[1].score).toBe(91);
    expect(byIndex[state.currentSprint].current).toBe(true);
  });
});

describe("assembleDashboardData — c3 per-sprint scores", () => {
  test("derives from EVALUATE events in trace order on the complete fixture", () => {
    const dir = fx("complete");
    const evalLines = readFileSync(join(dir, "trace.jsonl"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.phase === "EVALUATE" && typeof e.score === "number")
      .map((e) => ({ sprint: e.sprint, score: e.score }));
    const result = assembleDashboardData(dir, NOW);
    expect(result.scores).toEqual(evalLines);
  });

  test("falls back to flat state.scores[] with null sprint when no EVALUATE lines", () => {
    const dir = fx("scores-fallback");
    const state = readJson(join(dir, "state.json"));
    const result = assembleDashboardData(dir, NOW);
    expect(result.scores).toEqual(state.scores.map((score: number) => ({ sprint: null, score })));
  });
});

describe("assembleDashboardData — c4 elapsedMs", () => {
  test("a FINISHED run freezes elapsed at its real length (last trace ts − startedAt), not now", () => {
    // complete fixture: status "passed", startedAt 10:00:00Z, last trace ts 10:00:08Z.
    const state = readJson(join(fx("complete"), "state.json"));
    const started = Date.parse(state.startedAt);
    const lastTs = Date.parse("2026-07-21T10:00:08.000Z");
    const r1 = assembleDashboardData(fx("complete"), NOW);
    expect(r1.elapsedMs).toBe(lastTs - started); // 8000ms — the actual duration

    // Advancing the wall clock must NOT change a finished run's duration.
    const later = NOW + 60_000;
    const r2 = assembleDashboardData(fx("complete"), later);
    expect(r2.elapsedMs).toBe(r1.elapsedMs);
  });

  test("a LIVE run counts up: now − startedAt, and advances with the clock", () => {
    // partial fixture: status "running".
    const state = readJson(join(fx("partial"), "state.json"));
    const started = Date.parse(state.startedAt);
    const r1 = assembleDashboardData(fx("partial"), NOW);
    expect(r1.elapsedMs).toBe(NOW - started);

    const later = NOW + 60_000;
    const r2 = assembleDashboardData(fx("partial"), later);
    expect(r2.elapsedMs).toBe(later - started);
    expect(r2.elapsedMs).not.toBe(r1.elapsedMs);
  });

  test("is null (never NaN) when startedAt is absent/unparseable", () => {
    const corrupt = assembleDashboardData(fx("corrupt"), NOW);
    expect(corrupt.elapsedMs).toBeNull();

    // Explicit unparseable startedAt in a temp run dir.
    const dir = mkdtempSync(join(tmpdir(), "dash-badtime-"));
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({ runId: "x", startedAt: "not-a-date", sprints: [], scores: [] }),
    );
    const r = assembleDashboardData(dir, NOW);
    expect(r.elapsedMs).toBeNull();
    expect(Number.isNaN(r.elapsedMs as unknown as number)).toBe(false);
  });
});

describe("findLatestRunDir — c5 auto-discovery", () => {
  test("returns the most-recently-modified sub-directory", () => {
    const runs = mkdtempSync(join(tmpdir(), "dash-runs-"));
    const older = join(runs, "older");
    const newer = join(runs, "newer");
    mkdirSync(older);
    mkdirSync(newer);
    const t = Date.now() / 1000;
    utimesSync(older, t - 1000, t - 1000);
    utimesSync(newer, t, t);
    expect(findLatestRunDir(runs)).toBe(newer);
  });

  test("returns null for an empty dir and a nonexistent path (no throw)", () => {
    const empty = mkdtempSync(join(tmpdir(), "dash-empty-"));
    expect(() => findLatestRunDir(empty)).not.toThrow();
    expect(findLatestRunDir(empty)).toBeNull();

    const missing = join(tmpdir(), "dash-does-not-exist-" + Math.random());
    expect(() => findLatestRunDir(missing)).not.toThrow();
    expect(findLatestRunDir(missing)).toBeNull();
  });

  test("resolveAndAssemble uses the latest run when no explicit path is given", () => {
    const runs = mkdtempSync(join(tmpdir(), "dash-resolve-"));
    const only = join(runs, "only");
    mkdirSync(only);
    writeFileSync(
      join(only, "state.json"),
      JSON.stringify({
        runId: "resolved", goal: "g", startedAt: "2026-07-21T10:00:00.000Z",
        status: "running", sprints: [{ id: 0, title: "T", description: "d" }],
        currentSprint: 0, contractVersion: 1, scores: [],
      }),
    );
    const result = resolveAndAssemble({ runsDir: runs, nowMs: NOW });
    expect(result.runId).toBe("resolved");
    expect(result.degraded).toBe(false);
  });
});

describe("graceful degradation — c6", () => {
  test("(a) missing-fields: optional fields null, degraded false", () => {
    let result!: ReturnType<typeof assembleDashboardData>;
    expect(() => { result = assembleDashboardData(fx("missing-fields"), NOW); }).not.toThrow();
    expect(result.budgetSpentUsd).toBeNull();
    expect(result.runDir).toBeNull();
    expect(result.degraded).toBe(false);
  });

  test("(b) mid-run partial: status preserved, degraded false, fields mapped", () => {
    const state = readJson(join(fx("partial"), "state.json"));
    let result!: ReturnType<typeof assembleDashboardData>;
    expect(() => { result = assembleDashboardData(fx("partial"), NOW); }).not.toThrow();
    expect(result.status).toBe("running");
    expect(result.degraded).toBe(false);
    expect(result.currentSprint).toBe(state.currentSprint);
    expect(result.currentSprintTitle).toBe(state.sprints[state.currentSprint].title);
  });

  test("(c) corrupt/half-written state.json: non-null object, degraded true", () => {
    let result!: ReturnType<typeof assembleDashboardData>;
    expect(() => { result = assembleDashboardData(fx("corrupt"), NOW); }).not.toThrow();
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
    expect(result.degraded).toBe(true);
  });

  test("(d) empty/absent trace.jsonl: phase null, no throw", () => {
    // Absent trace via the no-trace fixture.
    let result!: ReturnType<typeof assembleDashboardData>;
    expect(() => { result = assembleDashboardData(fx("no-trace"), NOW); }).not.toThrow();
    expect(result.phase).toBeNull();

    // Empty trace via a temp dir.
    const dir = mkdtempSync(join(tmpdir(), "dash-emptytrace-"));
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify({
        runId: "e", goal: "g", startedAt: "2026-07-21T10:00:00.000Z",
        status: "running", sprints: [{ id: 0, title: "T", description: "d" }],
        currentSprint: 0, contractVersion: 1, scores: [],
      }),
    );
    writeFileSync(join(dir, "trace.jsonl"), "");
    const r = assembleDashboardData(dir, NOW);
    expect(r.phase).toBeNull();
  });
});

describe("fixtures — c7 presence & readability", () => {
  test("complete fixture has EVALUATE lines and a non-EVALUATE last line", () => {
    const lines = readFileSync(join(fx("complete"), "trace.jsonl"), "utf8")
      .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((e) => e.phase === "EVALUATE")).toBe(true);
    expect(lines[lines.length - 1].phase).not.toBe("EVALUATE");
  });

  test("partial fixture is running with fewer scores than sprints", () => {
    const state = readJson(join(fx("partial"), "state.json"));
    expect(state.status).toBe("running");
    expect(state.scores.length).toBeLessThan(state.sprints.length);
  });

  test("missing-fields fixture parses and omits the optional fields", () => {
    const state = readJson(join(fx("missing-fields"), "state.json"));
    expect(state.budgetSpentUsd).toBeUndefined();
    expect(state.runDir).toBeUndefined();
  });

  test("corrupt fixture does NOT parse as JSON", () => {
    const text = readFileSync(join(fx("corrupt"), "state.json"), "utf8");
    expect(() => JSON.parse(text)).toThrow();
  });

  test("scores-fallback fixture has populated state.scores and ZERO EVALUATE lines", () => {
    const state = readJson(join(fx("scores-fallback"), "state.json"));
    expect(state.scores.length).toBeGreaterThan(0);
    const lines = readFileSync(join(fx("scores-fallback"), "trace.jsonl"), "utf8")
      .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((e) => e.phase === "EVALUATE")).toBe(false);
  });
});
