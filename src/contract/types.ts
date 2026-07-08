export interface Criterion { id: string; description: string; verifyBy: string; }
export interface Contract { version: number; criteria: Criterion[]; frozen: boolean; }
/** Why a contract froze: the evaluator agreed, or negotiation hit the round cap
 *  without agreement (the one bypass of the adversarial gate — deserves scrutiny). */
export type FreezeReason = "agreement" | "round-cap";
