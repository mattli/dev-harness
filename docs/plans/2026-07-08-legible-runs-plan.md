# Legible Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DevHarness runs legible to a non-engineer: organize runs into `runs/<project>/<date>-<task>/` folders, and turn the cryptic transcript into a plain-English summary followed by a readable per-stage narrative.

**Architecture:** A pure `reporter` produces the plain-English summary from `RunState`. A pure `run-path` builder produces the readable folder path. The planner gains a short `title`. `runLoop` is reordered so planning happens before the run folder is created (the folder name needs the title). The transcript renderer is rewritten to open with the summary and narrate each stage from data already in the trace.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node fs, execa (git), commander (CLI), zod (config).

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` files (e.g. `../state/types.js`).
- Reuse `slugify` from `src/workspace/worktree.ts` — do not write a second slugifier.
- Summary is descriptive only — no "Next:"/recommendation text anywhere.
- Dates are UTC `YYYY-MM-DD` via `new Date(ms).toISOString().slice(0,10)` for determinism.
- No standalone `summary.md` file — the summary is generated on demand and embedded in the transcript / terminal / `show`.
- Old runs in the flat layout are left untouched; new structure applies going forward.
- Every task ends green: `npx vitest run` passes before committing.

---

### Task 1: Run-path builder (pure)

**Files:**
- Create: `src/state/run-path.ts`
- Test: `tests/run-path.test.ts`

**Interfaces:**
- Consumes: `slugify` from `src/workspace/worktree.ts`.
- Produces:
  - `projectSlug(projectPath: string): string`
  - `runDate(nowMs: number): string`
  - `buildRunDir(runsDir: string, projectPath: string, title: string, nowMs: number, siblings: string[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/run-path.test.ts
import { expect, test } from "vitest";
import { projectSlug, runDate, buildRunDir } from "../src/state/run-path.js";

test("projectSlug uses the project folder's basename, slugified", () => {
  expect(projectSlug("/Users/me/dev/CSV Tool/")).toBe("csv-tool");
  expect(projectSlug("/tmp/x")).toBe("x");
});

test("projectSlug falls back to 'project' for an empty/odd basename", () => {
  expect(projectSlug("/")).toBe("project");
});

test("runDate is UTC YYYY-MM-DD", () => {
  expect(runDate(0)).toBe("1970-01-01");
});

test("buildRunDir composes runs/<project>/<date>-<title>", () => {
  expect(buildRunDir("runs", "/tmp/csv-tool", "CSV JSON Converter", 0, []))
    .toBe("runs/csv-tool/1970-01-01-csv-json-converter");
});

test("buildRunDir suffixes -2, -3 on collision with existing siblings", () => {
  const sibs = ["1970-01-01-csv-json-converter", "1970-01-01-csv-json-converter-2"];
  expect(buildRunDir("runs", "/tmp/csv-tool", "CSV JSON Converter", 0, sibs))
    .toBe("runs/csv-tool/1970-01-01-csv-json-converter-3");
});

test("buildRunDir falls back to 'run' when the title slugifies to empty", () => {
  expect(buildRunDir("runs", "/tmp/csv-tool", "!!!", 0, []))
    .toBe("runs/csv-tool/1970-01-01-run");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/run-path.test.ts`
Expected: FAIL — cannot find module `../src/state/run-path.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/state/run-path.ts
import { basename, join } from "node:path";
import { slugify } from "../workspace/worktree.js";

/** Human-readable project slug from the --project path (its folder name). */
export function projectSlug(projectPath: string): string {
  const base = basename(projectPath.replace(/\/+$/, ""));
  return slugify(base) || "project";
}

/** YYYY-MM-DD for an epoch-ms instant, in UTC (deterministic across machines). */
export function runDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** runs/<project>/<date>-<title>, with -2/-3… appended on collision.
 *  `siblings` is the list of existing entry names under runs/<project>/ — the
 *  caller reads the filesystem so this stays pure and unit-testable. */
export function buildRunDir(
  runsDir: string, projectPath: string, title: string, nowMs: number, siblings: string[],
): string {
  const stem = `${runDate(nowMs)}-${slugify(title) || "run"}`;
  const taken = new Set(siblings);
  let name = stem;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`;
  return join(runsDir, projectSlug(projectPath), name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/run-path.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/state/run-path.ts tests/run-path.test.ts
git commit -m "feat(state): pure run-path builder for readable run folders"
```

---

### Task 2: Reporter + RunState fields

**Files:**
- Modify: `src/state/types.ts` (add `title`, `startedAt` to `RunState`)
- Modify: `src/orchestrator/run.ts:38-42` (initial state literal includes the new fields)
- Create: `src/report/summary.ts`
- Test: `tests/summary.test.ts`

**Interfaces:**
- Consumes: `RunState` from `src/state/types.js`; `slugify` from `src/workspace/worktree.js`.
- Produces:
  - `describeOutcome(state: RunState): string`
  - `renderSummary(state: RunState): string`

- [ ] **Step 1: Add the two fields to RunState**

In `src/state/types.ts`, add `title` and `startedAt` to the `RunState` interface:

```ts
export interface RunState {
  runId: string; goal: string; title: string; startedAt: string; status: RunStatus;
  sprints: Sprint[]; currentSprint: number; contractVersion: number;
  scores: number[]; iterations: number; budgetSpentUsd: number;
  haltReason: string | null;
  contractFreezeReason: FreezeReason | null;
}
```

- [ ] **Step 2: Keep run.ts compiling — set the new fields at init**

In `src/orchestrator/run.ts`, the initial `state` literal (currently lines 38-42) must include the new fields. Change it to:

```ts
  const state: RunState = {
    runId: config.runId, goal: config.goal, title: config.goal,
    startedAt: new Date(deps.nowMs()).toISOString(), status: "running", sprints: [],
    currentSprint: 0, contractVersion: 0, scores: [], iterations: 0,
    budgetSpentUsd: 0, haltReason: null, contractFreezeReason: null,
  };
```

(`title` defaults to the goal here; Task 3 replaces it with the AI title. `startedAt` is final.)

- [ ] **Step 3: Write the failing test**

```ts
// tests/summary.test.ts
import { expect, test } from "vitest";
import { renderSummary, describeOutcome } from "../src/report/summary.js";
import type { RunState } from "../src/state/types.js";

const base = (over: Partial<RunState> = {}): RunState => ({
  runId: "abc", goal: "Build a CSV converter", title: "csv-json-converter",
  startedAt: "2026-07-08T14:00:00.000Z", status: "halted",
  sprints: [{ id: 0, title: "a", description: "" }, { id: 1, title: "b", description: "" },
            { id: 2, title: "c", description: "" }, { id: 3, title: "d", description: "" }],
  currentSprint: 3, contractVersion: 5, scores: [100, 98, 96], iterations: 3,
  budgetSpentUsd: 6.8, haltReason: "dollar-ceiling", contractFreezeReason: "agreement", ...over,
});

test("dollar-ceiling summary names the limit and spend, and gives no advice", () => {
  const s = renderSummary(base());
  expect(s).toContain("csv-json-converter — 2026-07-08");
  expect(s).toContain("Stopped early — hit the spending limit ($6.80)");
  expect(s).toContain("Progress: 3 of 4 stages finished");
  expect(s).toContain("scored 100, 98, 96 out of 100");
  expect(s).toContain("Spent:    $6.80");
  expect(s).toContain("branch run/build-a-csv-converter-abc");
  expect(s).not.toMatch(/next/i); // descriptive only, no recommendations
});

test("passed run reports success and all stages finished", () => {
  const s = renderSummary(base({ status: "passed", haltReason: null, currentSprint: 3 }));
  expect(s).toContain("Finished successfully — all stages passed");
  expect(s).toContain("Progress: 4 of 4 stages finished");
});

test("describeOutcome maps each halt code to plain English", () => {
  expect(describeOutcome(base({ haltReason: "wall-clock" }))).toContain("time limit");
  expect(describeOutcome(base({ haltReason: "max-iteration" }))).toContain("retry limit");
  expect(describeOutcome(base({ haltReason: "no-progress" }))).toContain("stopped improving");
  expect(describeOutcome(base({ haltReason: "evaluator-parse-error" }))).toContain("grading error");
});

test("an unknown halt code degrades gracefully instead of throwing", () => {
  expect(describeOutcome(base({ haltReason: "some-new-reason" }))).toBe("Stopped — some-new-reason");
});

test("a run with no scores yet says so", () => {
  expect(renderSummary(base({ scores: [] }))).toContain("no stages scored yet");
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/summary.test.ts`
Expected: FAIL — cannot find module `../src/report/summary.js`.

- [ ] **Step 5: Write the implementation**

```ts
// src/report/summary.ts
import type { RunState } from "../state/types.js";
import { slugify } from "../workspace/worktree.js";

const HALT_TEXT: Record<string, string> = {
  "dollar-ceiling": "Stopped early — hit the spending limit",
  "wall-clock": "Stopped early — hit the time limit",
  "max-iteration": "Stopped — no improvement after the retry limit",
  "no-progress": "Stopped — the score stopped improving",
  "evaluator-parse-error": "Stopped — an internal grading error",
};

/** One plain-English sentence describing how the run ended. No recommendations. */
export function describeOutcome(state: RunState): string {
  if (state.status === "passed") return "Finished successfully — all stages passed";
  if (state.status === "running") return "Still running";
  const reason = state.haltReason ?? "unknown";
  const base = HALT_TEXT[reason] ?? `Stopped — ${reason}`;
  if (reason === "dollar-ceiling") return `${base} ($${state.budgetSpentUsd.toFixed(2)})`;
  return base;
}

/** The plain-English summary block. Single source for the transcript header,
 *  the terminal print, and the `show` command. Descriptive only. */
export function renderSummary(state: RunState): string {
  const total = state.sprints.length;
  const finished = state.status === "passed" ? total : state.currentSprint;
  const quality = state.scores.length
    ? `scored ${state.scores.join(", ")} out of 100`
    : "no stages scored yet";
  const branch = `run/${slugify(state.goal)}-${state.runId}`;
  return [
    `${state.title || state.goal} — ${state.startedAt.slice(0, 10)}`,
    `Outcome:  ${describeOutcome(state)}`,
    `Progress: ${finished} of ${total} stages finished`,
    `Quality:  ${quality}`,
    `Spent:    $${state.budgetSpentUsd.toFixed(2)}`,
    `Code:     saved on branch ${branch} in the target project`,
    "",
  ].join("\n");
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/summary.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Verify the whole suite still compiles/passes**

Run: `npx vitest run`
Expected: PASS (RunState field additions did not break existing tests).

- [ ] **Step 8: Commit**

```bash
git add src/state/types.ts src/orchestrator/run.ts src/report/summary.ts tests/summary.test.ts
git commit -m "feat(report): plain-English run summary + title/startedAt state fields"
```

---

### Task 3: Planner emits a short title

**Files:**
- Modify: `src/agents/planner.ts` (`planSprints` → `planRun` returning `{ title, sprints }`)
- Modify: `prompts/planner.md` (ask for a JSON object with `title` + `sprints`)
- Modify: `src/orchestrator/run.ts` (`LoopDeps.planSprints` → `planRun`; store the title)
- Modify: `src/cli/wire.ts` (wire `planRun`)
- Modify: `tests/agents.test.ts` (planner test)
- Modify: `tests/orchestrator.test.ts` (fake dep rename)

**Interfaces:**
- Consumes: `invokeAgent`, `loadPrompt`, `Sprint`.
- Produces: `planRun(deps: PlannerDeps): Promise<{ title: string; sprints: Sprint[] }>` and exported `PlanResult` type. `LoopDeps.planRun: (goal: string) => Promise<{ title: string; sprints: Sprint[] }>`.

- [ ] **Step 1: Update the planner test (failing)**

Replace the `"planner parses sprint JSON"` test in `tests/agents.test.ts` and its import:

```ts
// change the import at top:
import { planRun } from "../src/agents/planner.js";

// replace the old planner test with:
test("planner parses the title and sprint array", async () => {
  const q = fakeStream('{"title":"csv-json-converter","sprints":[{"title":"S1","description":"do a"},{"title":"S2","description":"do b"}]}');
  const plan = await planRun({ queryFn: q, model: "m", goal: "g" });
  expect(plan.title).toBe("csv-json-converter");
  expect(plan.sprints).toHaveLength(2);
  expect(plan.sprints[0].id).toBe(0);
  expect(plan.sprints[1].title).toBe("S2");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/agents.test.ts`
Expected: FAIL — `planRun` is not exported.

- [ ] **Step 3: Implement `planRun`**

Replace the body of `src/agents/planner.ts`:

```ts
import { invokeAgent, type QueryFn } from "./invoke.js";
import { loadPrompt } from "./prompts.js";
import type { Sprint } from "../state/types.js";

export interface PlannerDeps { queryFn: QueryFn; model: string; goal: string; }
export interface PlanResult { title: string; sprints: Sprint[]; }

export async function planRun(deps: PlannerDeps): Promise<PlanResult> {
  const res = await invokeAgent({
    queryFn: deps.queryFn, model: deps.model,
    systemPrompt: loadPrompt("planner"),
    prompt: `Goal: ${deps.goal}`,
  });
  // Parse the JSON object and key on its labelled fields (not positional
  // scanning of prose) — see the project lesson on emitting a marker.
  const json = res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1);
  const obj = JSON.parse(json) as { title: string; sprints: Array<{ title: string; description: string }> };
  return {
    title: obj.title,
    sprints: obj.sprints.map((s, id) => ({ id, title: s.title, description: s.description })),
  };
}
```

- [ ] **Step 4: Update the planner prompt**

Replace `prompts/planner.md` with:

```markdown
You are the PLANNER in an adversarial development loop. Given a one-line goal,
produce COARSE, high-level sprints — deliberately not granular, because a
planning error at this level cascades through every sprint.

Also produce a short `title`: 3–4 words, lowercase, describing the goal (it names
the run's folder, e.g. "csv json converter").

Output ONLY a JSON object of the form:
{"title": "...", "sprints": [{"title": "...", "description": "..."}]}
3–6 sprints. No prose outside the JSON.
```

- [ ] **Step 5: Rename the dep in `run.ts` and store the title**

In `src/orchestrator/run.ts`:
- In `LoopDeps`, change `planSprints: (goal: string) => Promise<Sprint[]>;` to `planRun: (goal: string) => Promise<{ title: string; sprints: Sprint[] }>;`
- At the current planning call (line 81-83), change:

```ts
    const { title, sprints } = await deps.planRun(config.goal);
    update({ title, sprints });
    traceEvent({ phase: "PLAN", agentRole: "planner", outputDigest: `${sprints.length} sprints` });
```

(The folder path still uses the old scheme in this task — reordering is Task 4.)

- [ ] **Step 6: Wire it in `wire.ts`**

In `src/cli/wire.ts`, change the import `import { planSprints } from "../agents/planner.js";` to `import { planRun } from "../agents/planner.js";` and the dep line to:

```ts
    planRun: (g) => planRun({ queryFn, model: config.models.planner, goal: g }),
```

- [ ] **Step 7: Update the orchestrator fake dep**

In `tests/orchestrator.test.ts`, in `happyDeps()` replace the `planSprints` line with:

```ts
  planRun: async () => ({ title: "test-run", sprints: [{ id: 0, title: "S", description: "d" }] }),
```

And in the `"multi-sprint run…"` test, replace its `planSprints:` override with:

```ts
    planRun: async () => ({ title: "test-run", sprints: [
      { id: 0, title: "S0", description: "d0" },
      { id: 1, title: "S1", description: "d1" },
    ] }),
```

- [ ] **Step 8: Run the whole suite**

Run: `npx vitest run`
Expected: PASS (agents + orchestrator green with the renamed dep).

- [ ] **Step 9: Commit**

```bash
git add src/agents/planner.ts prompts/planner.md src/orchestrator/run.ts src/cli/wire.ts tests/agents.test.ts tests/orchestrator.test.ts
git commit -m "feat(planner): emit a short run title; thread it through the loop"
```

---

### Task 4: Reorder runLoop to write the readable folder path

**Files:**
- Modify: `src/orchestrator/run.ts` (plan before creating stores; build runDir from the title)
- Modify: `tests/orchestrator.test.ts` (read artifacts from the new path)

**Interfaces:**
- Consumes: `buildRunDir`, `projectSlug` from `src/state/run-path.js`.
- Produces: run artifacts at `runs/<project>/<date>-<title>/` (the internal `runId` still identifies the run in `state.json` and the branch).

- [ ] **Step 1: Update orchestrator tests to expect the new path (failing)**

At the top of `tests/orchestrator.test.ts` add:

```ts
import { buildRunDir } from "../src/state/run-path.js";
```

Add a helper near `cfg`:

```ts
// The run folder the loop will create, given a fake planRun title of "test-run"
// and nowMs()=0. Config carries projectPath + runId; siblings start empty.
const runDirOf = (config: { projectPath: string }, runsDir: string) =>
  buildRunDir(runsDir, config.projectPath, "test-run", 0, []);
```

Then update every `readFileSync(join(runsDir, "r1", "…"))` in this file to read from `runDirOf`. Because these tests need the resolved `config`, refactor each affected test to hold the config, e.g.:

```ts
test("multi-sprint run records distinct sprint numbers + contract versions in trace/transcript", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const config = cfg();
  const deps: LoopDeps = {
    ...happyDeps(), runsDir,
    planRun: async () => ({ title: "test-run", sprints: [
      { id: 0, title: "S0", description: "d0" }, { id: 1, title: "S1", description: "d1" },
    ] }),
  };
  const state = await runLoop(config, deps);
  expect(state.status).toBe("passed");
  const dir = runDirOf(config, runsDir);
  const trace = readFileSync(join(dir, "trace.jsonl"), "utf8")
    .trim().split("\n").map((l) => JSON.parse(l));
  const gen = trace.filter((e) => e.phase === "GENERATE");
  expect([...new Set(gen.map((e) => e.sprint))].sort()).toEqual([0, 1]);
  expect(gen.every((e) => e.contractVersion > 0)).toBe(true);
  const transcript = readFileSync(join(dir, "transcript.md"), "utf8");
  expect(transcript).toContain("Stage 0");
  expect(transcript).toContain("Stage 1");
});
```

Apply the same `config` + `runDirOf` pattern to the `"round-cap"` and `"NEGOTIATE …criteria"` tests (they also `readFileSync(join(runsDir, "r1", …))`). Leave their non-path assertions; Task 5 adjusts transcript-content assertions.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: FAIL — files not found at the new path (loop still writes to `runs/r1`).

- [ ] **Step 3: Reorder `runLoop`**

In `src/orchestrator/run.ts`:
- Add imports: `import { readdirSync } from "node:fs";` and `import { buildRunDir, projectSlug } from "../state/run-path.js";`
- Replace the opening of `runLoop` (currently lines 32-43) so planning happens first and the runDir is derived from the title:

```ts
  const startedAt = new Date(deps.nowMs()).toISOString();
  const plan = await deps.planRun(config.goal);

  const projDir = join(deps.runsDir, projectSlug(config.projectPath));
  const siblings = (() => { try { return readdirSync(projDir); } catch { return []; } })();
  const runDir = buildRunDir(deps.runsDir, config.projectPath, plan.title, deps.nowMs(), siblings);

  const store = new StateStore(join(runDir, "state.json"));
  const trace = new TraceWriter(join(runDir, "trace.jsonl"));
  const budget = new BudgetTracker(config.caps, config.thresholds, deps.nowMs());
  const branch = `run/${slugify(config.goal)}-${config.runId}`;

  const state: RunState = {
    runId: config.runId, goal: config.goal, title: plan.title, startedAt, status: "running",
    sprints: plan.sprints, currentSprint: 0, contractVersion: 0, scores: [], iterations: 0,
    budgetSpentUsd: 0, haltReason: null, contractFreezeReason: null,
  };
  store.init(state);
```

- Delete the now-duplicated planning lines inside the `try` block. The `try` now starts straight into the sprint loop. Replace the old `const sprints = await deps.planRun(...)` / `update({ title, sprints })` / PLAN-trace lines with just the PLAN trace event (sprints are already in state):

```ts
  try {
    traceEvent({ phase: "PLAN", agentRole: "planner", outputDigest: `${plan.sprints.length} sprints` });

    for (const sprint of plan.sprints) {
```

(Everything from `for (const sprint …)` onward is unchanged.)

- [ ] **Step 4: Run the whole suite**

Run: `npx vitest run`
Expected: PASS. (The orchestrator tests now read the real files at the real computed `runs/<project>/<date>-test-run/` path — this is the real-filesystem boundary test for the new layout, per the project lesson.)

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/run.ts tests/orchestrator.test.ts
git commit -m "feat(orchestrator): write runs to runs/<project>/<date>-<title>/"
```

---

### Task 5: Rewrite the transcript as summary + per-stage narrative

**Files:**
- Modify: `src/trace/renderer.ts` (rewrite `renderTranscript` to `(events, state)`)
- Modify: `src/orchestrator/run.ts` (`finalize` passes `state`; both `finalize` call sites)
- Modify: `tests/trace.test.ts` (renderer tests use the new signature + narrative format)
- Modify: `tests/orchestrator.test.ts` (transcript-content assertions for the narrative)

**Interfaces:**
- Consumes: `TraceEvent`, `RunState`, `renderSummary`.
- Produces: `renderTranscript(events: TraceEvent[], state: RunState): string`.

- [ ] **Step 1: Write the failing renderer tests**

Replace the renderer tests in `tests/trace.test.ts`. Keep the two `TraceWriter` tests as-is; replace everything from `test("renderer groups by sprint and phase" …)` onward with:

```ts
import type { RunState } from "../src/state/types.js";

const st = (over: Partial<RunState> = {}): RunState => ({
  runId: "r1", goal: "g", title: "demo", startedAt: "2026-07-08T00:00:00.000Z",
  status: "passed", sprints: [{ id: 0, title: "Scaffolding", description: "" }],
  currentSprint: 0, contractVersion: 1, scores: [100], iterations: 1,
  budgetSpentUsd: 0.72, haltReason: null, contractFreezeReason: "agreement", ...over,
});

test("transcript opens with the plain-English summary", () => {
  const md = renderTranscript([ev({ phase: "PLAN" })], st());
  expect(md).toContain("demo — 2026-07-08");
  expect(md).toContain("Finished successfully — all stages passed");
});

test("transcript narrates a stage with its title, score, cost, and tool counts", () => {
  const md = renderTranscript([
    ev({ phase: "GENERATE", agentRole: "generator", sprint: 0, costUsd: 0.72,
         toolCalls: ["Write", "Write", "Bash"] }),
    ev({ phase: "EVALUATE", agentRole: "evaluator", sprint: 0, outputDigest: "score 100" }),
  ], st());
  expect(md).toContain("Stage 0 — Scaffolding");
  expect(md).toContain("100/100");
  expect(md).toContain("$0.72");
  expect(md).toContain("created 2 files");
  expect(md).toContain("ran 1 command");
});

test("transcript shows a not-reached stage's halt reason and never prints fake $0.0000", () => {
  const s = st({ status: "halted", haltReason: "dollar-ceiling", currentSprint: 1,
    sprints: [{ id: 0, title: "Scaffolding", description: "" },
              { id: 1, title: "Parsing", description: "" }] });
  const md = renderTranscript([
    ev({ phase: "GENERATE", agentRole: "generator", sprint: 0, costUsd: 0.72, toolCalls: ["Write"] }),
    ev({ phase: "EVALUATE", agentRole: "evaluator", sprint: 0, outputDigest: "score 100" }),
    ev({ phase: "DECIDE", agentRole: "system", sprint: 1, outputDigest: "halt:dollar-ceiling" }),
  ], s);
  expect(md).toContain("Stage 1 — Parsing");
  expect(md).toContain("not reached");
  expect(md).not.toContain("$0.0000");
});

test("transcript still surfaces a stage's frozen requirements (criteria)", () => {
  const md = renderTranscript([
    ev({ phase: "NEGOTIATE", agentRole: "system", sprint: 0, outputDigest: "frozen (round-cap)",
         contract: { version: 1, frozen: true,
           criteria: [{ id: "c1", description: "sum(a,b)=a+b", verifyBy: "node:test" }] } }),
    ev({ phase: "EVALUATE", agentRole: "evaluator", sprint: 0, outputDigest: "score 100" }),
  ], st());
  expect(md).toContain("sum(a,b)=a+b");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/trace.test.ts`
Expected: FAIL — `renderTranscript` takes 1 arg / new strings absent.

- [ ] **Step 3: Rewrite the renderer**

Replace `src/trace/renderer.ts` with:

```ts
import type { TraceEvent } from "./types.js";
import type { RunState, Sprint } from "../state/types.js";
import { renderSummary } from "../report/summary.js";

const oneLine = (s: string): string => String(s).replace(/\s*\n\s*/g, " ").trim();

/** Summarize the generator's tool calls into a human sentence, from counts. */
function narrate(toolCalls: string[]): string {
  const count = (t: string) => toolCalls.filter((c) => c === t).length;
  const parts: string[] = [];
  const writes = count("Write");
  const edits = count("Edit");
  const cmds = count("Bash");
  if (writes) parts.push(`created ${writes} file${writes > 1 ? "s" : ""}`);
  if (edits) parts.push(`revised ${edits} time${edits > 1 ? "s" : ""}`);
  if (cmds) parts.push(`ran ${cmds} command${cmds > 1 ? "s" : ""}`);
  return parts.length ? parts.join(", ") : "no file changes recorded";
}

function scoreOf(events: TraceEvent[]): number | null {
  const evalEv = [...events].reverse().find((e) => e.phase === "EVALUATE");
  const m = evalEv?.outputDigest.match(/score\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

function criteriaLines(events: TraceEvent[]): string[] {
  const neg = events.find((e) => e.phase === "NEGOTIATE" && e.contract);
  const criteria = neg?.contract?.criteria ?? [];
  if (!criteria.length) return [];
  return ["  Requirements:", ...criteria.map((c) => `    - ${oneLine(c.description)}`)];
}

function stageBlock(sprint: Sprint, events: TraceEvent[], reached: boolean, haltReason: string | null): string[] {
  if (!reached) {
    return [`## Stage ${sprint.id} — ${sprint.title}   (not reached)`,
      `  Stopped before this stage could start${haltReason ? ` (${haltReason})` : ""}.`, ""];
  }
  const gen = events.find((e) => e.phase === "GENERATE");
  const score = scoreOf(events);
  const cost = gen?.costUsd ?? 0;
  const marker = score === null ? "✗ stopped" : `✓ ${score}/100`;
  return [
    `## Stage ${sprint.id} — ${sprint.title}   [${marker}] · $${cost.toFixed(2)}`,
    `  ${narrate(gen?.toolCalls ?? [])}.`,
    ...criteriaLines(events),
    "",
  ];
}

/** Transcript = the plain-English summary, then a readable per-stage narrative
 *  built from data already in the trace (titles, scores, costs, tool counts). */
export function renderTranscript(events: TraceEvent[], state: RunState): string {
  const lines: string[] = [renderSummary(state), "────────────────────────────────────────────", ""];
  const reachedMax = state.status === "passed" ? state.sprints.length - 1 : state.currentSprint - 1;
  for (const sprint of state.sprints) {
    const stageEvents = events.filter((e) => e.sprint === sprint.id);
    const reached = sprint.id <= reachedMax || stageEvents.some((e) => e.phase === "GENERATE");
    lines.push(...stageBlock(sprint, stageEvents, reached, state.haltReason));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
```

- [ ] **Step 4: Update `finalize` to pass state**

In `src/orchestrator/run.ts`, change `finalize` and both call sites (currently lines 76, 156, 163-167):

```ts
// call sites: finalize(runDir, trace, state);

function finalize(runDir: string, trace: TraceWriter, state: RunState): void {
  const events = readFileSync(join(runDir, "trace.jsonl"), "utf8")
    .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  writeFileSync(join(runDir, "transcript.md"), renderTranscript(events, state));
}
```

Update the two callers: `finalize(runDir, trace);` → `finalize(runDir, trace, state);` (in `haltRun` and after the `passed` update).

- [ ] **Step 5: Update the orchestrator transcript assertions**

In `tests/orchestrator.test.ts`:
- `"round-cap"` test: the narrative still surfaces the freeze reason via criteria/label — change `expect(transcript).toContain("frozen (round-cap)")` to `expect(transcript).toContain("Stage 0")` (freeze-reason-in-state is already asserted separately in that test).
- `"NEGOTIATE …criteria"` test: change `expect(transcript).toContain("c1: sum(a,b)=a+b [verify: node:test]")` to `expect(transcript).toContain("sum(a,b)=a+b")` (criteria now render under "Requirements").

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/trace/renderer.ts src/orchestrator/run.ts tests/trace.test.ts tests/orchestrator.test.ts
git commit -m "feat(trace): transcript opens with summary, narrates each stage"
```

---

### Task 6: CLI — `show` command, run-end summary print, path message

**Files:**
- Create: `src/report/show.ts` (locate + load a past run's state, render its summary)
- Modify: `src/cli/index.ts` (print summary at run end; new `show` command; fix path message)
- Test: `tests/show.test.ts`

**Interfaces:**
- Consumes: `renderSummary`, `projectSlug`, `RunState`.
- Produces:
  - `latestRunSummary(runsDir: string, projectPath: string): string` (throws a clear Error if none)

- [ ] **Step 1: Write the failing test**

```ts
// tests/show.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestRunSummary } from "../src/report/show.js";
import type { RunState } from "../src/state/types.js";

const writeRun = (runsDir: string, proj: string, folder: string, state: Partial<RunState>) => {
  const dir = join(runsDir, proj, folder);
  mkdirSync(dir, { recursive: true });
  const full: RunState = {
    runId: "x", goal: "g", title: "demo", startedAt: "2026-07-08T00:00:00.000Z",
    status: "passed", sprints: [{ id: 0, title: "a", description: "" }], currentSprint: 0,
    contractVersion: 1, scores: [90], iterations: 1, budgetSpentUsd: 1, haltReason: null,
    contractFreezeReason: "agreement", ...state,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(full));
};

test("latestRunSummary renders the most recent run for a project", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  writeRun(runsDir, "csv-tool", "2026-07-06-old", { title: "old-run" });
  writeRun(runsDir, "csv-tool", "2026-07-08-new", { title: "new-run" });
  const out = latestRunSummary(runsDir, "/tmp/csv-tool");
  expect(out).toContain("new-run");
  expect(out).not.toContain("old-run");
});

test("latestRunSummary throws a clear error when the project has no runs", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  expect(() => latestRunSummary(runsDir, "/tmp/nope")).toThrow(/no runs/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/show.test.ts`
Expected: FAIL — cannot find module `../src/report/show.js`.

- [ ] **Step 3: Implement `show.ts`**

```ts
// src/report/show.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "../state/types.js";
import { projectSlug } from "../state/run-path.js";
import { renderSummary } from "./summary.js";

/** Render the summary of a project's most recent run (folders are date-prefixed,
 *  so the lexically-last folder is the newest). Throws if the project has none. */
export function latestRunSummary(runsDir: string, projectPath: string): string {
  const dir = join(runsDir, projectSlug(projectPath));
  let entries: string[];
  try { entries = readdirSync(dir).sort(); } catch { entries = []; }
  if (!entries.length) throw new Error(`no runs found for project at ${projectPath}`);
  const latest = entries[entries.length - 1];
  const state = JSON.parse(readFileSync(join(dir, latest, "state.json"), "utf8")) as RunState;
  return renderSummary(state);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/show.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the CLI**

In `src/cli/index.ts`:
- Add imports: `import { renderSummary } from "../report/summary.js";` and `import { latestRunSummary } from "../report/show.js";`
- In the `run` action, replace the two trailing `console.log` lines (currently 25-26) with:

```ts
    console.log("\n" + renderSummary(state));
```

- Add a `show` command before `program.parseAsync()`:

```ts
program
  .command("show")
  .requiredOption("--project <path>")
  .action((opts) => {
    try {
      console.log(latestRunSummary("runs", opts.project));
    } catch (e) {
      console.error(`[dev-harness] ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });
```

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/report/show.ts src/cli/index.ts tests/show.test.ts
git commit -m "feat(cli): print summary at run end; add `show` command"
```

---

## Self-Review

**Spec coverage:**
- §1 folder structure → Tasks 1 (builder) + 4 (integration). ✓
- §2 AI title → Task 3. ✓
- §3 reporter + three surfaces → Task 2 (engine), Task 5 (transcript header), Task 6 (terminal + `show`). ✓
- §4 transcript narrative → Task 5. ✓
- Non-goals (no summary.md, old runs untouched, no "go deep") → honored; no task writes `summary.md` or migrates old runs. ✓
- Boundary test (real fs) → Task 4 Step 4 note: orchestrator tests read real files at the real computed path. ✓

**Placeholder scan:** none — every code step has full code.

**Type consistency:** `planRun` returns `{ title, sprints }` (Tasks 3-4); `RunState` gains `title`/`startedAt` (Task 2) used by `renderSummary`/`renderTranscript` (Tasks 2, 5); `renderTranscript(events, state)` signature consistent across Task 5 renderer + finalize + tests; `buildRunDir`/`projectSlug` signatures consistent across Tasks 1, 4, 6.

**Open questions resolved:** `show` defaults to most-recent (Task 6); `projectSlug` falls back to `project` for odd basenames (Task 1).
