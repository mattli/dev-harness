import { expect, test } from "vitest";
import { invokeAgent, type QueryFn } from "../src/agents/invoke.js";

const fakeQuery: QueryFn = async function* () {
  yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } } as any;
  yield { type: "result", subtype: "success", total_cost_usd: 0.02, usage: { input_tokens: 5, output_tokens: 3 } } as any;
};

test("accumulates text and cost from SDK stream", async () => {
  const r = await invokeAgent({ queryFn: fakeQuery, prompt: "hi", systemPrompt: "sys", model: "m" });
  expect(r.text).toBe("hello");
  expect(r.costUsd).toBe(0.02);
  expect(r.tokens).toBe(8);
});

test("retries a transient failure then succeeds", async () => {
  let calls = 0;
  const flaky: QueryFn = async function* () {
    calls++;
    if (calls === 1) throw new Error("overloaded_error");
    yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } } as any;
    yield { type: "result", subtype: "success", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } } as any;
  };
  const r = await invokeAgent({ queryFn: flaky, prompt: "hi", systemPrompt: "s", model: "m", sleep: async () => {} });
  expect(r.text).toBe("ok");
  expect(calls).toBe(2);
});
