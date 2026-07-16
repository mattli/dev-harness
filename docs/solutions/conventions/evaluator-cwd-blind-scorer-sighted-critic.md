---
title: The Two Evaluator Roles Have Opposite CWD Rules — Sighted Critic, Blind Scorer
date: 2026-07-16
category: conventions
module: dev-harness
problem_type: convention
component: evaluator
severity: high
applies_when:
  - "Wiring the working directory (cwd) that a dev-harness agent's tool calls run in"
  - "Adding or changing any evaluator-phase agent (NEGOTIATE critic or EVALUATE scorer)"
  - "A negotiated contract describes the wrong repository, or freezes on an 'target source absent' / no-op clause"
  - "Deciding whether to give an adversarial/judge agent filesystem or git access to the artifact under review"
tags: ["evaluator", "contract-negotiation", "blind-boundary", "cwd", "adversarial-review", "false-pass", "unsatisfiable-contract", "worktree"]
---

# The Two Evaluator Roles Have Opposite CWD Rules — Sighted Critic, Blind Scorer

## Context
The dev-harness evaluator plays two roles in the run loop, and they have **opposite
information rules** — a distinction that must be encoded in *where their tool calls
run*, not left to chance.

- **NEGOTIATE critic** (`critiqueContract`) is **sighted**: it is explicitly given
  the goal + sprint and its job is to judge whether the proposed contract faithfully
  targets the *real project code*. It must inspect the project.
- **EVALUATE scorer** (`evaluateArtifact`) is **blind** (the "C2" boundary): it grades
  only the injected artifact diff + the deterministic verifier result, and is
  deliberately *not* given the goal, the sprint, the generator's transcript, or commit
  messages. Its blindness is enforced by its function signature — those things are not
  parameters.

Both roles ran with an **undefined `cwd`**, so their SDK tool calls executed in
whatever directory the harness process was launched from (`~/development/dev-harness`,
a TypeScript repo) instead of the target project's worktree. Only the generator
(`proposeContract`/`generateCode`) was correctly given `wt.path`.

On a live Voice Tutor run (`mrmzffye`), the mis-located **critic** ran `git show
HEAD:bot.py` / `git ls-files -- '*.py'` **in the harness repo**, "saw" a TypeScript
tree with no `bot.py`, and — round after round — insisted the target source did not
exist. The proposer (which *did* have the correct cwd) capitulated over four rounds,
and the two agents froze, by "agreement," a contract whose top clause was
`UNSATISFIABLE-AS-SCOPED: target source absent` and whose only passing artifact was an
**empty no-op**. The run could produce nothing. This is the **second distinct cause of
an unwinnable contract in as many runs** — see [[match-verifier-env-to-sprint-contract-imports]]
for the first (env missing what the contract must import).

## Guidance
**Match each evaluator role's cwd to its information role. The sighted critic runs in
the project worktree; the blind scorer is given no worktree cwd at all.** Encode the
asymmetry in the *signatures* so it cannot silently regress:

- `critiqueContract(deps, sprint, contract, cwd)` — takes a `cwd` argument, threaded
  from `wt.path` through `LoopDeps` and `wire.ts`, exactly like the generator.
- `evaluateArtifact(deps, contract, artifactDiff, verifier)` — has **no** cwd
  parameter, so it structurally cannot be handed the worktree.

The fix is *not* "give both evaluator agents the worktree" — that was the tempting
symmetric patch, and it is wrong. Handing the **scorer** a worktree cwd re-opens the
blind boundary out-of-band and creates a false-pass:

1. **Blindness leak.** With a worktree cwd the scorer can `git log` prior-sprint commit
   messages/scores and read the goal/spec files off disk — re-admitting exactly the
   inputs the signature withholds. The comments in `run.ts` / `evaluator.ts` asserting
   the scorer "never receives" commit messages become false.
2. **False pass.** The scorer is documented to grade the *produced diff*. With
   filesystem access it can credit a criterion satisfied by **pre-existing worktree
   files outside the diff** — base project code, or an earlier sprint's committed work
   — and advance a sprint the current artifact never earned.

So the roles diverge: the critic *needs* to see real code (it has no injected
evidence and is not blind); the scorer *must not* (its evidence is injected, and its
independence depends on not reaching around it).

## Why This Matters
The failure *looked* like "the planner/generator couldn't do the relocation." The real
cause was an adversarial critic reasoning correctly about the **wrong repository** —
an environment in which the contract was **poisoned by construction** before a single
line of code was generated. The caps eventually stop such a run, but only after a
sprint's wall-clock is spent chasing an impossible target (in the poisoned run, the
loop was killed manually at the NEGOTIATE stage).

Two compounding lessons:

1. **An agent's tool-call cwd is part of its contract with reality.** An agent asked to
   "check whether X exists in the repo" answers about whatever repo its cwd points at.
   If that is the harness's own tree, every existence/absence judgment is answered
   against the wrong ground truth — and an adversarial agent is *most* dangerous here,
   because it will confidently argue the (wrong) repo's facts and drag agreement toward
   them.
2. **Blindness is a boundary you can breach through the side door.** A signature that
   withholds goal/sprint/commit-messages as parameters is only as blind as the agent's
   *ambient capabilities* allow. Filesystem/git access to the artifact tree is a side
   channel back to everything the signature hid. Withhold the capability (no cwd), not
   just the parameter.

## Should run b79d8ron5's contract be re-read in light of the critic bug?
**No — its contracts stand as written; they do not need re-derivation.** The critic-cwd
bug was *present* during b79d8ron5 (the evaluator never carried a cwd until this fix),
so the question is fair. But the bug is **latent and non-deterministic**: it poisons a
contract only when the mis-located critic actively injects a false "the repo lacks X"
claim *and* the proposer capitulates to it. The confidence that b79d8ron5 escaped rests
on **positive evidence**, not on the bug being inactive:

- **Sprint 0 (characterize `documents.py`)** scored 96 and was independently re-verified
  at `26 passed` — a contract that produced 25+ passing characterization tests against
  the real `documents.py` demonstrably targeted real code. A "documents.py absent"
  poisoning could not have done that.
- **Sprint 1 (relocate `bot.py` helpers)** froze a *rigorous, `bot.py`-faithful*
  dual-import contract that correctly named the real helpers. It failed on the verifier
  **environment** (missing `anthropic`/Pipecat for `import bot`), not on a poisoned
  scope — that is the separate lesson in [[match-verifier-env-to-sprint-contract-imports]].
  A poisoned run would have looked like `mrmzffye`'s "target source absent," which it
  did not.

So the verdict is evidence-based: b79d8ron5's contracts were faithful, and the critic
bug — though live — did not manifest there. The caveat worth stating explicitly: one
may *not* infer "unaffected" merely because a run predates the fix; the assurance comes
from the passing tests and the correctly-named targets, not from the bug's absence.

Separately, EVALUATE **scores** from prior runs need **no asterisk**: the scorer grades
from the injected diff + deterministic verifier result (which always ran in the correct
worktree via `runVerifier(cwd)`), so its wrong cwd was inert. The 96 that `documents.py`
scored despite the mis-located scorer is the empirical proof.

## When to Apply
- Wiring the cwd for *any* dev-harness agent — decide it per the agent's information
  role, not by copy-pasting a sibling call. Sighted inspection → worktree cwd. Blind
  grading → no worktree cwd.
- Reviewing a "give the evaluator access to the repo" change: confirm it targets the
  *critic* only, and that it does not hand the *scorer* a path around its blind boundary.
- Diagnosing a contract that describes the wrong stack, or freezes on a no-op/"source
  absent" clause: suspect a mis-located critic before suspecting the model.

## Examples

**Before — both evaluator agents run in the harness dir (poisoned critic):**
```ts
// wire.ts
critiqueContract: (sprint, c)    => critiqueContract({ queryFn, model, goal }, sprint, c),        // no cwd
evaluateArtifact: (c, diff, v)   => evaluateArtifact({ queryFn, model, goal }, c, diff, v),        // no cwd
// invokeAgent → query({ options: { cwd: undefined } }) → tool calls run in ~/development/dev-harness
```
Result on run `mrmzffye`: critic inspects the harness's TS tree, "sees" no `bot.py`,
freezes `UNSATISFIABLE-AS-SCOPED: target source absent`; only passing artifact is an
empty diff.

**After — sighted critic gets the worktree; blind scorer gets nothing:**
```ts
// wire.ts
critiqueContract: (sprint, c, cwd) => critiqueContract({ queryFn, model, goal }, sprint, c, cwd), // cwd = wt.path
evaluateArtifact: (c, diff, v)     => evaluateArtifact({ queryFn, model, goal }, c, diff, v),      // deliberately no cwd
```
```ts
// evaluator.ts — the signatures encode the asymmetry
export async function critiqueContract(deps, sprint, contract, cwd: string) { /* cwd → invokeAgent */ }
export async function evaluateArtifact(deps, contract, artifactDiff, verifier) { /* no cwd — stays blind */ }
```
Result on re-run `mrn0iav3`: critic inspects the real `bot.py`, negotiates a
satisfiable 12-criterion contract (correct 7 helpers + 4 constants, verbatim-move
guard, a Pipecat-stub fixture so the dual-import proof runs in the minimal venv), and
the sprint passes at **score 96**.

**Regression guard** (`tests/evaluator-cwd.test.ts`) — pins both boundaries at the
SDK-query seam:
```ts
await critiqueContract(deps(queryFn), sprint, contract, "/work/tree");
expect(seen).toEqual(["/work/tree"]);   // sighted critic runs in the worktree

await evaluateArtifact(deps(queryFn), contract, "diff", verifier);
expect(seen).toEqual([undefined]);      // blind scorer never runs in the worktree
```

## Related
- `docs/solutions/conventions/match-verifier-env-to-sprint-contract-imports.md` — the
  *first* cause of an unwinnable contract (verifier env missing what the contract must
  import). Together these are two distinct ways a run's contract becomes unsatisfiable
  before any code is generated: wrong environment, and wrong repository under the
  critic's feet.
- `docs/solutions/conventions/test-guarantees-at-their-boundary.md` — the sibling
  lesson that a guarantee must be tested at its real boundary; here the regression test
  pins cwd at the SDK-query boundary, and the blind boundary itself was the thing
  silently breached.
