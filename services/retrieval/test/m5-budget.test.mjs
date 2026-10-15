// The budget policy's validation, rate cards by date, the cost arithmetic, the token estimate, the breaker
// and the schema subset (src/budget.mjs, src/jsonschema.mjs, src/policy.mjs's search and selection parts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadBudgetPolicy, rateCardFor, modelCost, maxModelCost, estimateTokens, Breaker, periodStarts, paidDispatchActive } from "../src/budget.mjs";
import { checkSchema, toStrict, validate, missingRequired } from "../src/jsonschema.mjs";
import { loadPolicy, loadSelection, defaultSelection } from "../src/policy.mjs";

const RAW = readFileSync(new URL("../policy/budget.json", import.meta.url), "utf8");
const mutate = (f) => { const j = JSON.parse(RAW); f(j); return JSON.stringify(j); };

test("an absolute validation lease expires even with the paid switch still on and after a month rollover (PRE-M9 C1)", () => {
  const b = loadBudgetPolicy(mutate((p) => { p.validationExpiresAt = "2026-10-03T02:00:00Z"; }));
  assert.equal(paidDispatchActive(b, true, Date.parse("2026-10-03T01:59:59Z")), true);
  assert.equal(paidDispatchActive(b, false, Date.parse("2026-10-03T01:59:59Z")), false);
  assert.equal(paidDispatchActive(b, true, Date.parse(b.validationExpiresAt)), false);
  assert.equal(paidDispatchActive(b, true, Date.parse("2026-11-01T00:00:00Z")), false);
  for (const v of [null, "2026-02-30T02:00:00Z", "2026-10-03", "bad"]) assert.throws(() => loadBudgetPolicy(mutate((p) => { p.validationExpiresAt = v; })), /validationExpiresAt/);
});

test("the deployed budget policy loads: approved proxy and monthly LLM caps, other paid caps zero, paid defaults and unpaid fixtures", () => {
  const b = loadBudgetPolicy(RAW);
  // Proxy $1/day and $2/month; LLM $20/month; paid work shares the $1/day cap.
  assert.deepEqual(b.categories.proxy.caps, { day: 1000000, month: 2000000 });
  assert.deepEqual(b.categories.llm.caps, { month: 20000000 });
  assert.equal(b.paidTotal.caps.day, 1000000);
  for (const [name, c] of Object.entries(b.categories).filter(([n, c]) => c.paid && !["proxy", "llm"].includes(n))) for (const v of Object.values(c.caps)) assert.equal(v, 0, name);
  assert.equal(b.providers[b.models[b.extraction.defaultModel].provider].paid, true);
  assert.equal(b.providers[b.parsers[b.parsing.defaultParser].provider].paid, true);
  assert.equal(b.extraction.maxInputTokens, 32000);
  assert.equal(b.extraction.maxOutputTokens, 4000);
  assert.equal(b.extraction.maxRepairs, 1);
});

test("the budget policy refuses what would open a gap", () => {
  for (const [why, f] of [
    ["unknown key", (j) => { j.extra = 1; }],
    ["negative cap", (j) => { j.categories.llm.caps.day = -1; }],
    ["a paid provider on a fixture host", (j) => { j.providers.openai.baseUrl = "http://model.fixture.fcpi.test:8080/v1"; }],
    ["an unpaid provider on the Internet", (j) => { j.providers["fixture-model"].baseUrl = "http://api.example.com/v1"; }],
    ["a paid model on an unpaid category", (j) => { j.models["gpt-6-luna"].category = "fixture"; }],
    ["overlapping rate cards", (j) => { j.rateCards.push({ ...j.rateCards[0], id: "dup", effectiveFrom: "2026-10-01" }); }],
    ["a rate card for an unknown subject", (j) => { j.rateCards.push({ ...j.rateCards[0], id: "x", subject: "gpt-9" }); }],
    ["input cap past spec §14", (j) => { j.extraction.maxInputTokens = 64000; }],
    ["two repairs", (j) => { j.extraction.maxRepairs = 2; }],
    ["output cap past spec §14", (j) => { j.extraction.maxOutputTokens = 8000; }],
    ["more than 100 pages", (j) => { j.parsing.maxPages = 200; }],
  ]) assert.throws(() => loadBudgetPolicy(mutate(f)), undefined, why);
});

test("rate cards apply by effective date; a card that has ended is none", () => {
  const b = loadBudgetPolicy(RAW);
  assert.equal(rateCardFor(b, "gpt-6-luna", new Date("2026-10-02T12:00:00Z")).id, "openai/gpt-6-luna@2026-10-02");
  assert.equal(rateCardFor(b, "gpt-6-luna", new Date("2026-09-25T12:00:00Z")), null, "before its start");
  assert.equal(rateCardFor(b, "fcpi-fixture-stale", new Date("2026-10-02T12:00:00Z")), null);
  assert.deepEqual(periodStarts(new Date("2026-09-26T23:59:59Z")), { day: "2026-09-26", month: "2026-09-01" });
});

test("costs round up; the reservation bounds any byte-level tokenizer's count", () => {
  const card = { inputPerMTok: 400000, cachedInputPerMTok: 100000, outputPerMTok: 1600000 };
  assert.equal(modelCost(card, { promptTokens: 1000000, completionTokens: 100000 }), 560000); // spec §28.2's $0.56
  assert.equal(modelCost(card, { promptTokens: 1, completionTokens: 0 }), 1);
  assert.equal(modelCost(card, { promptTokens: 1000, cachedTokens: 1000, completionTokens: 0 }), 100);
  assert.equal(maxModelCost(card, 96000, 4000), modelCost(card, { promptTokens: 96000, completionTokens: 4000 }));
  assert.ok(estimateTokens("a".repeat(3000)) === 1000 && estimateTokens("漢字".repeat(10)) === 20);
});

test("Luna prices cache writes separately and reserves at the highest input rate", () => {
  const b = loadBudgetPolicy(RAW), card = rateCardFor(b, "gpt-6-luna", new Date("2026-10-02T12:00:00Z"));
  assert.deepEqual(Object.keys(b.models).filter((m) => b.providers[b.models[m].provider].paid), ["gpt-6-luna", "gpt-6.1-sol"]);
  assert.equal(b.models["gpt-6-luna"].reasoningEffort, "none");
  assert.equal(modelCost(card, { promptTokens: 1000000, cachedTokens: 200000, cacheWriteTokens: 300000, completionTokens: 100000 }), 139500);
  assert.equal(maxModelCost(card, 1000000, 100000), 175000);
  assert.throws(() => loadBudgetPolicy(mutate((j) => { j.models["gpt-6-luna"].reasoningEffort = "high"; })), /reasoningEffort/);
  assert.throws(() => loadBudgetPolicy(mutate((j) => { j.rateCards[0].cacheWritePerMTok = -1; })), /cacheWritePerMTok/);
});

test("Sol reasoning and output limits are model policy while the default extraction keeps Luna's limits", () => {
  const b = loadBudgetPolicy(RAW);
  assert.equal(b.extraction.defaultModel, "gpt-6-luna");
  assert.equal(b.extraction.maxOutputTokens, 4000);
  assert.equal(b.models["gpt-6.1-sol"].reasoningEffort, "xhigh");
  assert.equal(b.models["gpt-6.1-sol"].maxOutputTokens, 16000);
  assert.equal(b.models["gpt-6.1-sol"].requestTimeoutMs, 90000);
  const card = rateCardFor(b, "gpt-6.1-sol", new Date("2026-10-15T12:00:00Z"));
  assert.deepEqual([card.inputPerMTok, card.cachedInputPerMTok, card.cacheWritePerMTok, card.outputPerMTok], [2000000, 100000, 2500000, 10000000]);
  for (const edit of [
    j => { j.models["gpt-6.1-sol"].reasoningEffort = "none"; },
    j => { j.models["gpt-6.1-sol"].maxOutputTokens = 16001; },
    j => { j.models["gpt-6.1-sol"].requestTimeoutMs = 90001; },
    j => { j.models["gpt-6-luna"].maxOutputTokens = 16000; },
  ]) assert.throws(() => loadBudgetPolicy(mutate(edit)));
});

test("the breaker opens after its failures, admits one probe, and closes on its success", () => {
  let t = 0;
  const b = new Breaker({ failures: 3, windowMs: 60000, openMs: 300000 }, () => t);
  b.failure(); b.failure();
  assert.equal(b.admit(), true);
  b.failure();
  assert.equal(b.state(), "open");
  assert.equal(b.admit(), false);
  t += 300001;
  assert.equal(b.admit(), true, "one probe");
  assert.equal(b.admit(), false, "only one");
  b.failure();
  assert.equal(b.state(), "open", "a failed probe opens it again");
  t += 300001;
  assert.equal(b.admit(), true);
  b.success();
  assert.equal(b.state(), "closed");
  // Failures outside the window do not add up.
  b.failure(); t += 61000; b.failure(); t += 61000; b.failure();
  assert.equal(b.state(), "closed");
});

test("strict schemas: every property required and nullable (a chunk may lack a value); required ones judged on the merge", () => {
  const s = { type: "object", properties: { a: { type: "string" }, b: { type: "array", items: { type: "object", properties: { c: { type: "integer" } } } }, e: { type: "string", enum: ["x", "y"] } }, required: ["a"] };
  assert.deepEqual(checkSchema(s, { maxBytes: 16384, maxDepth: 6, maxProperties: 100 }), { bytes: Buffer.byteLength(JSON.stringify(s)), properties: 4 });
  const t = toStrict(s);
  assert.deepEqual(t.required, ["a", "b", "e"]);
  assert.equal(t.additionalProperties, false);
  assert.deepEqual(t.properties.b.type, ["array", "null"]);
  assert.deepEqual(t.properties.b.items.properties.c.type, ["integer", "null"]);
  assert.deepEqual(t.properties.e.enum, ["x", "y", null]);
  assert.deepEqual(validate({ a: "ok", b: null, e: null }, t), []);
  assert.deepEqual(t.properties.a.type, ["string", "null"], "a required property is nullable per chunk");
  assert.deepEqual(validate({ a: 1, b: [{ c: "no" }], e: "z", extra: true }, t), ["$.extra: not in the schema", "$.a: expected string or null, got integer", "$.b[0].c: expected integer or null, got string", "$.e: not one of the allowed values"]);
  assert.deepEqual(validate({ a: "ok" }, t), ["$.b: missing", "$.e: missing"]);
  assert.deepEqual(missingRequired({ a: null, b: null, e: "x" }, s), ["$.a"]);
  assert.deepEqual(missingRequired({ a: "ok", b: [{ c: null }], e: null }, { ...s, properties: { ...s.properties, b: { type: "array", items: { type: "object", properties: { c: { type: "integer" } }, required: ["c"] } } } }), ["$.b[0].c"]);
});

test("inherited names are not schema properties, and __proto__ is refused as a name (review S3)", () => {
  const t = toStrict({ type: "object", properties: { a: { type: "string" } } });
  // A model answer naming Object.prototype's members is still outside the schema.
  assert.deepEqual(validate(JSON.parse('{"a":"x","constructor":1,"toString":2,"__proto__":{"p":1}}'), t),
    ["$.constructor: not in the schema", "$.toString: not in the schema", "$.__proto__: not in the schema"]);
  const L = { maxBytes: 32768, maxDepth: 5, maxProperties: 100 };
  // As a request body parses it: JSON.parse makes __proto__ an own property, not the prototype.
  assert.throws(() => checkSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'), L), /not __proto__/);
  assert.throws(() => checkSchema({ type: "object", properties: { a: { type: "string" } }, required: ["toString"] }, L), /required must name/);
});

test("the egress policy's search section and the host selection are validated", () => {
  const egress = readFileSync(new URL("../policy/egress.json", import.meta.url), "utf8");
  const p = loadPolicy(egress);
  assert.deepEqual(p.search.engines.fixture, ["fcpi fixture", "fcpi fixture b", "fcpi fixture r"]);
  assert.equal(p.search.perHour, 60);
  const e = (f) => { const j = JSON.parse(egress); f(j); return JSON.stringify(j); };
  assert.throws(() => loadPolicy(e((j) => { j.search.perHour = 61; })), /perHour/);
  assert.throws(() => loadPolicy(e((j) => { j.search.deadlineMs = 20000; })), /deadlineMs/);
  assert.throws(() => loadPolicy(e((j) => { j.search.engineHosts.live.push("search.fixture.fcpi.test"); })), /public host/);
  const b = loadBudgetPolicy(RAW);
  assert.deepEqual(defaultSelection(b), { search: "fixture", extractionModel: "gpt-6-luna", parser: "llamaparse-cost-effective", proxy: "decodo-residential", enhanced: "zyte-api" });
  assert.equal(loadSelection(JSON.stringify({ search: "live", extractionModel: "fcpi-fixture-model", parser: "fcpi-fixture-parser" }), p, b).search, "live");
  assert.throws(() => loadSelection(JSON.stringify({ search: "live", extractionModel: "gpt-4o", parser: "fcpi-fixture-parser" }), p, b), /extractionModel/);
  assert.throws(() => loadSelection(JSON.stringify({ search: "everything", extractionModel: "fcpi-fixture-model", parser: "fcpi-fixture-parser" }), p, b), /search/);
});
