---
title: Extract a Model's JSON by a Marker + Shape, Not by First-Brace/Last-Brace Position
date: 2026-07-17
category: conventions
module: dev-harness
problem_type: bug
component: agents
severity: high
applies_when:
  - "Parsing a JSON object out of an LLM reply (planner plan, generator contract, any structured agent output)"
  - "A run crashes at negotiation/planning with a JSON.parse error like \"Expected property name or '}' at position 1\""
  - "The task/goal itself discusses code full of braces (Python dicts, f-strings, JSX) or quotes"
  - "Writing or reviewing a fix that extracts a value from free-form model text"
tags: ["parse-by-marker", "json-extraction", "llm-output", "positional-parsing", "contract-negotiation", "planner", "generator", "fix-is-unreviewed-code", "adversarial-review"]
---

# Extract a Model's JSON by a Marker + Shape, Not by First-Brace/Last-Brace Position

## Context
The planner (`planRun`) and generator (`proposeContract`) both pulled the model's
JSON reply out of free text the same fragile way:

```ts
const json = res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1);
const obj = JSON.parse(json);
```

This grabs *everything from the first `{` to the last `}`*. It works only when the
model's reply contains no other brace. On run **`mrpk71c5`** — a Voice Tutor sprint
whose goal was *"relocate the pure helper functions from wiki.py… evaluate
`build_system_instruction`…"* — the model's contract-proposal preamble naturally
discussed Python code full of braces (dict literals, f-strings like `f"{name}"`).
It wrote a stray `{` in prose *before* the real JSON, so the slice started at that
stray brace and produced malformed input. Negotiation crashed with:

```
SyntaxError: Expected property name or '}' in JSON at position 1 (line 1 column 2)
    at proposeContract (src/agents/generator.ts:36)
```

The run died before generating a single line. The previous week's `session_state`
relocation had used the identical code and *worked* — not because it was correct,
but because that goal wasn't brace-heavy and the model's reply happened to be clean.
**It passed by luck, not by design** — the classic signature of positional parsing.

This is the same family as the earlier `parseScore` fix (evaluator score parsing),
which replaced a first-match `/SCORE:/` scan with a unique `FINAL SCORE:` marker.
Both are instances of the project rule **"Don't Parse Model Output by Position —
Emit a Marker and Key on It."** The planner even carried a comment *claiming* it
"keys on labelled fields (not positional scanning of prose)" while doing exactly the
positional scan — a lie the code had told for two runs.

## Guidance
**Extract structured model output by (1) a marker the prompt asks for, then (2) the
object's shape — never by brace/character position.** Concretely, `extractJsonObject`
(`src/agents/extract-json.ts`), used by both the planner and generator:

1. **Prefer a fenced ` ```json ` block.** Both prompts now instruct the model to emit
   exactly one fenced block. Fenced content is the marker; prose braces outside it
   are ignored.
2. **Fall back to scanning balanced-brace regions**, JSON-parsing each, and returning
   the first that satisfies a **shape predicate** (`isValid`). A stray `{key: value}`
   in prose fails `JSON.parse` (or the shape check) and is skipped.
3. **Refuse to guess.** In the unfenced fallback, require *exactly one* shape-valid
   object. If two appear (e.g. the model echoed the schema example before its real
   answer), **throw** rather than silently pick one — the pre-fix code failed loudly
   there, and a silent wrong-pick would be worse than the crash it replaced.
4. **Validate shape, not just presence.** Predicates require non-empty, well-typed
   fields (`criteria` non-empty with string `id`/`description`/`verifyBy`; `title`
   non-empty + non-empty typed `sprints`) so a vacuous `{"criteria":[]}` — which would
   freeze an unsatisfiable no-op contract — is rejected.

## The Fix Was Itself Unreviewed Code — and the First Version Was Buggy
This lesson's most important half: **the first version of this fix shipped two new
bugs, and only an independent review (`/code-review`, high) caught them before
re-running.** Both were in the "robust" replacement, not the original:

1. **Quote-parity desync.** The balanced-brace scanner tracked string state across the
   *whole* reply, including prose. A single stray `"` in preamble prose (e.g. `the 5"
   value {…}`) flipped `inStr` and caused the scanner to swallow the real object's
   opening brace — re-triggering the exact class of crash the fix was meant to
   eliminate. Fix: only track quotes *inside* a candidate object (brace depth ≥ 1);
   at depth 0 (prose) ignore quotes entirely.
2. **Echoed-schema grab.** `extractJsonObject` returned the *first* shape-valid object.
   The planner/generator prompts literally print a fill-in schema
   (`{"title":"…","sprints":[…]}`); if the model echoed it before its real answer,
   first-match returned the placeholder and the run proceeded on bogus data —
   *silently*. Fixes: fence both prompts (fenced real answer wins), and throw on
   unfenced ambiguity instead of guessing.

The review also caught that the first patch had hardened only the *generator* and left
the *planner* — the more prose-exposed caller — on the fragile path, and that the two
generator prompt files gave contradictory output instructions.

The takeaway reinforces **"A Fix Is Unreviewed Code"**: a fix to control-flow (here,
how every run parses its plan and contract) is new code that can introduce new bugs,
and self-approving it re-introduces the blind spot the review exists to catch. This
fix touched the parsing every run depends on; it warranted — and was materially
improved by — the same independent review as any other change. See also
[[test-guarantees-at-their-boundary]]: each surviving finding was pinned with a
regression test (brace-heavy preamble, stray-quote desync, fenced disambiguation,
empty-criteria rejection, unfenced ambiguity) so it cannot silently regress.

## Why This Matters
Positional parsing of model output is a recurring, *non-deterministic* bug source:
the same code passes for runs, then a task whose subject matter happens to contain the
delimiter character crashes it. The failure is maximally confusing because it looks
like a model or repo problem, not a parser problem — the model's reply is fine; our
extraction is wrong. Keying on a marker + shape makes extraction depend on *what the
value is*, not *where it sits in prose*, which is stable across every layout the model
might produce.

## When to Apply
- Any time you extract a value (JSON, a number, an enum) from an LLM's free-text reply:
  have the model emit a labelled marker (fenced block, unique sentinel, or a tool call)
  and key on it. Never select among candidates by first/last/nearest position.
- Diagnosing a `JSON.parse` crash at PLAN/NEGOTIATE, especially `"Expected property
  name or '}' at position 1"`: suspect a stray brace in preamble prose grabbed by a
  positional slice before suspecting the model.
- Reviewing your own "robust parser" replacement: it is unreviewed code. Check the new
  edge cases (unbalanced quotes in prose, echoed schema/examples, empty/placeholder
  shapes, and whether *every* caller was migrated) — get an independent review for
  control-flow-level parsing changes.

## Examples

**Before — first-brace/last-brace slice (crashes on any preamble brace):**
```ts
// generator.ts / planner.ts
const json = res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1);
const obj = JSON.parse(json);          // dies if a stray `{` precedes the real JSON
```
Run `mrpk71c5`: brace-heavy contract preamble → `Expected property name or '}' at
position 1` → negotiation crash, zero code produced.

**After — marker-first, shape-validated, ambiguity-safe:**
```ts
const parsed = extractJsonObject(
  res.text,
  (o): o is { criteria: Contract["criteria"] } => {
    const crit = (o as { criteria?: unknown } | null)?.criteria;
    return Array.isArray(crit) && crit.length > 0 && crit.every(
      (c) => c != null && typeof c === "object"
        && typeof (c as any).id === "string"
        && typeof (c as any).description === "string"
        && typeof (c as any).verifyBy === "string");
  },
);
```
`extractJsonObject` prefers a fenced ` ```json ` block; else scans balanced-brace
regions (quote-tracking only at depth ≥ 1) and requires exactly one shape-valid
object, throwing on ambiguity. Prompts request the fenced block. Re-run `mrplqx5g`
cleared negotiation and the sprint passed at **score 96**.

## Related
- **CLAUDE.md → "Don't Parse Model Output by Position — Emit a Marker and Key on It"** —
  the project rule this instantiates; sibling to the `parseScore` / `FINAL SCORE:`
  marker fix for evaluator scoring.
- **CLAUDE.md → "A Fix Is Unreviewed Code"** — why the fix itself got an independent
  review, which is what caught the quote-desync and echoed-schema bugs in the *first*
  version of this very fix.
- `docs/solutions/conventions/test-guarantees-at-their-boundary.md` — each finding was
  locked with a regression test at the extraction boundary rather than trusting the
  parser by inspection.
