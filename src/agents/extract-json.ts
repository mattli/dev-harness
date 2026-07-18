/** Robustly pull a JSON object out of an LLM reply.
 *
 * Replaces the fragile `text.slice(indexOf("{"), lastIndexOf("}") + 1)` grab
 * that crashed run mrpk71c5: when a task discusses code with braces (Python
 * dicts, f-strings like f"{x}", build_system_instruction), the model writes a
 * stray `{` in its preamble prose, the slice starts there, and JSON.parse dies
 * with "Expected property name or '}' at position 1". This is the project
 * lesson "Don't Parse Model Output by Position — Emit a Marker and Key on It":
 * we prefer a fenced ```json marker, and key on the object's SHAPE (`isValid`)
 * rather than its position, so a stray brace can never win.
 *
 * Strategy, in order of preference:
 *   1. Fenced ```json / ``` blocks — the explicit marker the prompt requests.
 *      Return the first shape-valid object found inside a fence.
 *   2. Fallback: scan the whole reply and require EXACTLY ONE shape-valid
 *      top-level object. A stray prose brace yields zero-or-one candidate, so
 *      the common case still resolves; but if TWO shape-valid objects appear
 *      (e.g. the model echoed the schema example before its real answer) the
 *      reply is ambiguous and we throw rather than silently pick the wrong one.
 *      The pre-fix code crashed loudly in that case — we preserve loud failure.
 */
export function extractJsonObject<T>(text: string, isValid: (o: unknown) => o is T): T {
  // 1) Prefer fenced blocks — the marker the prompt asks for.
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    for (const candidate of balancedJsonObjects(m[1])) {
      if (isValid(candidate)) return candidate;
    }
  }

  // 2) Unfenced fallback: require exactly one shape-valid object.
  const matches: T[] = [];
  for (const candidate of balancedJsonObjects(text)) {
    if (isValid(candidate)) matches.push(candidate);
  }
  if (matches.length === 1) return matches[0];
  const snippet = text.slice(0, 300);
  if (matches.length > 1) {
    throw new Error(
      `ambiguous model reply: ${matches.length} JSON objects matched the expected shape; ` +
        `expected exactly one, or a single fenced \`\`\`json block. First 300 chars: ${snippet}`,
    );
  }
  throw new Error(`no JSON object matching the expected shape found in model reply. First 300 chars: ${snippet}`);
}

/** Yield each top-level balanced-brace region of `s`, JSON-parsed.
 *
 * Quote/escape tracking runs ONLY inside a candidate object (brace depth >= 1),
 * so it correctly skips braces that live in JSON string values (e.g. an
 * f-string "{x}"). While at depth 0 (scanning prose between/around objects) it
 * ignores quotes entirely — otherwise a single stray `"` in preamble prose
 * would desync the string state and swallow the real object's opening brace.
 * Regions that fail JSON.parse (e.g. `{key: value}` prose) are silently skipped.
 */
function* balancedJsonObjects(s: string): Generator<unknown> {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (depth === 0) {
      // In prose: quotes are meaningless; only an opening brace starts a candidate.
      if (ch === "{") {
        start = i;
        depth = 1;
        inStr = false;
        esc = false;
      }
      continue;
    }
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const sub = s.slice(start, i + 1);
        try {
          yield JSON.parse(sub);
        } catch {
          /* not valid JSON — skip this region */
        }
        start = -1;
      }
    }
  }
}
