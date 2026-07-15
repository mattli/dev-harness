---
title: Can a Run Target an Existing Repo? (Brownfield Readiness)
date: 2026-07-15
category: assessment
problem_type: readiness_investigation
module: dev-harness
tags: ["workspace", "worktree", "brownfield", "greenfield", "verifier", "planner", "generator", "git", "destructive-paths"]
applies_when: "Deciding whether one supervised run can be pointed at an existing git repo instead of scaffolding a new project."
---

# Can a Run Target an Existing Repo? (Brownfield Readiness)

## Verdict

**Works today with config changes for a repo whose test suite is green at HEAD.**
The harness is *not* architecturally greenfield: it already requires an existing
git repo as input, checks out that repo's real files into the worktree, and hands
them to a full-tool generator agent that can read and overwrite them. Nothing
assumes an empty directory.

The one real break for brownfield is the **verifier runs the whole repo test
suite**, so any *pre-existing* failing test poisons every sprint's verdict. If the
target repo is green at HEAD, a run works with config only. If it has red tests at
HEAD, you need one small code change (test baselining) — or a `--test-cmd`
workaround — before the verdict logic is trustworthy.

No destructive git operations exist (no push, force-push, `reset --hard`, `clean`,
or `rm -rf` of the user's tree). The blast radius is confined to a temporary
worktree the harness creates and removes.

## The workspace lifecycle, traced

### 1. Where the workspace comes from — existing repo required, no scaffolding
`--project <path>` is a **required** CLI option (`src/cli/index.ts:30`), threaded
to `config.projectPath`. The workspace is a git worktree, not a fresh directory:

```
git -C projectPath worktree add -b run/<slug>-<runId> <projectPath>/.dev-harness-worktrees/<branch>
```
(`src/workspace/worktree.ts:17`). There is **no `git init` anywhere** in the
codebase — `git worktree add` *fails* unless `projectPath` is already a git repo.
The new branch is cut from the project's current `HEAD`, so the worktree is a full
checkout of the existing codebase, including all its files and history. The source
is taken entirely from `--project`; nothing is hard-coded and no repo URL/clone
path exists (it's local-only).

**Conclusion:** the harness assumes an *existing local git repo*, the opposite of
greenfield. The README's `sum.js` example is greenfield-*styled*, but the
machinery is repo-agnostic.

### 2. What the planner sees — task description only, blind to the codebase
`planRun` sends the planner exactly `Goal: ${goal}` (`src/agents/planner.ts:13`)
with the planner system prompt. It receives **no file tree, no file contents, no
conventions** — the plan is generated blind to what already exists. The planner
prompt (`prompts/planner.md`) asks for 3–6 coarse vertical-slice sprints from the
one-line goal alone. There is **no code-context gathering and therefore no size
limiting** (nothing to limit). For a single supervised run this is tolerable — the
human encodes the needed context in the goal string — but sprints may not fit the
existing architecture.

### 3. What the generator sees — no injected file contents, but full tool access
The generate prompt (`buildGeneratePrompt`, `src/agents/generator.ts:21`) injects
only goal + sprint + frozen contract — **no existing file contents**. But this does
*not* make it create-only:

- `generateCode` runs a **real Claude agent** with `cwd: worktreePath` and
  `permissionMode: "bypassPermissions"` (`src/agents/generator.ts:42`). The agent
  has its normal toolset and runs inside the checkout of the existing repo.
- So it can **read, edit, and overwrite** existing files with its own tools. Writes
  are whatever the agent does — not a constrained create-only API.
- The artifact graded downstream is `git diff --cached HEAD` of the worktree
  (`worktreeDiff`, `src/workspace/worktree.ts:37`), which captures modifications to
  existing files just as well as new files.

**Gap (quality, not correctness):** neither the prompt nor `prompts/generator.md`
tells the agent it's in an existing codebase ("read before you write, match
conventions, don't rewrite unrelated files"). It *can* modify existing code; it
just isn't *steered* to respect what's there.

### 4. What the verifier/evaluator assume — WHOLE suite, and this is the brownfield break
`TestSuiteVerifier.verify` runs the configured command (default `npm test`) via
`execa(command, { shell: true, cwd: worktreePath })` and treats exit 0 as pass
(`src/verifier/test-suite.ts:7`). This runs the **entire repo test suite**, not
just tests named in the sprint contract. The evaluator then receives
`Verifier: PASSED|FAILED` plus up to the last 20 lines of failing output
(`src/agents/evaluator.ts:30`) alongside the artifact diff, and scores 0–100.

**The break:** in a brownfield repo with *any* pre-existing failing test, the
verifier returns `FAILED` for work that is actually correct. The evaluator sees the
failure, and the score almost certainly lands below `advanceScore` (85). The sprint
never advances, burns its 6 iterations, and halts as no-progress / max-iterations —
even though the sprint's own code is fine. The verdict logic has no concept of a
baseline; it cannot distinguish "my change broke a test" from "this test was
already red." A green-at-HEAD repo avoids this entirely.

### 5. Commit/branch behavior — safe against existing history and a remote
- Branch: `run/<slug>-<runId>` (`runBranch`, `src/state/run-path.ts:7`), created by
  the `worktree add -b` above, cut from the project's current `HEAD`.
- Per-sprint commits: on a passing sprint (`score >= advanceScore`) and on any halt,
  `commitWorktree` does `git add -A` + `git commit` **onto the run branch inside the
  worktree** (`src/orchestrator/run.ts:178`, `:105`). Commits accumulate on the run
  branch only.
- Cleanup: the `finally` calls `removeWorktree` → `git worktree remove --force`
  (`src/workspace/worktree.ts:44`), which deletes the temporary worktree directory.
  The run branch and its commits **survive** in the project repo for human review;
  the run is **never auto-merged and never pushed**.

Pointed at a repo with existing history and a remote, this behaves sanely: it adds
one review branch and touches nothing else. The human does the merge/push (the
documented merge gate).

## Minimal changes for ONE supervised brownfield run (sized)

### Done (both S items — 2026-07-15)

- **S — Config pointing (no code needed).** `--project <path>` already targets an
  existing repo; there is no config file to edit. Runtime instruction only: point
  it at the repo and, if the suite isn't green at `HEAD`, pass `--test-cmd` scoped
  to just the area the sprint touches (e.g. `npm test -- path/to/dir`).
- **S — `.gitignore` entry.** `.dev-harness-worktrees/` added to this repo's
  `.gitignore` so the temporary worktree dir never shows as clutter (belt-and-
  suspenders; registered git worktrees are already excluded from status).
- **S — Generator context nudge.** Added to `prompts/generator.md`: "You may be
  working in an existing codebase — read the relevant files before writing, match
  the conventions already in place, and do not rewrite unrelated files." Steers the
  full-tool agent to respect existing code; not required for correctness.

### Deferred to Phase 2 (both M items — noted, not done)

- **M — Test baselining.** Run the verifier once on the worktree's base `HEAD`,
  record pre-existing failures, and count a sprint as failing only on *newly*
  failing tests. Only matters if the target repo is **red at HEAD** — moot for a
  testless or green repo, which is why it's deferred. Would touch
  `src/verifier/test-suite.ts` + the orchestrator's evaluate step.
- **M — Planner/generator code-context injection.** Feed a (size-limited) file tree
  into the planner and generate prompts. **Redundant for the generator**, which
  already explores the checkout with real tools; the marginal value is planner-side
  fit. Deferred. Note there is no size-limiting anywhere today, so this must add its
  own cap.

Minimum to run against an existing local repo, given the S items above: point
`--project` at a repo that is **green or testless at HEAD** and go. A repo that is
**red at HEAD** needs the deferred baselining M before the verdict logic is
trustworthy.

## Destructive-path audit (flagged even where the run works)

- **`git worktree remove --force`** (`src/workspace/worktree.ts:44`) — "force"
  discards *uncommitted* changes, but only inside the harness's **own temporary
  worktree** (`<project>/.dev-harness-worktrees/<branch>`). It does not touch the
  user's main checkout or any other branch. The harness commits partial work
  *before* removal, so the only data at risk is anything the agent left uncommitted
  in that temp dir. **Low risk, but it is a real `--force`** — worth knowing it can
  drop uncommitted work in the worktree.
- **`git add -A`** in `commitWorktree`/`worktreeDiff` stages everything in the
  worktree. It's isolated to the temp worktree, so it can't stage the user's main
  tree — but it *will* sweep any stray files the agent creates (build output, temp
  files) into the run-branch commit. Confined, but not surgical.
- **No push / force-push / `reset --hard` / `clean` / `rm -rf` / `checkout` of the
  main branch exists** (grep-confirmed across `src/` and `prompts/`). Nothing is
  ever sent to a remote. This is why a repo with a remote is safe.
- **Litter, not damage:** a hard-killed process (not a caught halt) can leave the
  `.dev-harness-worktrees/<branch>` directory and its git-worktree registration
  behind, needing `git worktree prune`. Non-destructive, but it accumulates.
- **Worktree lives inside the project dir:** `worktreeRoot` defaults to the relative
  `.dev-harness-worktrees` and is resolved under `projectPath`
  (`src/config/defaults.ts:11`, `src/workspace/worktree.ts:16`), so the harness
  writes a directory into the target repo's folder. Registered git worktrees are
  excluded from the main tree's status, so it won't show as untracked — but add it
  to `.gitignore` anyway as a belt-and-suspenders measure.

## Related
- Merge-gate guarantee ("the branch survives for review"):
  `docs/solutions/conventions/test-guarantees-at-their-boundary.md`.
- README "Where things land" and "v1 caveat — attended, no Docker" (the generator
  runs shell commands directly in the worktree; brownfield inherits that same
  attended-only posture).
