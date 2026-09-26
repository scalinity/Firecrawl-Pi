// The grammars the gateway and the MCP service each enforce on the same values, compared (M4): the
// registry's client label, principal and scope list (services/access/src/auth.mjs) against the identity
// the MCP service accepts from the gateway (services/mcp/server.mjs), and the job-id and idempotency-key
// patterns of the gateway's routes (services/access/server.mjs) against the MCP tools' schemas
// (services/mcp/src/tools.mjs). Each is read from its source file, so a change to one side without the
// other fails here: a client the gateway accepts could otherwise get 401 NO_GATEWAY_IDENTITY, or a tool
// accept an id or key its route refuses. Node built-ins only; FCPI_REPO_ROOT locates the repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.FCPI_REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = (p) => readFileSync(join(ROOT, p), "utf8");
const literal = (text, re) => { const m = text.match(re); assert.ok(m, `pattern ${re} not found`); return new Function(`return ${m[1]}`)(); };
const LINE = literal(src("services/access/src/auth.mjs"), /^const LINE = (\/.*\/);$/m);
const IDENTITY = literal(src("services/mcp/server.mjs"), /^const IDENTITY = (\{.*\});$/m);
const GW_UUID = literal(src("services/access/server.mjs"), /^const UUID = (\/.*\/i?);$/m);
const GW_IDEM = literal(src("services/access/server.mjs"), /!(\/\^\[A-Za-z0-9\._:-\]\{8,128\}\$\/)\.test\(idemKey\)/);
const TOOLS = src("services/mcp/src/tools.mjs");
const MCP_UUID = new RegExp(literal(TOOLS, /^const UUID = (".*");$/m)), MCP_IDEM = new RegExp(literal(TOOLS, /^const IDEM = (".*");$/m));
const MANIFEST = JSON.parse(src("deploy/policies/capabilities.json"));
// The registry line's three fields, as the gateway parses them, for a candidate value in one position.
const registryAccepts = (label, principal, scopes) => LINE.test(`${label} ${principal} ${scopes} sha256:${"0".repeat(64)}`);

test("every label and principal the registry accepts, the MCP service accepts as the gateway's identity, and no other", () => {
  const labels = ["a", "m4claude", "x".repeat(32), "x".repeat(33), "A", "a-b", "", "a b"];
  for (const l of labels) assert.equal(IDENTITY.client.test(l), registryAccepts(l, "p", "read"), `label ${JSON.stringify(l)}`);
  const principals = ["p", "m4-owner", "0x", "-p", "p".repeat(63), "p".repeat(64), "P", "p_q", ""];
  for (const p of principals) assert.equal(IDENTITY.principal.test(p), registryAccepts("a", p, "read"), `principal ${JSON.stringify(p)}`);
});

test("every scope list the gateway forwards, however many scopes the manifest grows to, passes the MCP service", () => {
  const all = [...MANIFEST.scopes].sort().join(",");
  assert.ok(IDENTITY.scopes.test(all), all);
  // Room to grow: the manifest's scopes three times over, well past today's 34 characters.
  const grown = [...MANIFEST.scopes, ...MANIFEST.scopes.map((s) => `${s}x`), ...MANIFEST.scopes.map((s) => `${s}y`)].join(",");
  assert.ok(grown.length > 64 && IDENTITY.scopes.test(grown));
  for (const bad of ["", ",read", "read,", "read,,scrape", "READ", "read scrape"]) assert.equal(IDENTITY.scopes.test(bad), false, bad);
});

test("the tools accept exactly the job ids and idempotency keys their gateway routes accept", () => {
  const ids = ["0f8fad5b-d9cb-469f-a165-70867728950e", "0F8FAD5B-D9CB-469F-A165-70867728950E", "0f8fad5b-d9cb-469f-a165-70867728950", "0f8fad5bd9cb469fa16570867728950e", "0f8fad5b-d9cb-469f-a165-70867728950g"];
  for (const id of ids) assert.equal(MCP_UUID.test(id), GW_UUID.test(id), `id ${id}`);
  const keys = ["mcp:0f8fad5b-d9cb-469f-a165-70867728950e", "short", "k".repeat(8), "k".repeat(128), "k".repeat(129), "a b c d e", "key/with/slash", "key.with_all:-chars"];
  for (const k of keys) assert.equal(MCP_IDEM.test(k), GW_IDEM.test(k), `key ${k}`);
});
