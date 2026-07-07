<!--
Post-fix verification run, 2026-07-07. Regenerated live to VERIFY (not trust) that
the C1/C2 fix (commit 2bdbf27) actually works. Full suite run with the gated E2E:

  RUN_E2E=1 npx vitest run   →  15 files, 46 tests, all PASSED (0 skipped)
  Duration 228s, spend ~$0.86 (loop) + ~$0.02 (discrimination probe).

Verdict: C1/C2 guarantee VERIFIED.
  - C1 (generator receives goal): the loop built the ON-GOAL artifact — a committed
    file on the surviving run/ branch references "sum" and implements a + b. Not the
    off-goal isPalindrome.js/slugify.js a pre-fix run committed.
  - C2 (evaluator judges the artifact, not the verifier boolean): the gated
    discrimination test passed, and a direct probe of evaluateArtifact against the
    same frozen contract scored on-goal sum.js = 100 and off-goal-but-test-green
    isPalindrome.js = 0 → gap 100 (assertion floor is >85 / <85 / gap>=20).

Reproduce: RUN_E2E=1 npx vitest run
-->

# Verification run — e2e (2026-07-07)

Goal: "Add sum.js exporting sum(a,b)=a+b with a passing node:test"
Result: status=passed, scores [100, 98], spent $0.86, haltReason=none

## Sprint 0
### PLAN — planner (contract v0)
- out: 2 sprints
### NEGOTIATE — system (contract v2)
- out: frozen
### GENERATE — generator (contract v2)
- tokens: 1023, cost: $0.3530
- tools: Bash, Write, Write, Write, Bash
### EVALUATE — evaluator (contract v2)
- out: score 100
### DECIDE — system (contract v2)
- out: advance (score 100)

## Sprint 1
### NEGOTIATE — system (contract v2)
- out: frozen
### GENERATE — generator (contract v2)
- tokens: 1442, cost: $0.5058
- tools: Write, Bash, Bash, Read, Read, Write, Write, Bash
### EVALUATE — evaluator (contract v2)
- out: score 98
### DECIDE — system (contract v2)
- out: advance (score 98)

## C2 discrimination probe (same frozen on-goal contract, both artifacts test-green)
- on-goal  sum.js          → score 100
- off-goal isPalindrome.js → score 0
- gap 100  (test asserts on>85, off<85, gap>=20)
