export interface VerifierResult { passed: boolean; findings: string[]; }
export interface Verifier { verify(worktreePath: string): Promise<VerifierResult>; }
