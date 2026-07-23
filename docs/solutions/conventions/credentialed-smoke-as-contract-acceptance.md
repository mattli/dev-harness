---
title: A Credentialed Smoke Is Contract Acceptance for LLM-Calling Modules, Not a Review Afterthought
date: 2026-07-23
category: conventions
problem_type: best_practice
module: dev-harness
tags: ["testing", "mocks", "llm-transport", "tool-use", "credentialed-smoke", "acceptance-criteria", "contracts"]
applies_when: "A harness contract's Definition of Done rests on a hermetic/mocked suite for a module whose real job is an LLM or network call the mock stubs away."
---

# A Credentialed Smoke Is Contract Acceptance for LLM-Calling Modules, Not a Review Afterthought

## Context
A Voice Tutor claim-extraction module (`claims.py`) was built by the harness with a
hermetic, fully-mocked test suite. It passed **two harness sprints (scored 97, 98)
and three rounds of independent review** with a green suite — yet its real job,
calling Sonnet and parsing the result, was broken **three separate ways** against
live output (a fourth was a deeper design flaw), none visible to the mock. The
credentialed smoke that caught them cost **~$0.36** — against two sprints and three
review rounds that all read mock-validated code. The economics are the whole
argument. And it only ran because a reviewer *chose* to; the contract's own
Definition of Done was "the hermetic suite passes," which is structurally blind to
the transport.

## Guidance
For any harness-built module whose core behavior is an LLM (or network) call, the
**contract's acceptance criteria must include a gated credentialed smoke** — a
small budgeted smoke against the real fixtures, with its observations reported as
acceptance evidence (counts, resolution rates, stop reasons) — as a first-class
Definition-of-Done item, not a review-time nicety. The mock proves the parser
against *fixtures the author invented*; the smoke proves the *transport* against how
the provider actually behaves. Bake it into the contract so the harness cannot
freeze a sprint "done" on mock-green alone, and so the smoke is a diagnostic that
reports evidence, not a ping that only checks for a crash.

## Why This Matters
A mocked suite substitutes the exact boundary the module exists to cross, so it can
*never* test the transport — it tests the mock. For LLM modules the dangerous
failure modes are all provider-shaped and appear only on a real call: output
encoding (markdown fences around "JSON-only" output), tool-schema conformance (the
model double-encoding a strict-tool array as a JSON string), and token limits (a
dense document truncating the tool call at `max_tokens`). Green mocks plus green
reviews is a *false* trustworthiness signal here — the reviews read the same code
the mock validates; only a real call exercises the provider. Elevating the smoke
from "reviewer discretion" to "contract acceptance" makes the missing check a
satisfiability requirement, not luck.

## When to Apply
Any module whose core job is an LLM or network call — especially structured-output,
tool-use, and streaming paths. It does **not** apply to pure functions with no I/O
(a green hermetic suite is sufficient there). This is the LLM-transport case of the
same principle as [[Test Guarantees at Their Real-I/O Boundary]] (unit level) and
the network-fetcher "Credentialed Smoke Run" note in CLAUDE.md (its API twin).

## Examples
The real-only defects in `claims.py`, each green under the mock and caught only on
the credentialed smoke:

- **Markdown fences.** The prompt said "no markdown fences"; real Sonnet wrapped
  every payload in a ```json fence, so the bare `json.loads` parser rejected 100%
  of real output. Fix: strict forced tool-use (structured output, no free text).
- **Strict-tool double-encoding.** Even with a forced tool call, the model
  intermittently packed the whole `claims` array into a *string* field. Fix:
  `strict: true` + `additionalProperties: false` to force schema conformance.
- **`max_tokens` truncation.** A dense doc's claim set exceeded the 8K output
  budget, truncating the tool JSON into empty/partial input. Fix: 16K budget +
  streaming + a `max_tokens` stop-reason tripwire (deterministic, so not retried).
- **Non-verbatim anchors (the deepest case).** The mock fed hand-written *verbatim*
  anchors, encoding the author's assumption that the model quotes the source
  exactly. Real models drift and sometimes hallucinate quotes — so the mock was
  wrong about the model's *behavior*, not just its formatting. That hidden gap was
  an entire resolution-layer design problem: a chop → bleed → over-trim family of
  mirror bugs (each heuristic fix introducing the inverse failure), exposed only
  once real drift met the code and ultimately resolved by *conservative
  resolution* — produce offsets only from provable substring matches and flag
  genuine drift rather than guessing a span. The mock encodes the author's model of
  the model; here that model was wrong about what the model does, which no amount of
  mock-fixture review could surface.

All of these passed the mocked suite (which fed clean, fenceless, well-formed JSON
and verbatim anchors) and survived multiple review rounds; the first real calls
surfaced them immediately.
