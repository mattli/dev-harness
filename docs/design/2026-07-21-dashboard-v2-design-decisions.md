---
created_at: 2026-07-21
last_updated: 2026-07-21
type: design-decisions
status: design complete — build pending
related:
  - 2026-07-21-readonly-dashboard-goal.md
  - 2026-07-21-dashboard-v2-prototype.html
---

# Dev-harness live dashboard — v2 design decisions

Interactive prototype (persists): https://claude.ai/code/artifact/c28b9ba6-38b6-4bd7-9c29-9a6cee4e5c9a
Prototype file: `2026-07-21-dashboard-v2-prototype.html` (this folder)

## Context
The harness run `mruxypns` built a working but **plain v1** dashboard (branch
`run-mruxypns`, passed, not merged). This session redesigned it collaboratively
via a throwaway visual prototype. These are the decisions the real build should
follow. Everything here is derivable from `state.json` + `trace.jsonl` — the
dashboard stays a **strictly read-only** reader; nothing here changes what a run
emits.

## Header (top of page)
- **Identity line:** `<repo>` · `Run ID: <hash>` · status pill. Repo name leads
  (the bare hash "mv0k3p2q" tells Matt nothing on its own).
- **Run progress strip**, directly under the identity line, **full-width**:
  `Plan → Generate → Done`. Coarse and **monotonic (forward-only)** — deliberately
  NO per-sprint segments (phases repeat per sprint and would make the bar bounce
  backward). "Generate" is Matt's chosen name for the whole build phase. Colored by
  outcome: green when Passed, amber ("Paused") when Halted.
- **Goal:** the one-line goal is **lifted verbatim** from the goal doc's opening
  line (NOT AI-summarized). It shows prominently **only on the Planning state**;
  every other state shows a small "View goal" link. The **full goal opens on its
  own page**, rendered as formatted markdown (headings/lists) — never a raw
  monospace dump.

## Per-state behavior
- **Planning:** goal prominent; strip at Plan; "breaking the goal into sprints…"
  placeholder; **no stats tiles** (sprint count doesn't exist yet, and
  elapsed/spend are near-zero noise — the whole stats row appears only once a plan
  lands).
- **Live:** Generate lit; sprint cards, with the active sprint showing the phase
  pipeline `Negotiate → Generate → Evaluate → Decide` and its current phase.
- **Passed / Halted (= "Done"):** final stats; resolved sprint cards; an **output
  pointer** ("branch `run-<id>` in `<repo>`, ready to review — nothing was merged");
  on a pause, a plain-language **halt banner**.

## Stats tiles
`Sprint X / N`, `Elapsed` (relabels to `Duration` when finished), `Spend` (2
decimals). Absent entirely during Planning.

## Sprint cards
- **Header:** title + score (score only when done; "best N" when halted).
- **Description** (the plan-time blurb).
- Active sprint: the **phase pipeline**.
- **Quiet metrics sub-line** (full words, NOT tooltips — viewed on phone/SSH where
  hover doesn't exist): `<N> negotiation rounds · <N> build attempts · <N> file
  edits · $<cost>`.
  - **negotiation rounds** = frozen `contractVersion` (from the sprint's NEGOTIATE
    trace event).
  - **build attempts** = the generate→evaluate loop count. DERIVE by counting
    GENERATE trace events per sprint — `state.iterations` is **not** persisted (see
    Latent finding).
  - **file edits** = count of `Edit` tool calls in the sprint's GENERATE event(s)
    (`toolCalls`). (Same source the transcript's "revised N times" uses.)
  - **cost** = summed `costUsd` per sprint from the trace.

## Halt reasons — translate the code to plain language
Raw `haltReason` is a terse code; the dashboard must map each to a sentence
("product surface, not debug log"). Codes come from `src/budget/tracker.ts`
`StopReason` + the parse-error fault:
- `wall-clock`, `max-iteration`, `no-progress`, `usage-limit`, `dollar-ceiling`
  → all "**Paused**" (graceful).
- `evaluator-parse-error` → "**Stopped**" — a fault, not a normal pause.
- Exact wording is in the prototype's `HALT_REASONS` map.

## Update cadence (set expectations honestly)
- Elapsed **freezes** at the real run length when finished; counts up while running.
  (Already coded on the branch.)
- Numbers update live via the ~2s poll but **in steps at stage boundaries** — the
  dashboard is a pure reader, and the run writes one record per completed stage.
  Smooth per-edit / per-round live ticking would require the harness to emit finer
  progress events = out of scope for the read-only dashboard.

## Latent finding (small harness gap)
`state.iterations` is initialized to 0 in `run.ts` and **never updated** — the
persisted value stays 0. So "build attempts" must be derived from the trace, not
read from state. Worth a tiny harness fix on its own.

## Next steps
1. **Port this design into the real dashboard** (`src/dashboard/server.ts`
   `renderPage` + reader derivations for the three metrics, per-sprint cost, and
   the halt-reason map). Start from branch `run-mruxypns`, which already has the
   elapsed-freeze + per-sprint breakdown groundwork committed.
2. **Always-on Tailscale link + print it on every run** — run one persistent
   dashboard server on the Mac Mini, bound to the Tailscale IP + fixed port,
   auto-discovering the newest run (the reader already has latest-run discovery):
   a single permanent bookmark that shows whatever run is current, from any device.
   **Then have the CLI echo that dashboard URL at the top of every run's output** (a
   one-line print in `src/cli/index.ts`'s run action) so it streams into Claude Code
   each launch, ready to click. One job: the printed link only works if the server
   is up, so build the server first.
