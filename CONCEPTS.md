# Concepts

Shared domain vocabulary for this project — entities, named processes, and status
concepts with project-specific meaning. Seeded with core domain vocabulary, then
accretes as ce-compound and ce-compound-refresh process learnings; direct edits are
fine. Glossary only, not a spec or catch-all.

## The run and its shape

**Run** — One end-to-end invocation of the harness against a target project: it plans
the work, then drives each sprint through negotiate → generate → verify → evaluate
until the work passes or a cap stops it. A run gets its own branch and its own folder
under `runs/` holding the trace and state.

**Sprint** — One unit of work within a run, with a title and a description. The harness
plans a run as an ordered list of sprints and works them one at a time; each sprint
gets its own contract and its own attempts.

**Contract** — The machine-checkable "definition of done" for a sprint: a numbered list
of acceptance criteria that the produced code must satisfy. It is negotiated before any
code is written and then frozen, so the target can't move mid-sprint.

**Acceptance criterion** — One line item in a contract: a plain-language requirement
plus a `verifyBy` note saying exactly how it will be checked (e.g. "run pytest", "the
diff touches no production file"). Criteria are what the scorer grades against.

## The agents

**Planner** — The agent that reads the run's goal and breaks it into the ordered list of
sprints.

**Generator** — The agent that writes the actual code in the project worktree to satisfy
a frozen contract. It also plays the *proposer* half of contract negotiation.

**Evaluator** — The adversarial agent that keeps the generator honest. It plays two
different roles at two different moments (the critic and the scorer, below), and those
two roles have deliberately opposite information rules.

**Critic** — The evaluator acting during *negotiation*. It is "sighted": it sees the
goal and sprint and inspects the real project code, and its job is to reject a weak or
off-target contract and demand one that faithfully targets what's actually in the repo.
Because it inspects real code, it must run inside the project worktree.

**Scorer** — The evaluator acting during *evaluation*, after the generator has produced
code. It is "blind": it grades only the produced diff plus the verifier's pass/fail
result, and is deliberately kept from seeing the goal, the sprint, or the project's
files. Its independence depends on that blindness, so it is *not* given access to the
worktree.

## Processes and boundaries

**Contract negotiation** — The back-and-forth that produces a sprint's contract: the
proposer drafts criteria, the critic accepts them or sends back what to strengthen, and
they repeat until the critic agrees or a round cap is hit. The result is a *frozen*
contract.

**Freeze / freeze reason** — A contract becomes frozen once negotiation ends. It froze
either by *agreement* (the critic accepted it) or by *round-cap* (they ran out of
rounds without agreeing) — the latter is worth extra scrutiny because it skipped the
critic's sign-off.

**Blind boundary** — The rule that the scorer must judge only from the evidence it is
handed (the diff and the verifier result) and nothing else. It is enforced structurally
— the goal, sprint, and worktree are simply not made available to it — rather than by
asking the model to ignore them.

**Verifier** — The deterministic checker that runs the project's real test command
(`--test-cmd`) in the worktree and reports pass/fail plus findings. Its result is the
hard signal the scorer trusts; unlike the agents, it is not a model.

**Worktree** — A throwaway git checkout of the target project that a run works inside, so
generated code and test runs are isolated from the user's real repository. The generator
and the critic run here; the blind scorer does not.
