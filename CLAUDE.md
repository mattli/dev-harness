# dev-harness — Project Instructions

Durable engineering lessons from this project. These changed how the build goes;
they're here so future work in this repo starts with them.

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

## Don't Parse Model Output by Position — Emit a Marker and Key on It
When extracting a value from LLM output, have the model emit a guaranteed,
unambiguous marker (a labeled sentinel it's told to output exactly once, or
structured output — a tool call / JSON) and key on that marker. Don't
heuristically select among candidate matches by position (first / last /
nearest). Positional selection is fragile: the same value legitimately appears
elsewhere (in reasoning before the verdict, in findings after it), and every
position rule is wrong for some layout. Regex-scanning free text for "the number
that's probably the answer" is a recurring bug source.

## A Fix Is Unreviewed Code
A fix is new code and can introduce new bugs, so its risk scales with what it
touches. A fix to control-flow, a guarantee, or a review finding needs the same
independent review as any other change — self-approving your own patch to a
finding re-introduces the exact blind spot the review existed to catch. A cosmetic
or comment-only change does not. The lesson isn't "review every fix"; it's "the
fixes that touch how things work, especially late close-out fixes that bypassed
normal review, are where self-approval bites."

## Matt Owns the Product Here, Not the Code
Matt directs this project but does not read the implementation. Explain changes
at a product-manager altitude — what it does and why it matters, not how the code
works. Don't ask him to review diffs himself. When a change needs review (see "A
Fix Is Unreviewed Code"), arrange an independent review (e.g. /code-review) and
translate the findings into plain language and a recommendation, rather than
handing him the diff.
