// The Anthropic Messages API as a model provider (FIRECRAWL_PI_SPEC.md §14): the request one budgeted call
// sends and what it reads back. The transport, the reservation and the settlement stay in extract.mjs; this
// file knows only the wire format.
//
// Three differences from the OpenAI-compatible chat API shape the request:
//   - the system prompt is a top-level field, and max_tokens is always required;
//   - claude-haiku-5-5 and claude-opus-5-5 both refuse a non-default temperature, so none is sent;
//   - input_tokens excludes the cached tokens that cache_read_input_tokens and cache_creation_input_tokens
//     report separately, where an OpenAI prompt_tokens count includes them.
export const ANTHROPIC_VERSION = "2023-06-01";

export const messagesHeaders = (key) => ({ "content-type": "application/json", accept: "application/json", "anthropic-version": ANTHROPIC_VERSION, ...(key ? { "x-api-key": key } : {}) });

// The output grammar the API compiles from a schema holds at most 16 union-typed fields (a type array or an
// anyOf); a schema with more is refused with a 400 (measured 2026-10-17: 16 accepted, 17 refused). toStrict
// makes every property nullable, so a schema of more than about 16 properties would never be accepted.
export const MAX_UNIONS = 16;
export function unions(s) {
  if (!s || typeof s !== "object") return 0;
  let n = s.anyOf || (Array.isArray(s.type) && s.type.length > 1) ? 1 : 0;
  for (const branch of s.anyOf ?? []) n += unions(branch);
  for (const property of Object.values(s.properties ?? {})) n += unions(property);
  return n + unions(s.items);
}

// messages: the chat as the OpenAI-compatible path takes it (a system turn, then the user turn); schema: the
// strict schema; effort: the model policy's reasoningEffort. "none" is the policy's word for no reasoning, which
// Haiku accepts as thinking off; any other level is the output effort of a model that always thinks. No
// cache_control is sent, so nothing is written to the cache.
// A schema over the grammar limit is not sent as a grammar: it goes into the system prompt, and the engine
// checks the answer against it exactly as it checks a constrained one (`guided`).
export function messagesRequest({ model, effort, messages, schema, maxOutputTokens }) {
  const guided = unions(schema) > MAX_UNIONS;
  const system = [...messages.filter((m) => m.role === "system").map((m) => m.content),
    ...(guided ? [`Reply with only one JSON object that matches this JSON Schema, with no text before or after it:\n${JSON.stringify(schema)}`] : [])].join("\n\n");
  const reasons = effort !== undefined && effort !== null && effort !== "none";
  const output = { ...(reasons ? { effort } : {}), ...(guided ? {} : { format: { type: "json_schema", schema } }) };
  return {
    path: "/v1/messages", guided,
    body: { model, max_tokens: maxOutputTokens, ...(system ? { system } : {}), messages: messages.filter((m) => m.role !== "system"),
      ...(effort === "none" ? { thinking: { type: "disabled" } } : {}),
      ...(Object.keys(output).length ? { output_config: output } : {}) },
  };
}

// An answer a model fenced as a code block, despite being told to reply with the bare object.
const unfence = (t) => t.replace(/^\s*```(?:json)?[ \t]*\n/i, "").replace(/\n[ \t]*```\s*$/, "");

// The answer in the shape the adapter settles: the text block (a thinking block may come first), a refusal
// (a decline is HTTP 200 with stop_reason "refusal"), the finish reason in the chat API's words, and the
// usage counted as the adapter's own: promptTokens holds every input token, cached ones included.
export function readMessages(json, { guided = false } = {}) {
  const text = Array.isArray(json?.content) ? json.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text) : [];
  const reason = json?.stop_reason ?? null;
  const u = json?.usage;
  const read = u?.cache_read_input_tokens ?? 0, written = u?.cache_creation_input_tokens ?? 0;
  const joined = text.join("");
  return {
    resolvedModel: typeof json?.model === "string" ? json.model : null,
    content: text.length ? (guided ? unfence(joined) : joined) : null,
    // stop_reason decides a refusal; its label falls through empty strings so a refusal is never read as an answer.
    refusal: reason === "refusal" ? String(json?.stop_details?.category || json?.stop_details?.explanation || "refusal").slice(0, 200) : null,
    finishReason: reason === "max_tokens" || reason === "model_context_window_exceeded" ? "length" : reason === "end_turn" ? "stop" : reason,
    counts: [u?.input_tokens + read + written, u?.output_tokens, read, written],
  };
}
