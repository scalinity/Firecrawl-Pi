// The Messages API wire format (src/anthropic.mjs): the request a budgeted call sends, the grammar limit that
// decides whether the schema travels as a grammar or as prompt text, and the answer read back. The adapter
// around it (reservation, settlement, failure classes) is tested through the fixture model in m5-extract.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { messagesHeaders, messagesRequest, readMessages, unions, MAX_UNIONS } from "../src/anthropic.mjs";
import { toStrict } from "../src/jsonschema.mjs";

const CHAT = [{ role: "system", content: "Extract." }, { role: "user", content: "Content." }];
const objectOf = (n, type = "string") => ({ type: "object", properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type }])), required: ["f0"] });

test("headers carry the key as x-api-key and the API version, and no bearer token", () => {
  assert.deepEqual(messagesHeaders("sk-ant-test"), { "content-type": "application/json", accept: "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-test" });
  assert.equal(Object.hasOwn(messagesHeaders(null), "x-api-key"), false);
});

test("effort none turns thinking off and sends no effort; any other effort is the output effort and thinking is left alone", () => {
  const strict = toStrict(objectOf(2));
  const none = messagesRequest({ model: "claude-haiku-5-5", effort: "none", messages: CHAT, schema: strict, maxOutputTokens: 4000 });
  assert.equal(none.path, "/v1/messages");
  assert.deepEqual(none.body.thinking, { type: "disabled" });
  assert.deepEqual(Object.keys(none.body.output_config), ["format"]);
  const high = messagesRequest({ model: "claude-opus-5-5", effort: "high", messages: CHAT, schema: strict, maxOutputTokens: 16000 });
  assert.equal(high.body.output_config.effort, "high");
  assert.equal(Object.hasOwn(high.body, "thinking"), false);
  assert.equal(high.body.max_tokens, 16000);
  for (const { body } of [none, high]) {
    assert.equal(body.system, "Extract.");
    assert.deepEqual(body.messages, [{ role: "user", content: "Content." }]);
    for (const key of ["temperature", "top_p", "top_k"]) assert.equal(Object.hasOwn(body, key), false, key);
    assert.equal(JSON.stringify(body).includes("cache_control"), false, "nothing is written to the cache");
  }
});

test("the grammar limit is 16 union fields: a schema at the limit is a grammar, one field over is prompt text", () => {
  assert.equal(MAX_UNIONS, 16);
  // toStrict makes every property nullable, so a flat schema of n properties holds n unions.
  assert.equal(unions(toStrict(objectOf(16))), 16);
  assert.equal(unions(toStrict(objectOf(17))), 17);
  const atLimit = messagesRequest({ model: "m", effort: "none", messages: CHAT, schema: toStrict(objectOf(16)), maxOutputTokens: 100 });
  assert.equal(atLimit.guided, false);
  assert.equal(atLimit.body.output_config.format.type, "json_schema");
  const over = messagesRequest({ model: "m", effort: "none", messages: CHAT, schema: toStrict(objectOf(17)), maxOutputTokens: 100 });
  assert.equal(over.guided, true);
  assert.equal(Object.hasOwn(over.body, "output_config"), false);
  assert.match(over.body.system, /^Extract\.\n\nReply with only one JSON object that matches this JSON Schema/);
  assert.ok(over.body.system.includes("\"f16\""));
  // At a reasoning effort the effort still travels when the grammar does not.
  const overHigh = messagesRequest({ model: "m", effort: "high", messages: CHAT, schema: toStrict(objectOf(17)), maxOutputTokens: 100 });
  assert.deepEqual(overHigh.body.output_config, { effort: "high" });
});

test("unions counts type arrays and anyOf wherever they nest", () => {
  assert.equal(unions({ type: "string" }), 0);
  assert.equal(unions({ type: ["string", "null"] }), 1);
  assert.equal(unions({ anyOf: [{ type: "string" }, { type: "object", properties: { a: { type: ["number", "null"] } } }] }), 2);
  const nested = toStrict({ type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] } } }, required: ["rows"] });
  assert.equal(unions(nested), 3, "rows, and the two fields of its items");
  assert.equal(unions(undefined), 0);
});

test("the answer is the text block even when a thinking block comes first, and usage counts cached tokens in the prompt", () => {
  const r = readMessages({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "{\"a\":1}" }],
    usage: { input_tokens: 60, cache_creation_input_tokens: 30, cache_read_input_tokens: 10, output_tokens: 20 } });
  assert.deepEqual(r, { resolvedModel: "claude-opus-5-5", content: "{\"a\":1}", refusal: null, finishReason: "stop", counts: [100, 20, 10, 30] });
  // Cache counters are absent or null when nothing was cached.
  assert.deepEqual(readMessages({ model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: null } }).counts, [5, 2, 0, 0]);
});

test("stop reasons map to the adapter\x27s words, and a refusal carries its category", () => {
  const stop = (stop_reason, extra = {}) => readMessages({ model: "m", stop_reason, content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 }, ...extra });
  assert.equal(stop("end_turn").finishReason, "stop");
  assert.equal(stop("max_tokens").finishReason, "length");
  assert.equal(stop("model_context_window_exceeded").finishReason, "length");
  assert.equal(stop("pause_turn").finishReason, "pause_turn");
  assert.equal(stop("refusal", { stop_details: { type: "refusal", category: "bio", explanation: null } }).refusal, "bio");
  assert.equal(stop("refusal").refusal, "refusal");
  assert.equal(stop("end_turn").refusal, null);
});

test("missing or malformed usage and content read as unknown, never as zero", () => {
  const none = readMessages({ model: "m", stop_reason: "end_turn", content: [] });
  assert.equal(none.content, null);
  assert.ok(none.counts.some((n) => !Number.isSafeInteger(n)), "the adapter settles at the reservation when counts are unusable");
  assert.equal(readMessages(null).resolvedModel, null);
  assert.equal(readMessages({ content: "text", stop_reason: "end_turn" }).content, null);
});

test("a guided answer loses a code fence around it; a constrained one is returned as sent", () => {
  const fenced = { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "```json\n{\"a\":1}\n```" }], usage: { input_tokens: 1, output_tokens: 1 } };
  assert.equal(readMessages(fenced, { guided: true }).content, "{\"a\":1}");
  assert.equal(readMessages(fenced).content, "```json\n{\"a\":1}\n```");
  assert.equal(readMessages({ ...fenced, content: [{ type: "text", text: "{\"a\":1}" }] }, { guided: true }).content, "{\"a\":1}");
});
