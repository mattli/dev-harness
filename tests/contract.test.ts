import { expect, test } from "vitest";
import { parseAgreement, negotiate } from "../src/contract/negotiate.js";
import type { Contract } from "../src/contract/types.js";

const c = (version: number): Contract => ({ version, criteria: [], frozen: false });

test("parseAgreement reads the sentinel", () => {
  expect(parseAgreement("looks good\nAGREEMENT: yes")).toBe(true);
  expect(parseAgreement("AGREEMENT: no, scope too big")).toBe(false);
  expect(parseAgreement("no marker here")).toBe(false);
});

test("negotiate freezes when critique agrees", async () => {
  let round = 0;
  const result = await negotiate({
    propose: async (prev) => c((prev?.contract.version ?? 0) + 1),
    critique: async (contract) => { round++; return { agreed: round >= 2, contract, critique: "crit" }; },
    maxRounds: 5,
  });
  expect(result.frozen).toBe(true);
  expect(result.version).toBe(2);
});

test("negotiate force-freezes at round cap", async () => {
  const result = await negotiate({
    propose: async (prev) => c((prev?.contract.version ?? 0) + 1),
    critique: async (contract) => ({ agreed: false, contract, critique: "crit" }),
    maxRounds: 3,
  });
  expect(result.frozen).toBe(true);
  expect(result.version).toBe(3);
});

test("negotiate feeds the prior contract + critique into the next propose", async () => {
  const seen: Array<number | null> = [];
  await negotiate({
    propose: async (prev) => { seen.push(prev ? prev.contract.version : null); return c((prev?.contract.version ?? 0) + 1); },
    critique: async (contract) => ({ agreed: contract.version >= 2, contract, critique: `critique of v${contract.version}` }),
    maxRounds: 5,
  });
  expect(seen).toEqual([null, 1]); // round 2's propose saw round 1's contract
});

test("negotiate runs checkStop at the top of each round and aborts if it throws", async () => {
  let proposes = 0;
  let checks = 0;
  await expect(
    negotiate({
      propose: async (prev) => { proposes++; return c((prev?.contract.version ?? 0) + 1); },
      critique: async (contract) => ({ agreed: false, contract, critique: "crit" }),
      maxRounds: 5,
      checkStop: () => { checks++; if (checks >= 2) throw new Error("halt"); },
    }),
  ).rejects.toThrow("halt");
  expect(checks).toBe(2);
  expect(proposes).toBe(1);
});
