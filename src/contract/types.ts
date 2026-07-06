export interface Criterion { id: string; description: string; verifyBy: string; }
export interface Contract { version: number; criteria: Criterion[]; frozen: boolean; }
