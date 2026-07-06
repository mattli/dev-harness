export interface AgentResult { text: string; costUsd: number; tokens: number; toolCalls: string[]; }

export type SDKMessage =
  | { type: "assistant"; message: { content: Array<{ type: string; text?: string; name?: string }> } }
  | { type: "result"; subtype: string; total_cost_usd?: number; usage?: { input_tokens: number; output_tokens: number } }
  | { type: string; [k: string]: unknown };

export type QueryFn = (args: {
  prompt: string;
  options: { model: string; systemPrompt: string; cwd?: string; permissionMode?: string };
}) => AsyncIterable<SDKMessage>;

export interface InvokeOpts {
  queryFn: QueryFn;
  prompt: string;
  systemPrompt: string;
  model: string;
  cwd?: string;
  permissionMode?: string;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function invokeAgent(opts: InvokeOpts): Promise<AgentResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? realSleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await runOnce(opts);
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) await sleep(attempt * 1000);
    }
  }
  throw lastErr;
}

async function runOnce(opts: InvokeOpts): Promise<AgentResult> {
  let text = "";
  let costUsd = 0;
  let tokens = 0;
  const toolCalls: string[] = [];
  for await (const msg of opts.queryFn({
    prompt: opts.prompt,
    options: { model: opts.model, systemPrompt: opts.systemPrompt, cwd: opts.cwd, permissionMode: opts.permissionMode },
  })) {
    if (msg.type === "assistant") {
      const assistantMsg = msg as Extract<SDKMessage, { type: "assistant" }>;
      for (const block of assistantMsg.message.content) {
        if (block.type === "text" && block.text) text += block.text;
        if (block.type === "tool_use" && block.name) toolCalls.push(block.name);
      }
    } else if (msg.type === "result") {
      const r = msg as Extract<SDKMessage, { type: "result" }>;
      costUsd = r.total_cost_usd ?? 0;
      tokens = (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0);
    }
  }
  return { text, costUsd, tokens, toolCalls };
}
