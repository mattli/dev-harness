import type { Contract, FreezeReason } from "./types.js";

export function parseAgreement(text: string): boolean {
  return /^AGREEMENT:\s*yes/im.test(text);
}

/** What the previous negotiation round produced: the proposed contract and the
 *  evaluator's critique of it. Carried into the next propose() so the generator
 *  revises against the critique instead of re-proposing blind. */
export interface PriorRound { contract: Contract; critique: string; }

/** The outcome of a negotiation: the frozen contract plus WHY it froze —
 *  "agreement" (evaluator agreed) vs "round-cap" (forced at maxRounds without
 *  agreement). Callers surface the reason so a cap-forced freeze, which entered
 *  GENERATE/EVALUATE without the adversarial gate's blessing, is visible. */
export interface NegotiationOutcome { contract: Contract; freezeReason: FreezeReason; }

export interface NegotiateDeps {
  propose: (prev: PriorRound | null) => Promise<Contract>;
  critique: (c: Contract) => Promise<{ agreed: boolean; contract: Contract; critique: string }>;
  maxRounds: number;
  /** Optional guard evaluated at the top of each round, BEFORE the next pair of
   *  agent calls. If it throws, negotiation aborts and the error propagates to
   *  the caller (the orchestrator throws BudgetHalt so a long negotiation can't
   *  overshoot the wall-clock/$ backstops). Agent- and budget-agnostic. */
  checkStop?: () => void;
}

export async function negotiate(deps: NegotiateDeps): Promise<NegotiationOutcome> {
  let prev: PriorRound | null = null;
  for (let round = 1; round <= deps.maxRounds; round++) {
    deps.checkStop?.();
    const proposed = await deps.propose(prev);
    const { agreed, contract, critique } = await deps.critique(proposed);
    prev = { contract, critique };
    // Agreement wins over the cap: a final round that also agrees froze because
    // the evaluator agreed, not because it ran out of rounds.
    if (agreed) return { contract: { ...contract, frozen: true }, freezeReason: "agreement" };
    if (round === deps.maxRounds) return { contract: { ...contract, frozen: true }, freezeReason: "round-cap" };
  }
  // unreachable (maxRounds >= 1 guaranteed by config validation), satisfies types
  return { contract: { ...(prev as PriorRound).contract, frozen: true }, freezeReason: "round-cap" };
}
