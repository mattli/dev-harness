export interface Criterion { id: string; description: string; verifyBy: string; }

/** An intent-level scope constraint — an out-of-scope area or a restriction on
 *  where/how the change may reach ("stay within the run-branch naming module",
 *  "do not touch the voice pipeline"). It has NO `verifyBy`: scope is a judgment
 *  about necessity, not a deterministically-graded criterion. Scope is enforced
 *  by the SIGHTED negotiate critic (which can read the worktree), the verifier,
 *  and the human merge gate — NEVER by the blind scorer. See `GraderView`. */
export interface ScopeConstraint { id: string; description: string; }

/** `criteria` are the behavioral ACCEPTANCE criteria — the only thing the blind
 *  scorer grades. `scope` is intent-level scope, structurally withheld from the
 *  scorer (see `toGraderView`). Splitting the two is cause-#3's structural fix:
 *  a file/scope restriction can no longer sit among the graded criteria, so the
 *  blind scorer can never fail correct, verifier-passing work for its file set. */
export interface Contract { version: number; criteria: Criterion[]; scope: ScopeConstraint[]; frozen: boolean; }

/** Why a contract froze: the evaluator agreed, or negotiation hit the round cap
 *  without agreement (the one bypass of the adversarial gate — deserves scrutiny). */
export type FreezeReason = "agreement" | "round-cap";

/** The projection of a frozen contract that the BLIND scorer receives. It carries
 *  version + acceptance criteria and, by the `scope?: never` brand, is NOT
 *  assignable from a `Contract` (whose `scope: ScopeConstraint[]` is incompatible
 *  with `never`). Without the brand a `Contract` would structurally satisfy this
 *  shape — it is a superset — and a future caller could pass a scope-bearing
 *  contract straight into the grader; the brand makes that a COMPILE ERROR, so the
 *  guarantee is the type system, not single-call-site discipline. `toGraderView`
 *  is the only constructor, and it omits `scope` entirely. Regression-pinned by a
 *  `@ts-expect-error` in tests/contract-scope-split.test.ts: if the brand is
 *  dropped, that directive goes unused and `tsc --noEmit` fails. This is the
 *  guarantee; the prompts are not. */
export interface GraderView { version: number; criteria: Criterion[]; scope?: never; }

export function toGraderView(c: Contract): GraderView {
  return { version: c.version, criteria: c.criteria };
}
