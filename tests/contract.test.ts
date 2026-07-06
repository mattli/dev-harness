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
    propose: async (prev) => c((prev?.version ?? 0) + 1),
    critique: async (contract) => { round++; return { agreed: round >= 2, contract }; },
    maxRounds: 5,
  });
  expect(result.frozen).toBe(true);
  expect(result.version).toBe(2);
});

test("negotiate force-freezes at round cap", async () => {
  const result = await negotiate({
    propose: async (prev) => c((prev?.version ?? 0) + 1),
    critique: async (contract) => ({ agreed: false, contract }),
    maxRounds: 3,
  });
  expect(result.frozen).toBe(true);
  expect(result.version).toBe(3);
});
