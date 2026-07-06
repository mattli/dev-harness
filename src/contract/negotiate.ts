import type { Contract } from "./types.js";

export function parseAgreement(text: string): boolean {
  return /^AGREEMENT:\s*yes/im.test(text);
}

export interface NegotiateDeps {
  propose: (prev: Contract | null) => Promise<Contract>;
  critique: (c: Contract) => Promise<{ agreed: boolean; contract: Contract }>;
  maxRounds: number;
}

export async function negotiate(deps: NegotiateDeps): Promise<Contract> {
  let current: Contract | null = null;
  for (let round = 1; round <= deps.maxRounds; round++) {
    const proposed = await deps.propose(current);
    const { agreed, contract } = await deps.critique(proposed);
    current = contract;
    if (agreed || round === deps.maxRounds) return { ...contract, frozen: true };
  }
  // unreachable, but satisfies the type checker
  return { ...(current as Contract), frozen: true };
}
