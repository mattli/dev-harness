# dev-harness — Project Instructions

Durable engineering lessons from this project. These changed how the build goes;
they're here so future work in this repo starts with them.

New to the run loop? `CONCEPTS.md` (repo root) is a plain-language glossary of the
domain vocabulary — run, sprint, contract, critic vs. scorer, blind boundary, etc.
`docs/solutions/` holds worked examples of past problems, organized by category with
YAML frontmatter (`module`, `tags`, `problem_type`) — relevant when working in an area
one of these lessons touches.

## Test Guarantees at Their Real-I/O Boundary
A guarantee that only holds at a real-I/O boundary — real git, real filesystem,
real network/SDK — needs at least one test that exercises that boundary. Fakes
that stub the boundary make the suite pass green while the guarantee is silently
broken: the mock satisfies the assertion, the real system doesn't. Whenever a
design promise lives at the seam between our code and an external system ("the
branch survives for review," "the evaluator sees the artifact," "state is
persisted"), write a test against the real thing, not a fake. If every test of a
guarantee mocks the boundary the guarantee depends on, you've tested the mock.
Worked examples: `docs/solutions/conventions/test-guarantees-at-their-boundary.md`.
Related failure mode when harvesting a run's generated tests into a real repo: tests
that key on `git HEAD` as "the original" (verbatim-move, diff-scope, golden-from-source)
pass in-run but break once the sprint is committed and HEAD advances — pin the baseline
or drop them. See `docs/solutions/conventions/harness-generated-tests-keyed-on-git-head.md`.
A second harvest failure mode, same family (harvest-time assumptions expire): harvested
tests inherit harvest-time *hermeticity*. Integrating them onto an evolved codebase can
silently make them hit the network/LLM — the code under test changed, not the test.
Re-verify by grepping the exercised production paths for client/network/LLM construction
(`anthropic.`, `.messages.create`, `requests`, etc.) and stub what you find; don't assume
the run's clone offline-ness carried over, and treat green-only-because-a-key-is-unset as
a hermeticity failure, not a pass. See
`docs/solutions/conventions/harvested-tests-can-be-non-hermetic.md`.

## Don't Parse Model Output by Position — Emit a Marker and Key on It
When extracting a value from LLM output, have the model emit a guaranteed,
unambiguous marker (a labeled sentinel it's told to output exactly once, or
structured output — a tool call / JSON) and key on that marker. Don't
heuristically select among candidate matches by position (first / last /
nearest). Positional selection is fragile: the same value legitimately appears
elsewhere (in reasoning before the verdict, in findings after it), and every
position rule is wrong for some layout. Regex-scanning free text for "the number
that's probably the answer" is a recurring bug source. This bit again when the
planner/generator sliced a contract's JSON from the first `{` to the last `}`: a
brace-heavy goal made the model write a stray `{` in preamble prose and the run
crashed at negotiation (`Expected property name or '}' at position 1`). Extract by
a fenced-block marker + shape validation instead — and note that the *first* version
of that fix was itself buggy (quote-desync, echoed-schema grab) and only an
independent review caught it. Worked example:
`docs/solutions/conventions/extract-model-json-by-marker-not-position.md`.

## A Fix Is Unreviewed Code
A fix is new code and can introduce new bugs, so its risk scales with what it
touches. A fix to control-flow, a guarantee, or a review finding needs the same
independent review as any other change — self-approving your own patch to a
finding re-introduces the exact blind spot the review existed to catch. A cosmetic
or comment-only change does not. The lesson isn't "review every fix"; it's "the
fixes that touch how things work, especially late close-out fixes that bypassed
normal review, are where self-approval bites."

## Commit Before a Workflow-Backed Code Review
The workflow-backed /code-review spawns subagents that check out branches inside the
working repo, and can leave you parked on a different branch (or risk clobbering
uncommitted work). Commit before launching a review, and re-check git branch/status
after. (Observed twice, 2026-07-18, dev-harness. Living here for now; promote to the
shared dotfiles CLAUDE.md if it shows up outside this repo.)

## Matt Owns the Product Here, Not the Code
Matt directs this project but does not read the implementation. Explain changes
at a product-manager altitude — what it does and why it matters, not how the code
works. Don't ask him to review diffs himself. When a change needs review (see "A
Fix Is Unreviewed Code"), arrange an independent review (e.g. /code-review) and
translate the findings into plain language and a recommendation, rather than
handing him the diff.

This extends past code to *operational* answers — git branches, backups, file
layout, infrastructure. Lead with the plain outcome ("your run records save into
your vault and back up automatically") and stop; don't narrate the mechanism
(branches, symlinks, ignore rules, flags) unless he asks how it works. If Matt
says he's confused, that's the tell you've slipped into implementation altitude —
restate the outcome in one plain sentence and cut the rest, don't add more detail.

## The Run Transcript Is a Product Surface, Not a Debug Log
The transcript/summary a run produces is the primary thing Matt reads to understand
what happened — often over SSH, in raw form, with no code context. It must be legible
to a non-coder: open with a plain-language summary, narrate each stage in words, and
never assume the reader knows what "in/out", contract versions, or a run ID like
`mrbb5z` mean. When adding fields to the trace or transcript, ask "would this read as
gibberish to someone who's never seen the code?" — if so, label it or leave it out.
Prefer named/dated run folders over opaque hashes for the same reason.

## Provision the Verifier Env for What the Contract Imports, Not Just the Code
A dev-harness run's verifier environment must contain every dependency the
sprint's acceptance criteria require *importing* — not only what the module under
test imports. "Minimal env" is a per-sprint call: a sprint that proves a
re-export/interface against a production entrypoint inherits that entrypoint's
whole import closure, so if the entrypoint eagerly imports heavy deps (LLM SDKs,
Pipecat, web frameworks) the env needs them — or the proof must be restructured
not to import it. Otherwise the suite dies at collection and the contract is
unsatisfiable no matter how many iterations run. Worked example:
docs/solutions/conventions/match-verifier-env-to-sprint-contract-imports.md.

## A Contract Is Only as Sound as the Repo the Critic Inspected
The dev-harness evaluator has two roles with OPPOSITE information rules. The
NEGOTIATE critic is sighted — it must run in the project worktree, because it
judges whether the contract targets real code. The EVALUATE scorer is blind — it
must get NO worktree cwd, because it grades only the injected diff + verifier
result; a worktree cwd would leak commit messages/goal files and let it pass a
sprint on code outside the produced diff. Wiring both evaluator agents to run in
the harness's own dir let the critic "see" a repo with no target file and freeze
an unsatisfiable "source absent" contract (a run that can only no-op). Match each
evaluator agent's cwd to its role, and encode the asymmetry in the signatures
(critic takes a cwd; scorer cannot). This is the SECOND distinct cause of an
unwinnable contract — the first is the verifier env missing what the contract
imports. Worked example:
docs/solutions/conventions/evaluator-cwd-blind-scorer-sighted-critic.md.

## When a Run Grades Plainly-Correct Work Near-Zero, Suspect the Contract (Cause #3)
A frozen criterion that closes the change to an exact file set/count ("only these N
files", "no files other than …") contradicts a "tests pass" criterion — a change's
file set isn't knowable up front (a rename fans out to every test that hard-codes the
old value). The blind scorer then fails correct, verifier-passing work for touching a
"forbidden" file; self-run mrqghymn graded correct code 3/0/4 this way. Diagnostic:
when a run scores plainly-correct work near-zero, re-run the verifier on the run
branch — if it's green, the score measured an unsatisfiable CONTRACT, not the code
(the verifier is the trustworthy signal; overrule the grade with cause). Third
distinct unwinnable-contract cause (after verifier-env and evaluator-cwd).
FIX (2026-07-20, structural scope-split): a contract now has two parts — `criteria`
(behavioral acceptance, graded) and `scope` (intent-level restrictions, NOT graded).
The blind scorer receives a `GraderView` (`{version, criteria, scope?: never}`)
projected by `toGraderView` at the evaluate call, so a scope/file-set restriction
structurally cannot reach the grader on ANY freeze path — including the round-cap
force-freeze trapdoor. Scope is enforced by the sighted critic + verifier + human
merge gate instead. The `scope?: never` brand is load-bearing: without it a
`Contract` (a structural superset) is still assignable to `GraderView`, so the
guarantee is only single-call-site discipline — the first cut shipped that hole and
independent review caught it. With the brand, passing a `Contract` to the grader is a
compile error, pinned by a `@ts-expect-error` that makes `tsc` fail if the brand is
dropped. The type split is the guarantee (compile-enforced); the prompts that route
restrictions into `scope` are not — routing a free-text restriction is a semantic
call only the sighted critic can make (why the two prior code/prompt attempts
failed). Worked example:
`docs/solutions/conventions/contract-scope-split-blind-grader.md`.

## Vault & Product Docs About dev-harness Lag the Code — Verify Caps Before Citing
The plain-language explainer (`~/second-brain/areas/dev-harness/dev-harness-explainer.md`)
and the coldmountain.ai dev-harness page describe the harness for non-coders, and
they drift behind the code — most reliably on **caps and defaults**. This has bitten
twice: both carried a "$10 hard cap / money halts the run" story long after the cap
rework made the dollar ceiling **off-by-default and informational** (`dollarCeiling:
null`), with the **per-sprint wall clock** as the real backstop and a **subscription
usage-limit** as a first-class graceful pause. When asked whether one of these docs is
accurate — or before quoting any cap/default/halt-reason from one — read
`src/config/defaults.ts` and `src/budget/tracker.ts` (the `StopReason` list), not the
doc and not memory. Treat the code as the source of truth; the prose is downstream.
