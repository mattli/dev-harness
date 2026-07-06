import type { Contract } from "./types.js";

export function parseAgreement(text: string): boolean {
  return /^AGREEMENT:\s*yes/im.test(text);
}

export interface NegotiateDeps {
  propose: (prev: Contract | null) => Promise<Contract>;
  critique: (c: Contract) => Promise<{ agreed: boolean; contract: Contract }>;
  maxRounds: number;
  /** Optional guard evaluated at the top of each round, BEFORE the next pair of
   *  agent calls. If it throws, negotiation aborts and the error propagates to
   *  the caller. Kept agent- and budget-agnostic by design: the orchestrator
   *  supplies one that throws BudgetHalt when a wall-clock/$ cap trips, so a long
   *  negotiation can't overshoot the backstops (which are otherwise only
   *  re-checked at the DECIDE point). */
  checkStop?: () => void;
}

export async function negotiate(deps: NegotiateDeps): Promise<Contract> {
  let current: Contract | null = null;
  for (let round = 1; round <= deps.maxRounds; round++) {
    deps.checkStop?.();
    const proposed = await deps.propose(current);
    const { agreed, contract } = await deps.critique(proposed);
    current = contract;
    if (agreed || round === deps.maxRounds) return { ...contract, frozen: true };
  }
  // unreachable, but satisfies the type checker
  return { ...(current as Contract), frozen: true };
}
