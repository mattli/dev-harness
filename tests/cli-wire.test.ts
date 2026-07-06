import { expect, test } from "vitest";
import { wireDeps } from "../src/cli/wire.js";
import { loadConfig } from "../src/config/load.js";

test("wireDeps returns a fully-populated LoopDeps", () => {
  const cfg = loadConfig({ runId: "r1", goal: "g", projectPath: "/tmp/app" });
  const deps = wireDeps(cfg, (async function* () {})() as any);
  for (const k of ["planSprints", "proposeContract", "critiqueContract", "generateCode",
                   "runVerifier", "evaluateArtifact", "createWorktree", "removeWorktree", "nowMs", "runsDir"]) {
    expect(deps).toHaveProperty(k);
  }
});
