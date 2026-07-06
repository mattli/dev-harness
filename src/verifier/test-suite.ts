import { execa } from "execa";
import type { Verifier, VerifierResult } from "./types.js";

export class TestSuiteVerifier implements Verifier {
  constructor(private command: string) {}
  async verify(worktreePath: string): Promise<VerifierResult> {
    const res = await execa(this.command, {
      cwd: worktreePath, shell: true, reject: false, all: true,
    });
    if (res.exitCode === 0) return { passed: true, findings: [] };
    const findings = (res.all ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-20);
    return { passed: false, findings };
  }
}
