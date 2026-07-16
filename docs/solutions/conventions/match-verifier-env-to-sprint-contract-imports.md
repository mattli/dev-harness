---
title: Match the Verifier Environment to What the Sprint Contract Must Import
date: 2026-07-15
category: conventions
module: dev-harness
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Provisioning a verifier environment (--test-cmd) for a dev-harness run against an existing repo"
  - "A sprint's acceptance criteria require importing a production module that has heavy top-level imports"
  - "Choosing a deliberately-minimal test env to keep generate/verify iterations fast and deterministic"
  - "A sprint asks for a re-export / interface-parity / dual-import proof against the production entrypoint"
tags: ["characterization-tests", "verifier-environment", "sprint-contract", "brownfield", "pytest", "env-contract-mismatch", "dependency-isolation"]
---

# Match the Verifier Environment to What the Sprint Contract Must Import

## Context
The first dev-harness run against an existing repo (Voice Tutor, `feat/study-companion-mode`)
was planned as two sprints and given a deliberately-minimal verifier env — a
dedicated venv with only `pytest` + `pypdf`, referenced by absolute path via
`--test-cmd`. That env was chosen because sprint 1's target, `documents.py`, imports
only `pypdf`, so a lean env kept iterations fast and hermetic.

- **Sprint 0 — characterize `documents.py`:** sailed through. 25 characterization
  tests, **score 96**, and independently re-verified at the passing commit:
  `26 passed` under the exact pinned command.
- **Sprint 1 — relocate `bot.py`'s pure helpers into `session_state.py`, then
  characterize them:** never went green (scores 12, 22, 18) and **halted on the
  30-minute wall-clock cap after 9 revisions**, burning **$24.81** of the run's
  $27.81 on a contract it could not satisfy in that environment.

## Guidance
**The verifier environment must contain every dependency that the sprint's own
acceptance criteria require *importing* — not just what the code under
characterization imports.** A "minimal env" is a *per-sprint* decision, not a
per-run one. Before launching, take the union of what each planned sprint's
contract will have to import and provision for it, **or** scope each sprint to a
module whose import closure the env already covers.

The trap is a sprint whose contract legitimately demands importing a production
module that eagerly pulls heavy dependencies at module load. In this run the
evaluator — correctly doing its adversarial job — negotiated a rigorous
relocation contract that included a **dual-import / re-export proof**: invoke every
moved helper through *both* `session_state.<name>` and `bot.<name>` and assert
equality. That proof requires `import bot`. But `bot.py` imports `anthropic` and
the full Pipecat stack unconditionally at the top of the file
(`bot.py:9 import anthropic`, `bot.py:13-35` Pipecat), so `import bot` *always*
drags in those deps — which the minimal env deliberately omitted. The suite could
not even reach an assertion; it died at **collection**.

## Why This Matters
The failure *looked* like "the model couldn't do the relocation," but the real
cause was an environment in which the contract was **unsatisfiable by
construction**. No number of generator iterations can turn a green suite out of a
test module that fails at import collection. The caps did their job and stopped the
bleeding, but only after a full sprint's wall-clock and ~$25 were spent chasing an
impossible target.

Two compounding lessons:
1. **A sprint that proves an interface against the production entrypoint inherits
   that entrypoint's entire import closure.** Re-export/parity proofs are exactly
   this shape. If the entrypoint eagerly imports heavy deps, the verifier env needs
   them — or the proof must be restructured to not import the entrypoint (e.g.
   assert from source/AST that `bot.py` re-imports from `session_state.py`, rather
   than importing `bot` at runtime).
2. **Eager top-level imports in the target repo leak into every sprint that
   touches that module.** You cannot "reach one pure helper" in `bot.py` without
   paying for `anthropic` + Pipecat, because those imports run at module load. A
   verbatim-move sprint can't fix that (making the imports lazy would be a logic
   change), so the env must carry the deps instead.

## When to Apply
- Setting up `--test-cmd` and its environment for any dev-harness run against an
  existing repo — decide the env against the **contracts**, not just the source.
- Any sprint whose criteria include a re-export, interface-parity, dual-import, or
  behavior-equivalence proof that imports the production module.
- Any target module with unconditional heavy top-level imports (LLM SDKs, ML/audio
  stacks, web frameworks): assume every sprint touching it needs those deps present,
  or scope that sprint out of the minimal env.

## Examples

**Sprint 0 — env matched the contract (worked):**
```
# target: documents.py, which imports only pypdf
env:       venv with pytest + pypdf
--test-cmd /abs/clone/.harness-venv/bin/python -m pytest -q
result:    26 passed · score 96
```

**Sprint 1 — env did NOT match the contract (unsatisfiable):**
```
# contract required a dual-import proof → import bot
# bot.py:9  import anthropic     (eager, top-level)
# bot.py:13 from pipecat...      (eager, top-level)
env:       venv with pytest + pypdf   (no anthropic, no pipecat)
collection error:
  tests/test_session_state.py:27: in <module>  import bot
  bot.py:9: in <module>                          import anthropic
  E  ModuleNotFoundError: No module named 'anthropic'
result:    scores 12/22/18 → halted (wall-clock), $24.81 spent
```

**Fix for a re-run (either is sufficient):**
- Give that sprint the fuller env: `uv`-install `anthropic` + Pipecat so `import bot`
  resolves; **or**
- Restructure the re-export proof so it verifies the relocation *without* importing
  `bot` (source/AST assertion that `bot.py` re-imports the moved names), keeping the
  minimal env.
- Independently, give a fiddly relocation sprint a larger wall-clock/iteration budget
  than a straightforward characterization sprint.

## Related
- `docs/solutions/brownfield-readiness.md` — the minimal-env approach and why the
  clone won't carry a `.venv`; this is the failure mode that approach hits when a
  sprint's contract needs more than the target module's own imports.
- `docs/solutions/conventions/test-guarantees-at-their-boundary.md` — the sibling
  lesson that a guarantee must be tested at its real boundary; here, the *test
  environment itself* is the boundary the contract silently depended on.
