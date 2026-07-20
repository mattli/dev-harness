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

/** The projection of a frozen contract that the BLIND scorer receives. It has NO
 *  `scope` field by construction, so scope cannot reach the grader regardless of
 *  how the contract froze — including the round-cap force-freeze trapdoor, which
 *  is downstream of this boundary. `toGraderView` is the ONLY way to build one,
 *  and it drops scope; the grader's signature takes this type, not `Contract`,
 *  so passing scope to the grader is a compile error, not a discipline the model
 *  or a prompt must uphold. This is the guarantee; the prompts are not. */
export interface GraderView { version: number; criteria: Criterion[]; }

export function toGraderView(c: Contract): GraderView {
  return { version: c.version, criteria: c.criteria };
}
