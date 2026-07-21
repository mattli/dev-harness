---
title: Split Scope From Acceptance Criteria So the Blind Grader Can't See Scope — Cause #3 Fix
date: 2026-07-19
category: conventions
module: dev-harness
problem_type: convention
component: contract-negotiation
severity: high
applies_when:
  - "A run's generator produces correct, verifier-passing code but the blind scorer fails it near-zero"
  - "A contract needs to express where a change should stay (out-of-scope areas, file/module restrictions)"
  - "Deciding what the blind EVALUATE scorer may receive vs the sighted NEGOTIATE critic"
  - "Adding a field to the Contract type that the blind boundary must or must not carry"
tags: ["contract-negotiation", "unsatisfiable-contract", "blind-boundary", "scope", "structural-guarantee", "cause-3"]
---

# Split Scope From Acceptance Criteria So the Blind Grader Can't See Scope

## Context
This is the fix for **unwinnable-contract cause #3** — a frozen file-allowlist
criterion contradicting "tests pass," which made the blind scorer fail correct,
verifier-passing work (self-run `mrqghymn`, graded 3/0/4). The failure analysis is
its own lesson: [[contract-file-allowlist-contradicts-tests]] (the diagnosis). This
doc is the **structural fix** that shipped after two earlier attempts failed review.

## Why the first two attempts failed
Both tried to *classify the offending criterion*:
1. **Code detector + strip** (`satisfiability.ts`): a regex that stripped
   closed-file-set criteria at freeze. Review killed it — pattern-matching free text
   both over-matches legitimate behavioral criteria ("lists only untracked files")
   and under-matches real allowlists. Classifying a criterion is a *semantic*
   judgment (same family as the [[extract-model-json-by-marker-not-position]]
   lesson: don't parse model meaning heuristically).
2. **Prompts** (tell the critic to reject allowlists): can't *guarantee* anything —
   negotiation force-freezes the last contract at the round cap even without the
   critic's agreement, so a prompt-only rule has a trapdoor.

The durable lesson from both: **you cannot soundly decide in code whether a
free-text criterion is a forbidden scope restriction — only the sighted critic
can.** So the fix must not try to.

## The fix: structural, not classification
Stop trying to *detect* scope. Instead, give scope its own home and withhold that
home from the grader by construction.

- **Two-part contract.** `Contract { version, criteria, scope, frozen }`.
  `criteria` are behavioral acceptance criteria (graded). `scope` is a list of
  intent-level `ScopeConstraint {id, description}` (out-of-scope areas, "stay within
  module X") with **no `verifyBy`** — because scope is a necessity judgment, not a
  deterministically-gradable criterion.
- **The grader receives a projection with no scope field.**
  `GraderView { version, criteria, scope?: never }` and `toGraderView(contract)` is
  its only constructor; it drops `scope`. `buildEvaluatePrompt` / `evaluateArtifact`
  take a `GraderView`, **not** a `Contract`. The orchestrator projects at the single
  evaluate call: `evaluateArtifact(toGraderView(contract), diff, verifier)`.
- **The `scope?: never` brand is load-bearing — do not remove it.** A first cut used
  a plain `GraderView { version, criteria }` and claimed passing scope was a compile
  error. It was **not**: `Contract` is a structural *superset* of that shape, so a
  `Contract` (scope and all) is assignable to it, and a future caller could pass one
  straight into the grader — it would compile and `JSON.stringify` the scope into the
  prompt. Independent review caught this. The `scope?: never` brand makes
  `Contract.scope: ScopeConstraint[]` incompatible (`never`), so a `Contract` is
  genuinely rejected (`TS2345`). The guarantee is the brand; without it the type
  split is only single-call-site discipline. A `@ts-expect-error` regression in
  `tests/contract-scope-split.test.ts` pins it: drop the brand and `tsc` fails on the
  now-unused directives (`TS2578`), turning a silent scope re-admission into a build
  break.
- **This holds on every freeze path.** The projection sits at the grader boundary,
  downstream of freezing, so it applies identically whether the contract froze by
  agreement or by the **round-cap force-freeze** — closing the trapdoor that sank
  attempt #2.
- **Scope is still enforced** — by the sighted NEGOTIATE critic (it sees the full
  contract incl. scope and can read the worktree), the verifier, and the human merge
  gate. It is just never a *blind-graded* criterion.

The prompts (`contract-negotiation.md`, `evaluator.md`, `generator.md`) still teach
the model to file restrictions under `scope` and keep `criteria` behavioral — but
they are the *routing* help, **not** the guarantee. If the model misfiles an
allowlist as a criterion, the sighted critic is the backstop; the structural
guarantee is only that whatever lands in `scope` cannot reach the grader.

## What is and isn't guaranteed
- **Guaranteed (compile-enforced, tested):** nothing in `scope` ever reaches the
  blind scorer's input, under any negotiation outcome.
- **Not guaranteed by code:** that a given restriction gets *filed* as scope vs.
  mis-filed as a criterion — that routing is semantic, owned by the sighted critic +
  prompts. Do not add a code classifier for it (that's attempt #1's grave).

## Regression tests (`tests/contract-scope-split.test.ts`)
- `toGraderView` drops scope (the projection).
- Grader input never contains a scope sentinel — driven through the real
  `negotiate()` on **both** the agreement and round-cap freeze paths.
- The `mrqghymn` shape: file-allowlist in `scope` + tests-pass in `criteria`, graded
  by a fake evaluator that *would* dock if it saw the allowlist → returns the valid
  high grade, proving correct verifier-passing work is no longer failed for its file
  set.

## Why this matters
Every unwinnable-contract cause shares a shape: the contract is poisoned before a
line of code is judged, and the symptom points away from the cause. Cause #3's cure
isn't a smarter regex — it's making the blind boundary structurally incapable of
seeing the thing it can't fairly judge. When you extend the `Contract` type, ask
which side of the blind boundary each field belongs on, and enforce it in the
grader's *signature*, not in a prompt.

## Real-run confirmation (2026-07-21, run `mru5b2o4`)
First real task since the fix landed (the standalone `deepgram_request_audit`
build): the split behaved. Contracts carried `criteria` + `scope` separately and
the blind grader received **no scope** — verified in the run trace: scope present
in NEGOTIATE, absent in EVALUATE. It exercised the **round-cap force-freeze path**
(`contractFreezeReason: round-cap`, contractVersion 5) — the exact trapdoor the
structural projection was built to keep safe — and the grader stayed scope-free
through it. No unwinnable-contract symptom (sprint 1 scored 0/0 then recovered to
96 = generator iteration, verifier ultimately green).
