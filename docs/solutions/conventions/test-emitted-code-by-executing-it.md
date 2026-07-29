---
title: Test Emitted Code by Executing It, Not Substring-Matching
date: 2026-07-28
category: conventions
problem_type: best_practice
module: dev-harness
tags: ["dashboard", "testing", "code-generation", "template-literals", "escaping", "client-side-js", "real-io-boundary"]
applies_when: "One runtime emits source code as a string for another runtime to execute (a server templating client-side JS, codegen, a generated script), and the tests assert on that output by substring/regex match instead of compiling or running it."
---

# Test Emitted Code by Executing It, Not Substring-Matching

## Context
The dev-harness live dashboard server builds its client-side polling script by
concatenating it inside a backtick **template literal** in `src/dashboard/server.ts`
and shipping it to the browser as text. A mount-awareness fix added this line to the
emitted script:

```js
var BASE = location.pathname.replace(/\/+$/, "");
```

The `\/` is a regex escape *in the browser*, but it sits inside the server's template
literal first — and JS template-literal parsing consumes `\/` down to `/`. So the
browser actually received:

```js
var BASE = location.pathname.replace(//+$/, "");   // "//" starts a comment
```

`//` begins a line comment, swallowing the rest of the statement. The **entire**
polling script failed to parse, so none of it ran. The dashboard froze on its
server-rendered first snapshot for every viewer, on every device, through every
reload — while `curl` of the page looked perfect, because `curl` never executes JS.

The existing page tests missed it completely. They asserted the right *substrings*
were present:

```js
expect(body).toMatch(/BASE\s*=\s*location\.pathname\.replace\(/);
```

That regex matched the broken output just fine — the tokens were all there; the code
just didn't *parse*. Green suite, dead dashboard.

## Guidance
When one runtime emits code as a string for another runtime to run, a test that
greps the emitted string proves the tokens exist, not that the code is valid or does
anything. Add a test that actually **compiles** (and, where feasible, **runs**) the
emitted artifact:

- Compile-check: feed the emitted script to a parser that throws on syntax errors —
  `new vm.Script(js)` (Node) throws `SyntaxError` without executing. This alone
  catches the whole class of "emitted code doesn't parse."
- Execute-check: run it in a minimal simulated environment (a stub `document` /
  `fetch` / `setInterval`, a controllable `Date.now`) and assert the observable
  behavior — e.g. the elapsed clock element advances one second per tick.

See `tests/dashboard-client-script.test.ts`: it extracts the served `<script>`,
`new vm.Script`s it across every run-state fixture, then runs it in a fake DOM and
watches the clock tick. Verified by reintroducing the bug and confirming the test
goes red (7 failures, "SyntaxError: missing ) after argument list").

## Why This Matters
Emitted-code bugs are invisible to the two checks you reach for first. A type-checker
(`tsc`) sees the template literal as an opaque string — it never looks inside. A
substring/regex test matches the tokens whether or not they form valid code. And
`curl`/HTTP-level tests fetch the text without executing it. The bug only exists in
the *target* runtime, so only a test that reaches that runtime — by compiling or
running the output — can see it. This is the emitted-code twin of
[[Test Guarantees at Their Real-I/O Boundary]]: the guarantee ("the page updates
live") lives at the browser boundary, so a test that never crosses that boundary
can't defend it.

Escaping is the recurring trigger: any `\` in emitted code (regex escapes, `\n`,
`\t`, `\\`) is first eaten by the host language's string/template parsing. If you
mean the target runtime to receive `\/`, the source must contain `\\/`.

## When to Apply
Whenever code is produced as data for another runtime: a server templating inline JS,
a build step generating a script, a tool emitting a config/program, prompt-assembled
code. Signals you're exposed: the emitted code contains a backslash or quote that has
meaning in *both* the host string and the target language; the only tests are
substring/regex assertions or HTTP fetches; a type-checker "covers" the file but
treats the emitted region as a string.

## The rule
Assert emitted code by **compiling and running it**, never by substring-matching. A
grep proves the tokens are present; only a parse proves they're code, and only a run
proves they work.
