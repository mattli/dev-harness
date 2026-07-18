import { expect, test } from "vitest";
import { extractJsonObject } from "../src/agents/extract-json.js";

const hasCriteria = (o: unknown): o is { criteria: unknown[] } =>
  typeof o === "object" && o !== null && Array.isArray((o as { criteria?: unknown }).criteria);

test("extracts clean bare JSON", () => {
  const o = extractJsonObject('{"criteria":[{"id":"c1"}]}', hasCriteria);
  expect(o.criteria).toHaveLength(1);
});

test("skips a stray brace in brace-heavy preamble prose (the mrpk71c5 failure)", () => {
  const text =
    "The helper returns a dict like {key: value} and uses f\"{name}\". Contract:\n" +
    '{"criteria":[{"id":"c1","description":"d","verifyBy":"v"}]}';
  const o = extractJsonObject(text, hasCriteria);
  expect((o.criteria[0] as { id: string }).id).toBe("c1");
});

test("prefers a fenced ```json block", () => {
  const text = "prose {stray} here\n```json\n{\"criteria\":[{\"id\":\"fenced\"}]}\n```\ntrailing {junk}";
  const o = extractJsonObject(text, hasCriteria);
  expect((o.criteria[0] as { id: string }).id).toBe("fenced");
});

test("skips a valid-but-wrong-shape object and finds the right one", () => {
  const text = '{"unrelated":true} then the real one {"criteria":[{"id":"real"}]}';
  const o = extractJsonObject(text, hasCriteria);
  expect((o.criteria[0] as { id: string }).id).toBe("real");
});

test("ignores braces inside string values when balancing", () => {
  const text = '{"criteria":[{"id":"c1","description":"emits f\\"{x}\\" markers}}}"}]}';
  const o = extractJsonObject(text, hasCriteria);
  expect((o.criteria[0] as { id: string }).id).toBe("c1");
});

test("tolerates a stray unbalanced double-quote in preamble prose (quote-desync regression)", () => {
  // A single `"` in prose before an unfenced reply must not desync string
  // tracking and swallow the real object's opening brace.
  const text = 'the field is 6" wide, contract: {"criteria":[{"id":"ok"}]}';
  const o = extractJsonObject(text, hasCriteria);
  expect((o.criteria[0] as { id: string }).id).toBe("ok");
});

test("throws (does not silently guess) when two shape-valid objects appear unfenced", () => {
  // e.g. the model echoed the schema before its real answer — ambiguous. The
  // pre-fix code crashed loudly here; we must not regress to a silent wrong pick.
  const text = '{"criteria":[{"id":"a"}]} and also {"criteria":[{"id":"b"}]}';
  expect(() => extractJsonObject(text, hasCriteria)).toThrow(/ambiguous/i);
});

test("a fenced block disambiguates even when prose also echoes a shape-valid object", () => {
  const text = 'I will output {"criteria":[{"id":"echo"}]} then:\n```json\n{"criteria":[{"id":"real"}]}\n```';
  const o = extractJsonObject(text, hasCriteria);
  expect((o.criteria[0] as { id: string }).id).toBe("real");
});

test("throws a legible error (with a snippet) when no matching object exists", () => {
  expect(() => extractJsonObject("sorry, I could not produce a contract", hasCriteria)).toThrow(
    /no JSON object matching the expected shape/,
  );
});
