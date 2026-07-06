<!--
Example transcript from a real end-to-end run against the Claude Agent SDK,
regenerated 2026-07-06 after the C1/C2 fixes AND the trace-accuracy fix (blocker #2).

  Goal:   "Add sum.js exporting sum(a,b)=a+b with a passing node:test"
  Caps:   dollarCeiling $1, maxIterationsPerSprint 1, negotiationRounds 2, wallClock 3min
  Result: status=halted (wall-clock), scores [100], spent $0.38
  Branch: run/add-sum-js-...  →  committed sum.js (a+b), sum.test.js, package.json (ON-GOAL)

What this run demonstrates:
  - C1: the generator (now given goal+sprint) produced sum.js — on-goal, not the
    off-goal isPalindrome.js/slugify.js that a pre-fix run committed.
  - C2: the evaluator (now given the artifact diff) scored the real work 100.
  - Sprint 0 advances (score 100); Sprint 1 hits the 3-min wall-clock cap DURING
    negotiation → the mid-negotiation backstop halts gracefully (halt:wall-clock).
  - Trace accuracy (blocker #2 fix): distinct "## Sprint 0"/"## Sprint 1" headers and
    correct "contract v2" — previously the whole run collapsed under Sprint 0 / v0.

Reproduce with: RUN_E2E=1 npx vitest run tests/e2e.smoke.test.ts
-->

# Run e2e
## Sprint 0
### PLAN — planner (contract v0)
- tokens: 0, cost: $0.0000
- out: 2 sprints
### NEGOTIATE — system (contract v2)
- out: frozen
### GENERATE — generator (contract v2)
- tokens: 1293, cost: $0.3832
- tools: Read, Bash, Write, Write, Write, Bash
### EVALUATE — evaluator (contract v2)
- out: score 100
### DECIDE — system (contract v2)
- out: advance (score 100)
## Sprint 1
### DECIDE — system (contract v2)
- out: halt:wall-clock
