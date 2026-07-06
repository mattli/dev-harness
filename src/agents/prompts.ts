import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
type PromptName = "planner" | "generator" | "evaluator" | "contract-negotiation";
export function loadPrompt(name: PromptName): string {
  return readFileSync(join(root, `${name}.md`), "utf8");
}
