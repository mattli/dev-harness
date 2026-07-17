---
title: Harvested Tests Inherit Harvest-Time Hermeticity Assumptions — Re-Verify on an Evolved Codebase
date: 2026-07-16
category: conventions
module: dev-harness
problem_type: convention
component: harvest
severity: medium
applies_when:
  - "Harvesting/integrating a dev-harness run's generated tests into a real repository"
  - "Rebasing or re-pinning harvested tests onto a branch that has advanced since the run's base"
  - "A characterization test exercises production code that may make network/LLM/external calls"
tags: ["characterization-tests", "hermeticity", "harvest", "integration", "test-portability", "network-isolation", "llm", "brownfield", "re-pin"]
---

# Harvested Tests Inherit Harvest-Time Hermeticity Assumptions — Re-Verify on an Evolved Codebase

## Principle
A harness-generated test is hermetic only under the conditions that held **when it was
generated**. Those conditions are assumptions baked in at harvest time: the shape of the
production code it exercises, what that code imports, and whether any exercised path
reaches out to the network, an LLM, or constructs an external client. **When you
integrate harvested tests onto a codebase that has moved on, re-verify hermeticity
against the _current_ code — never assume it carried over.** Concretely: grep the
production paths the harvested tests exercise for client construction / network / LLM
calls (`anthropic.`, `.messages.create`, `openai`, `requests`, `httpx`, `socket`,
`urllib`, a `subprocess` that shells outward, etc.) and confirm each is stubbed or
unreachable in the test. A suite that was offline in the run's clone can silently start
making live calls once integrated, because the code under test — not the test — changed.

## Context
Harvesting the `mrn0iav3` run's characterization tests into the real Voice Tutor repo
required rebasing onto a branch tip **11 commits newer** than the run's base. On the old
base, `documents.list_documents()` / `save_upload()` were pure filesystem operations and
the harvested tests ran fully offline. On the evolved tip, a "per-document summaries"
redesign had changed `documents.py`: `list_documents()` became `async`, and both
functions now call `_generate_summary()`, which constructs `anthropic.Anthropic()` and
calls `client.messages.create(...)` — a live Haiku call.

The harvested tests, unchanged, now drove that call. Two symptoms landed together:

- **Drift (the tests doing their job):** 4 tests failed outright — `list_documents()`
  returns a coroutine now (`TypeError: object of type 'coroutine' has no len()`), and
  both functions grew a new `"summary"` key. Pinned behavior changed, so the
  characterization tests failed. Correct.
- **Hidden non-hermeticity (the silent one):** the tests *reached the network line*.
  They only stayed green-ish because no `ANTHROPIC_API_KEY` was set in that shell, so the
  SDK failed at auth resolution and the best-effort call swallowed the error. With a key
  present (or `.env.local` loaded), the same suite would hit the network. "Passes today"
  was luck, not hermeticity.

## Guidance
When integrating harvested tests onto an evolved codebase, do two separate things:

1. **Re-pin the drift** to current behavior, as its **own reviewed commit** — do not fold
   it into the integration merge, and do not edit production code to make old assertions
   pass. Here: `asyncio.run(...)` the now-async call and add the new `"summary"` key to
   the pinned shapes.
2. **Re-verify hermeticity explicitly.** Grep every production path the tests exercise for
   external-call construction; stub what you find. Here: a module-scoped autouse fixture
   stubs `documents._generate_summary` to the graceful no-summary path, so the client is
   never constructed regardless of environment. Confirm offline **by evidence** — the run
   went from emitting `[doc-summary] failed: ...auth...` on stderr to **none**, and
   dropped to ~2s.

Placement note: put the stub where the network-reaching tests live if a shared
`conftest.py` deliberately forbids autouse behavior-altering patches (this suite's
conftest does); don't silently violate that contract to centralize the stub.

## Why This Matters
Harvest-time assumptions **expire**, and they expire silently — the test file doesn't
change, so nothing flags that its guarantees no longer hold. A non-hermetic test that
"passes" only because a credential happens to be absent is a CI flake and a cost/latency
leak waiting to happen; worse, it can send real data to an external service from what
looks like an offline unit run. Re-verifying hermeticity on integration is the same
discipline as pinning a moving baseline: you are checking that a property assumed at
generation time still holds after the world moved.

This is a sibling of [[harness-generated-tests-keyed-on-git-head]] — **same family:
harvest-time assumptions expire.** There, the expired assumption was "`HEAD` is the
pre-move tree" (a git-state boundary that holds in the harness, not the committed repo);
here, it is "the exercised code is pure" (a hermeticity boundary that held on the run's
base, not the evolved tip). Both are instances of the general form in
[[test-guarantees-at-their-boundary]]: a test whose validity depends on a boundary
condition it does not itself control.

## When to Apply
- Harvesting or re-pinning any dev-harness run's tests into a real repo, especially when
  rebasing onto a branch that advanced since the run's base.
- Any time a characterization test exercises production code that *could* reach an
  external system — re-grep the exercised paths on the target tree; don't trust that the
  run's clone was offline.
- Diagnosing a harvested suite that "passes" but emits auth/connection errors on stderr,
  or that is fast only because a key is unset — treat green-by-missing-credential as a
  hermeticity failure, not a pass.

## Related
- `docs/solutions/conventions/harness-generated-tests-keyed-on-git-head.md` — the sibling
  harvest gotcha (a git-`HEAD` baseline that expires on commit). Same family:
  harvest-time assumptions expire.
- `docs/solutions/conventions/test-guarantees-at-their-boundary.md` — the general form: a
  test whose validity silently depends on a boundary it does not control.
- `docs/solutions/conventions/evaluator-cwd-blind-scorer-sighted-critic.md` — the run
  (`mrn0iav3`) that produced these tests.
