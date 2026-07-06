<!--
Example transcript from a real end-to-end run against the Claude Agent SDK,
captured 2026-07-06 after the C1/C2 fixes.

  Goal:   "Add sum.js exporting sum(a,b)=a+b with a passing node:test"
  Caps:   dollarCeiling $1, maxIterationsPerSprint 1, negotiationRounds 2, wallClock 3min
  Result: status=passed, scores [100, 96], spent $0.89
  Branch: run/add-sum-js-...  →  committed sum.js (a+b), sum.test.js, package.json

This is a faithful ON-GOAL example: the generator (now given goal+sprint) produced
sum.js, and the evaluator (now given the artifact diff) scored the real work. Before
C1/C2 the same goal produced off-goal isPalindrome.js/slugify.js scored 96/100.
Reproduce with: RUN_E2E=1 npx vitest run tests/e2e.smoke.test.ts
-->

# Run e2e
## Sprint 0
### PLAN — planner (contract v0)
- tokens: 0, cost: $0.0000
- out: 2 sprints
### NEGOTIATE — system (contract v2)
- out: frozen
### GENERATE — generator (contract v0)
- tokens: 977, cost: $0.3525
- tools: Read, Bash, Write, Write, Bash
### EVALUATE — evaluator (contract v0)
- out: score 100
### DECIDE — system (contract v0)
- out: advance (score 100)
### NEGOTIATE — system (contract v2)
- out: frozen
### GENERATE — generator (contract v0)
- tokens: 1899, cost: $0.5358
- tools: Write, Bash, Write, Write, Write, Read, Read, Edit, Edit, Bash
### EVALUATE — evaluator (contract v0)
- out: score 96
### DECIDE — system (contract v0)
- out: advance (score 96)
