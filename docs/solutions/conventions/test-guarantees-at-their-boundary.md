---
title: Test Guarantees at Their Real-I/O Boundary
date: 2026-07-06
category: conventions
problem_type: best_practice
module: dev-harness
tags: ["testing", "mocks", "integration-tests", "real-io-boundary", "git", "llm-output", "state-persistence"]
applies_when: "A guarantee holds only at a real-I/O boundary (git, filesystem, network/SDK) but the tests covering it stub that boundary with fakes."
---

# Test Guarantees at Their Real-I/O Boundary

## Context
dev-harness Phase 1 was built subagent-driven with a fresh reviewer per task, and
the unit suite was green throughout. Yet the first real end-to-end run (real git +
real Claude SDK) exposed three separate broken guarantees — each one green in the
unit suite because the tests faked the exact boundary the guarantee lived at.

## Guidance
A guarantee that only holds at a real-I/O boundary needs a test that exercises the
real boundary. A fake that stubs the boundary will satisfy the assertion while the
real system violates the guarantee. The unit test proves the mock behaves; it says
nothing about the promise. Keep the fast faked unit tests, but add at least one
test at the real boundary for every guarantee that lives there.

## Why This Matters
Fakes are chosen precisely to remove the slow/irreversible real system — which is
often the exact thing the guarantee is about. "Green suite" then reads as "guarantee
holds" when it only means "the mock matched the assertion." These bugs survive
per-task review too, because the reviewer sees a passing test that looks on-point.

## When to Apply
When a design promise sits at the seam between your code and an external system:
git state, the filesystem, a network/LLM SDK, a database, the clock. Signals: the
test replaces that system with a fake/stub, and the guarantee's wording names the
real system ("committed to the branch," "written to disk," "the model sees X").

## Examples — three from one project, one day

### 1. Merge-gate: "the branch survives for review" — but empty
- **Guarantee:** on completion the loop commits generated work to a per-run branch;
  the branch survives worktree cleanup for human review.
- **Boundary:** real git (`git worktree remove --force`, commits).
- **Why the fakes passed:** unit tests faked `generateCode` (wrote no real files)
  and `removeWorktree` (no real git). Green.
- **What the real run showed:** the generator wrote files, but nothing committed
  them, and `git worktree remove --force` discarded the uncommitted work — the
  surviving branch had only the `init` commit.
- **Fix + boundary test:** commit per passing sprint (and partial work on halt)
  *before* removal; a real-git integration test asserts `git show <branch>:sum.js`
  succeeds — proven to fail against the pre-fix behavior (exit 128).

### 2. Blind evaluation: the evaluator never saw the artifact
- **Guarantee:** the evaluator grades "contract + artifact," blind to the
  generator's reasoning.
- **Boundary:** the constructed LLM prompt (what actually reaches the model).
- **Why the fakes passed:** unit tests used a fake `queryFn` and asserted on parsed
  output; none inspected what the evaluator's prompt contained.
- **What the real run showed:** off-goal code (`isPalindrome.js` for a "sum" goal)
  scored 96/100 — the evaluator only ever received the contract + the verifier's
  pass/fail boolean, never the artifact, so it rubber-stamped the boolean.
- **Fix + boundary test:** pass the worktree diff into the evaluate prompt; a
  plumbing test asserts the constructed prompt *contains* the diff and *excludes*
  the transcript, commit messages, and goal — the boundary is a tested property,
  not a prompt-only hope.

### 3. Trace accuracy: state persisted to disk but not in memory
- **Guarantee:** the trace (the spec's primary review artifact) records each run's
  real sprint and contract version.
- **Boundary:** the on-disk state store vs. the in-memory object the trace reads.
- **Why the fakes passed:** every orchestrator test was single-sprint, so a
  stuck-at-0 sprint field read the same as a correct one.
- **What the real run showed:** `store.update()` wrote `currentSprint`/`contractVersion`
  to disk only; `traceEvent` read the in-memory `state`, so every event said
  `sprint 0` / `contract v0` and a multi-sprint transcript collapsed under one
  "## Sprint 0."
- **Fix + boundary test:** route mutations through `update()` =
  `Object.assign(state, patch)` + `store.update(patch)`; a multi-sprint test
  asserts distinct sprint numbers in the trace and distinct "## Sprint N" headers.

## Related
- Rule: "Test Guarantees at Their Real-I/O Boundary" (project CLAUDE.md).
- dev-harness design spec resolved decisions (merge-gate; C2 evaluator boundary).
