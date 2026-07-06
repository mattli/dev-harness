import { expect, test } from "vitest";
import { TestSuiteVerifier } from "../src/verifier/test-suite.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = () => mkdtempSync(join(tmpdir(), "verify-"));

test("passing command → passed:true", async () => {
  const v = new TestSuiteVerifier("node -e \"process.exit(0)\"");
  const r = await v.verify(dir());
  expect(r.passed).toBe(true);
  expect(r.findings).toEqual([]);
});

test("failing command → passed:false with findings", async () => {
  const v = new TestSuiteVerifier("node -e \"console.error('boom'); process.exit(1)\"");
  const r = await v.verify(dir());
  expect(r.passed).toBe(false);
  expect(r.findings.join("\n")).toContain("boom");
});
