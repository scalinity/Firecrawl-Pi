// The Messages API wire format (src/anthropic.mjs): the request a budgeted call sends, the grammar limit that
// decides whether the schema travels as a grammar or as prompt text, and the answer read back. The adapter
// around it (reservation, settlement, failure classes) is tested through the fixture model in m5-extract.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { messagesHeaders, messagesRequest, readMessages, unions, forGrammar, MAX_UNIONS } from "../src/anthropic.mjs";
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

// Every node of a schema, with its path.
const nodes = (s, path = "$") => !s || typeof s !== "object" ? [] : [[path, s], ...Object.entries(s.properties ?? {}).flatMap(([k, v]) => nodes(v, `${path}.${k}`)), ...nodes(s.items, `${path}[]`), ...(s.anyOf ?? []).flatMap((b, i) => nodes(b, `${path}|${i}`))];

test("a nullable enum is sent as an anyOf, because the grammar compiler refuses a type array that carries an enum", () => {
  const strict = toStrict({ type: "object", required: ["kind"], properties: {
    kind: { type: "string", enum: ["x", "y"], description: "The kind." }, n: { type: "integer", enum: [1, 2] }, on: { type: "boolean", enum: [true] },
    mixed: { type: ["string", "number"], enum: ["a", 1, 2.5] }, list: { type: "array", items: { type: "string", enum: ["low", "high"] } },
    rows: { type: "array", items: { type: "object", properties: { level: { type: "string", enum: ["p", "q"] } }, required: ["level"] } } } });
  assert.deepEqual(strict.properties.kind.type, ["string", "null"], "precondition: toStrict does produce a type array with an enum");
  const sent = forGrammar(strict);
  assert.deepEqual(sent.properties.kind, { description: "The kind.", anyOf: [{ type: "string", enum: ["x", "y"] }, { type: "null" }] });
  assert.deepEqual(sent.properties.n.anyOf, [{ type: "integer", enum: [1, 2] }, { type: "null" }]);
  assert.deepEqual(sent.properties.on.anyOf, [{ type: "boolean", enum: [true] }, { type: "null" }]);
  assert.deepEqual(sent.properties.mixed.anyOf, [{ type: "string", enum: ["a"] }, { type: "number", enum: [1, 2.5] }, { type: "null" }].filter(Boolean), "values go to the branch of their own type");
  assert.deepEqual(sent.properties.list.items, { type: "string", enum: ["low", "high"] }, "an enum that is not nullable is left alone");
  assert.deepEqual(sent.properties.rows.anyOf ?? null, null, "an array that is only nullable stays a type array");
  assert.deepEqual(sent.properties.rows.items.properties.level.anyOf, [{ type: "string", enum: ["p", "q"] }, { type: "null" }], "rewritten at any depth");
  for (const [path, node] of nodes(sent)) assert.equal(Array.isArray(node.type) && Array.isArray(node.enum), false, `${path} still combines a type array and an enum`);
  assert.equal(unions(sent), unions(strict), "the union count the grammar limit is judged on is unchanged");
  assert.deepEqual(strict.properties.kind.enum, ["x", "y", null], "the schema answers are validated against is not rewritten");
  assert.deepEqual(forGrammar(undefined), undefined);
});

test("the request carries the rewritten schema in the grammar and the original in the prompt", () => {
  const strict = toStrict({ type: "object", required: ["kind"], properties: { kind: { type: "string", enum: ["x", "y"] } } });
  const grammar = messagesRequest({ model: "m", effort: "none", messages: CHAT, schema: strict, maxOutputTokens: 100 });
  assert.equal(grammar.guided, false);
  for (const [path, node] of nodes(grammar.body.output_config.format.schema)) assert.equal(Array.isArray(node.type) && Array.isArray(node.enum), false, path);
  // A guided request puts the schema in the prompt for a model to read, where the type array and the enum say what they mean.
  const wide = toStrict({ type: "object", properties: { kind: { type: "string", enum: ["x", "y"] }, ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, { type: "string" }])) } });
  const guided = messagesRequest({ model: "m", effort: "none", messages: CHAT, schema: wide, maxOutputTokens: 100 });
  assert.equal(guided.guided, true);
  assert.ok(guided.body.system.includes("\"enum\":[\"x\",\"y\",null]"));
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
  // The label is whichever of category and explanation says something; an empty string is not a label, and a refusal is never read as an answer.
  assert.equal(stop("refusal", { stop_details: { type: "refusal", category: null, explanation: "Declined by policy." } }).refusal, "Declined by policy.");
  assert.equal(stop("refusal", { stop_details: { type: "refusal", category: null, explanation: "" } }).refusal, "refusal");
  assert.equal(stop("refusal", { stop_details: { type: "refusal", category: "", explanation: null } }).refusal, "refusal");
  assert.equal(stop("end_turn").refusal, null);
});

test("missing or malformed usage and content read as unknown, never as zero", () => {
  const none = readMessages({ model: "m", stop_reason: "end_turn", content: [] });
  assert.equal(none.content, null);
  assert.ok(none.counts.some((n) => !Number.isSafeInteger(n)), "the adapter settles at the reservation when counts are unusable");
  // One count present does not make the others zero.
  const partial = readMessages({ model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "{}" }], usage: { output_tokens: 2 } });
  assert.equal(Number.isSafeInteger(partial.counts[0]), false, "no input_tokens: the prompt count is unknown, not the cache counts alone");
  assert.equal(partial.counts[1], 2);
  assert.equal(readMessages(null).resolvedModel, null);
  assert.equal(readMessages({ content: "text", stop_reason: "end_turn" }).content, null);
});

test("a guided answer loses a code fence around it; a constrained one is returned as sent", () => {
  const fenced = { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "```json\n{\"a\":1}\n```" }], usage: { input_tokens: 1, output_tokens: 1 } };
  assert.equal(readMessages(fenced, { guided: true }).content, "{\"a\":1}");
  assert.equal(readMessages(fenced).content, "```json\n{\"a\":1}\n```");
  assert.equal(readMessages({ ...fenced, content: [{ type: "text", text: "{\"a\":1}" }] }, { guided: true }).content, "{\"a\":1}");
});
