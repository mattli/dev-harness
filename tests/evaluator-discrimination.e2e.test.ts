import { expect, test } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { evaluateArtifact } from "../src/agents/evaluator.js";
import type { Contract } from "../src/contract/types.js";

// Gated real-evaluator test (C2, joint E2E assertion b): proves the evaluator
// DISCRIMINATES on the artifact, not the verifier boolean. Both artifacts pass
// the verifier; only one satisfies the on-goal contract. A broken evaluator that
// scores everything low (or everything high) fails this — the GAP is the assertion.
const maybe = process.env.RUN_E2E === "1" ? test : test.skip;

const onGoalContract: Contract = {
  version: 1,
  frozen: true,
  criteria: [
    { id: "c1", description: "A file sum.js exports a function sum(a, b) that returns a + b", verifyBy: "node:test asserts sum(2, 3) === 5" },
    { id: "c2", description: "sum handles negative and zero inputs", verifyBy: "node:test asserts sum(-1, 1) === 0" },
  ],
};

const onGoalDiff = `diff --git a/sum.js b/sum.js
new file mode 100644
--- /dev/null
+++ b/sum.js
@@ -0,0 +1,2 @@
+function sum(a, b) { return a + b; }
+module.exports = { sum };
`;

// Off-goal but test-green: a perfectly good palindrome checker that has nothing
// to do with the sum contract. The verifier passes; the contract is unmet.
const offGoalDiff = `diff --git a/isPalindrome.js b/isPalindrome.js
new file mode 100644
--- /dev/null
+++ b/isPalindrome.js
@@ -0,0 +1,4 @@
+function isPalindrome(s) {
+  return s === s.split('').reverse().join('');
+}
+module.exports = { isPalindrome };
`;

maybe("evaluator scores on-goal high and off-goal low against the same contract", async () => {
  const deps = { queryFn: query as any, model: "claude-opus-4-8", goal: "unused-in-evaluate" };
  const verifierPassed = { passed: true, findings: [] };

  const on = await evaluateArtifact(deps, onGoalContract, onGoalDiff, verifierPassed);
  const off = await evaluateArtifact(deps, onGoalContract, offGoalDiff, verifierPassed);

  expect(on.score).not.toBeNull();
  expect(off.score).not.toBeNull();
  const onScore = on.score as number;
  const offScore = off.score as number;

  // Off-goal-but-test-green must NOT clear the advance bar.
  expect(offScore).toBeLessThan(85);
  // On-goal must clear it comfortably...
  expect(onScore).toBeGreaterThan(85);
  // ...and the gap is the real proof of discrimination (guards against a
  // uniformly-harsh or uniformly-lenient evaluator passing the test).
  expect(onScore - offScore).toBeGreaterThanOrEqual(20);
}, 180000);
