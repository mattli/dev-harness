---
title: A Python Run's Verifier Interpreter Must Live Outside the Repo
date: 2026-08-06
category: conventions
module: dev-harness
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Launching a dev-harness run whose target is a Python project"
  - "Choosing --test-cmd for a greenfield repo that has no test runner yet"
  - "Any language whose toolchain convention is a gitignored in-repo env dir"
tags: ["verifier-environment", "worktree-isolation", "python", "pytest",
       "greenfield", "launch-preconditions"]
---

# A Python Run's Verifier Interpreter Must Live Outside the Repo

## Context
The harness generates code in a throwaway git worktree and runs `--test-cmd`
with that worktree as cwd. A worktree contains only *tracked* files. Python's
convention is a `.venv/` inside the repo, gitignored — so it is precisely the
thing a worktree does not have.

A `--test-cmd` of `pytest` or `python -m pytest` therefore resolves against
whatever is on PATH, which on this Mac is the system Python 3.9 with neither
pytest nor the anthropic SDK. Every sprint fails at collection, and the contract
is unsatisfiable no matter how many iterations run — the same failure shape as
the env-mismatch lesson, reached by a different route.

## The rule
Provision the verifier env at a stable absolute path **outside** any repo, and
make `--test-cmd` name that interpreter explicitly:

    /Users/mattli/.venvs/<project>/bin/python -m pytest -q

Never `.venv/bin/python` (absent from the worktree), never bare `pytest`
(resolves to the wrong interpreter). The venv is launch infrastructure, not a
build artifact — it belongs to the machine, not the branch.

## Worked example (2026-08-06, codebase-map, run msi6bsp1)
A greenfield Python repo with no toolchain at all. Provisioned
`~/.venvs/codebase-map` on Python 3.12 with pytest + anthropic before launch,
and passed the absolute interpreter as `--test-cmd`. All 5 sprints passed
(96/96/98/96/90) with zero env-related failures.

Two things made it work that are worth copying:
- **Pin the interpreter version deliberately.** The first venv was built with
  the default `python3` (3.9) and rebuilt on 3.12 once that was noticed. A
  greenfield run inherits whatever you hand it, for the life of the project.
- **State the env in the goal addendum as a hard constraint**, so the negotiating
  critic cannot freeze a criterion that contradicts it — including "do not create
  an in-repo .venv," which an agent will otherwise do by reflex.

## Related
- `match-verifier-env-to-sprint-contract-imports.md` — same failure (unsatisfiable
  contract via the verifier env), different cause: *what* it must import vs.
  *where* it lives.
