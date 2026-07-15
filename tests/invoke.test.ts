import { expect, test } from "vitest";
import { invokeAgent, isUsageLimitError, type QueryFn } from "../src/agents/invoke.js";
import { BudgetHalt } from "../src/budget/tracker.js";

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

test("isUsageLimitError matches known usage-limit signals", () => {
  expect(isUsageLimitError({ status: 429 })).toBe(true);
  expect(isUsageLimitError(new Error("Usage limit reached. Resets at ..."))).toBe(true);
  expect(isUsageLimitError({ error: { type: "rate_limit_error" } })).toBe(true);
  expect(isUsageLimitError(new Error("connection reset"))).toBe(false);
  expect(isUsageLimitError(null)).toBe(false);
});

test("isUsageLimitError does not match benign 429-substrings or 'resets at' text", () => {
  expect(isUsageLimitError(new Error("Error 4290"))).toBe(false);
  expect(isUsageLimitError(new Error("job resets at midnight"))).toBe(false);
  expect(isUsageLimitError(new Error("listening on port 4291"))).toBe(false);
});

test("invokeAgent halts (BudgetHalt) on a usage-limit WITHOUT retrying", async () => {
  let calls = 0;
  const queryFn = () => { calls++; throw new Error("Usage limit reached"); };
  await expect(invokeAgent({ queryFn: queryFn as any, prompt: "p", systemPrompt: "s", model: "m", maxRetries: 3, sleep: async () => {} }))
    .rejects.toBeInstanceOf(BudgetHalt);
  expect(calls).toBe(1); // not retried
});
