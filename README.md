# dev-harness

An agentic dev-loop harness that drives a real Claude agent to iteratively write, verify, and evaluate code against a goal — stopping when it passes or a hard cap is reached.

## Install

```bash
npm install
```

Node 22+ required.

## Usage

```bash
npm run loop -- run --goal "Add sum.js exporting sum(a,b)=a+b with a passing node:test" --project ~/app
```

### What happens

1. **Plan** — a planner agent breaks the goal into sprints.
2. **Negotiate** — generator and evaluator agents agree on a contract (acceptance criteria).
3. **Generate → Verify → Evaluate** — the generator writes code in a git worktree; a deterministic verifier runs your test command; the evaluator scores the artifact.
4. The loop advances to the next sprint when the score exceeds `advanceScore` (default 85).

### Where things land

- **Branch:** `run/<slug>-<runId>` is left in your project repo after the run (never auto-merged — human merge gate).
- **Transcript:** `runs/<runId>/transcript.md` — rendered markdown of every agent turn.
- **State:** `runs/<runId>/state.json` — durable JSON state (survives crashes).
- **Trace:** `runs/<runId>/trace.jsonl` — JSONL event log of every phase.

## Hard stops (four caps)

The loop halts (status `halted`) if any of these are reached:

| Cap | Default | Flag |
|-----|---------|------|
| Dollar ceiling | $10 | `--dollar-ceiling` |
| Iterations per sprint | 6 | `--max-iterations` |
| Wall clock | 30 min | `--wall-clock-ms` |
| No-progress window | 2 sprints with delta < 5 pts | (thresholds config) |

## v1 caveat — attended, no Docker

v1 runs entirely in a git worktree on your local machine. It is designed for attended use (you watch it and can cancel). There is no Docker execution isolation in v1 — the generator agent runs shell commands directly in the worktree. Sandboxing / Docker wrapping is scoped to Phase 2.

## Smoke test (E2E, real SDK, real cost)

The E2E smoke test is gated behind `RUN_E2E=1` so it is skipped in the normal test suite (free/deterministic):

```bash
# Default — E2E is skipped, all unit tests run
npm test

# Run the live E2E once (~few cents, requires ANTHROPIC_API_KEY)
RUN_E2E=1 npx vitest run tests/e2e.smoke.test.ts
```

The test spins up a temp git repo, sets goal `"Add sum.js exporting sum(a,b)=a+b with a passing node:test"`, caps spend at $2 / 3 iterations / 5 min, and asserts `status ∈ {passed, halted}`.

## Configuration

All caps and thresholds can be overridden via CLI flags or programmatically through `loadConfig`. See `src/config/defaults.ts` for all defaults.
