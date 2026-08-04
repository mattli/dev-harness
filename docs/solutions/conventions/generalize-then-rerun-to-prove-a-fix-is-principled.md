---
title: A Fix Validated Only Against Its Motivating Case Proves Nothing — Generalize, Then Re-Run
date: 2026-08-04
category: conventions
problem_type: best_practice
module: dev-harness
tags: ["prompts", "llm-judge", "eval-sets", "overfitting", "acceptance-criteria", "review", "credentialed-smoke"]
applies_when: "A prompt, rule, or heuristic is changed to fix ONE observed failure, and the same case (or an eval set built around it) is then used as the evidence that the change works."
---

# A Fix Validated Only Against Its Motivating Case Proves Nothing — Generalize, Then Re-Run

## Context

A harness run authored v2 of an LLM judge prompt to close one proven failure: the
judge credited *fluent wrongness* — an explanation matching a claim's shape and
keywords while contradicting its specific content (the `c30` case). The run passed
its acceptance bar, 17/17 agreement against a human-labelled answer key, including
the mandatory `c30` regression.

Independent review found the prompt was **partly overfit**. The core content-match
principle was general, but three of the four rules enforcing it were written around
the single case they had to fix: one restated `c30`'s structural fingerprint one
abstraction layer up, one existed solely to catch `c30`'s second enumeration, one
was a verbal photograph of the exact wrong turn the tutor took, and a fourth was
shaped to the fixtures' recap turns. No claim ids or subject matter leaked — the
*structure* did.

The tell was arithmetic: across 252 verdicts, a rewrite adding four aggressive
rules flipped **exactly the one verdict the answer key required**. That is either
surgical or tuned, and the artifacts could not distinguish them.

## Guidance

When a fix is motivated by one case, the acceptance run against that case is **not**
evidence the fix is principled — it is evidence the fix is *sufficient*. To tell
principled from overfit, run the experiment that can distinguish them:

1. **Strip the case-specific scaffolding.** Remove the parts that name, describe, or
   mirror the motivating case's particulars — its structure, its vocabulary, its
   shape — and restate each rule at the level of the principle.
2. **Re-run the acceptance once. Do not iterate.** Iterating toward the answer key
   is precisely the failure being tested for.
3. **Report either outcome as a result.** If it still passes, the fix rests on the
   principle and you have proof. If it flips back, you have learned the general
   principle is insufficient for that case — a genuine finding, not a failure.

Record the motivating case in a **source comment the model never sees**, not in the
prompt. The rationale stays discoverable for maintainers without biasing the model.

## Why This Matters

An overfit rule is invisible at the moment it is written, because the evidence that
would expose it — behavior on cases outside the eval set — is exactly what the eval
set does not contain. It passes review, passes acceptance, and then underperforms on
the first unseen input, where nothing announces the regression.

The asymmetry is what makes the re-run worth its cost: the experiment is **one run**
(here, ~$0.07 and five model calls) against a defect class that otherwise ships
silently and is discovered only in production.

**A freshness check strengthens the result.** When the re-run passes, confirm the
judgement was genuinely recomputed rather than incidentally identical. Here the
per-session verdicts *moved* (10→11, 1→0, 4→3) while the union the labels grade
stayed identical — much stronger evidence than a byte-identical rerun, which cannot
distinguish "re-judged and agreed" from "did not really re-judge."

## When to Apply

Any change where the motivating case is also the validating case: judge/grader
prompts, extraction heuristics, classification rules, regex and parsing fixes, and
scoring adjustments. It applies with most force when the eval set was *derived from*
the failure — an answer key built around one bug cannot referee a fix for that bug.

It does **not** apply to changes whose correctness is decidable independently of the
example — a type error, an off-by-one with a proof, a deterministic parser fixed
against a specification.

## Known Limit — What the Re-Run Cannot Tell You

Passing the generalized re-run bounds recall loss **only over the labels the key
contains**. If the answer key holds only cases the previous version marked positive
(as here — every label was a claim v1 called covered), it is structurally blind to
the new rules becoming *too strict* on unlabelled inputs, which is the failure mode
aggressive new rules most invite. Pair the re-run with a **false-negative probe** —
a handful of human-labelled cases the previous version marked negative — or state
plainly that recall was verified only against the predecessor's own positives.

Related: [[credentialed-smoke-as-contract-acceptance]] — the smoke run is what makes
this experiment possible at all; a mocked suite cannot referee prompt quality,
because it tests the parser against fixtures the author invented rather than the
model's actual judgement.
