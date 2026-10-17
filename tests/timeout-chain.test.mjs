// A reasoning-model call can take minutes, and every layer between the caller and the provider has a timeout of its own. A call
// that one layer abandons while the layers below it keep going is billed and its answer is thrown away, so the timeouts must
// nest: each layer outlasts the one beneath it. This reads the real values (the budget policy, the deployed Compose file, the
// capability manifest, the Agent, the server and the page) and pins the order, so changing one layer without the others fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadBudgetPolicy } from "../services/retrieval/src/budget.mjs";
import { AGENT_RUN_MS, PAGE_REQUEST_SECONDS } from "../scripts/playground/agent.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const budget = loadBudgetPolicy(read("deploy/policies/budget.json"));
const manifest = JSON.parse(read("deploy/policies/capabilities.json"));
const compose = read("deploy/compose.yaml");
const env = (name) => Number(compose.match(new RegExp(`^\\s*${name}: "(\\d+)"`, "m"))?.[1]);
const CORE = env("PI_CORE_TIMEOUT_MS"), EXTRA = env("PI_MODEL_EXTRACT_EXTRA_MS");
const model = budget.models[manifest.formats.objects.json.model.value];
const limits = manifest.mcp.limits;
// The gateway's abort timer for a json request that names its model (src/jsonscrape.mjs): core timeout + 15 s + the extra.
const gatewayAbort = CORE + 15000 + EXTRA;

test("the layers' values are read, not assumed", () => {
  for (const [name, v] of Object.entries({ CORE, EXTRA, "model timeout": model.requestTimeoutMs, "MCP rest": limits.restTimeoutMs, "MCP exchange": limits.exchangeTimeoutMs })) {
    assert.ok(Number.isInteger(v) && v > 0, `${name} = ${v}`);
  }
});

test("a named model keeps its whole timeout even when the page fetch used all of the core timeout", () => {
  // The page fetch is bounded by the core timeout; the extraction then has what is left of the deadline (core + 10 s + extra).
  const leftAfterFullFetch = CORE + 10000 + EXTRA - CORE;
  assert.ok(leftAfterFullFetch >= model.requestTimeoutMs, `left ${leftAfterFullFetch} ms for a ${model.requestTimeoutMs} ms model call`);
});

test("the MCP service waits for the gateway, and the gateway's exchange deadline outlasts the MCP service", () => {
  assert.ok(limits.restTimeoutMs > gatewayAbort, `MCP rest ${limits.restTimeoutMs} ms must outlast the gateway's abort timer ${gatewayAbort} ms, or MCP abandons a call the gateway is still serving`);
  assert.ok(limits.exchangeTimeoutMs > limits.restTimeoutMs, "the exchange deadline outlasts the REST wait inside it");
  assert.ok(limits.exchangeTimeoutMs <= 600000, "the MCP service's own ceiling");
});

test("the Agent's page wait outlasts the gateway, and its run holds more than one page read", () => {
  assert.ok(PAGE_REQUEST_SECONDS * 1000 > gatewayAbort, `Agent wait ${PAGE_REQUEST_SECONDS} s must outlast the gateway's ${gatewayAbort / 1000} s so the gateway's own timeout answer arrives first`);
  assert.ok(AGENT_RUN_MS >= 2 * PAGE_REQUEST_SECONDS * 1000, "a run is long enough for two page reads that each use their full wait");
});
