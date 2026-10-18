// The retrieval server with search intelligence wired (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §19.2), booted for real
// against the throwaway PostgreSQL (FCPI_TEST_PG): POST /internal/search takes the core's credential and a validated trusted
// request; the legacy GET route still answers in SearXNG's shape; a stop drains search work before the pool closes. The
// fixture providers' names do not resolve on a workstation, so their lanes fail as unreachable and SearXNG's fixture answers:
// the search is an honest partial. Unset FCPI_TEST_PG skips this file; a skip is not a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import pg from "pg";
import { serve, json, request } from "./si-helpers.mjs";

const HOST = process.env.FCPI_TEST_PG;
const opts = { skip: HOST ? false : "no test database (FCPI_TEST_PG unset)", timeout: 60000 };
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("the wired server: credential, validation, an honest partial aggregate search, the legacy route, and a drained stop", opts, async () => {
  const c = new pg.Client({ host: HOST, user: "postgres", database: "postgres" });
  await c.connect();
  await c.query("CREATE SCHEMA IF NOT EXISTS nuq");
  await c.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  await c.end();
  const sx = await serve((req, res) => json(res, 200, req.url.startsWith("/config") ? { engines: [{ name: "fcpi fixture" }, { name: "fcpi fixture b" }, { name: "fcpi fixture r" }] }
    : { results: [{ url: "https://searx.example/a", title: "A", content: "found by the fixture engine", engines: ["fcpi fixture"] }], unresponsive_engines: [] }));
  const dir = mkdtempSync(join(tmpdir(), "fcpi-si-server-")), creds = join(dir, "creds"), providers = join(dir, "providers");
  for (const d of [creds, providers]) (await import("node:fs")).mkdirSync(d);
  const coreToken = `core-${randomUUID()}-${randomUUID()}`;
  writeFileSync(join(creds, "retrieval_core_token_sha256"), sha(coreToken));
  const gatewayToken = `gateway-${randomUUID()}-${randomUUID()}`;
  writeFileSync(join(creds, "retrieval_gateway_token_sha256"), sha(gatewayToken));
  writeFileSync(join(creds, "retrieval_postgres_password"), "unused-trust-auth");
  writeFileSync(join(creds, "retrieval_browser_token"), randomUUID());
  writeFileSync(join(creds, "retrieval_searxng_proxy_sha256"), sha(randomUUID()));
  writeFileSync(join(providers, "fixture_serper"), "synthetic-serper-key");
  writeFileSync(join(dir, "local"), "192.168.0.0/16\n");
  writeFileSync(join(dir, "selection.json"), JSON.stringify({ search: "fixture", extractionModel: "claude-haiku-5-5", parser: "llamaparse-cost-effective" }));
  const [listen, proxy, sproxy, extract] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const child = spawn(process.execPath, [new URL("../src/server.mjs", import.meta.url).pathname], { env: { PATH: process.env.PATH, PGPORT: process.env.PGPORT ?? "5432",
    PI_RETRIEVAL_LISTEN: `127.0.0.1:${listen}`, PI_RETRIEVAL_PROXY_LISTEN: `127.0.0.1:${proxy}`, PI_EGRESS_POLICY_FILE: new URL("../policy/egress.json", import.meta.url).pathname,
    PI_EGRESS_LOCAL_CIDRS_FILE: join(dir, "local"), PI_RESOLVER: "127.0.0.1", PI_BROWSER_URL: "http://127.0.0.1:1", PI_CREDENTIALS_DIR: creds, PI_POSTGRES_HOST: HOST, PI_POSTGRES_DB: "postgres",
    PI_POSTGRES_USER: "fcpi_retrieval", PI_SEARCH_URL: `http://127.0.0.1:${sx.port}/search`, PI_SEARCH_PROXY_LISTEN: `127.0.0.1:${sproxy}`, PI_EXTRACT_LISTEN: `127.0.0.1:${extract}`,
    PI_BUDGET_POLICY_FILE: new URL("../policy/budget.json", import.meta.url).pathname, PI_PROVIDERS_DIR: providers, PI_SELECTION_FILE: join(dir, "selection.json"), PI_PAID_DISPATCH_ENABLED: "true" } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  try {
    for (let i = 0; i < 100 && !out.includes("store_ready"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /"event":"store_ready"/, out.slice(0, 2000));
    const base = `http://127.0.0.1:${listen}`;
    const post = (body, token = coreToken) => fetch(`${base}/internal/search`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post(request(), null)).status, 401);
    assert.equal((await post(request(), `wrong-${randomUUID()}-${randomUUID()}`)).status, 401);
    const bad = await post({ ...request(), constraints: { includeDomains: ["a.example"], excludeDomains: ["b.example"] } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).failure.class, "INVALID_REQUEST");
    const r = await post(request({ originalQuery: "wired server search", absoluteDeadlineMs: Date.now() + 20000 }));
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body).slice(0, 500));
    assert.equal(body.search.profile, "aggregate");
    assert.equal(body.search.outcome, "partial");
    assert.equal(body.search.coverage.searxng.used, true);
    assert.deepEqual(body.web.map((w) => w.url), ["https://searx.example/a"]);
    assert.ok(body.search.coverage.general.missing.every((m) => ["temporarily_unavailable", "not_configured"].includes(m.reason)), JSON.stringify(body.search.coverage.general.missing));
    const legacy = await fetch(`${base}/searxng/search?q=legacy+route&format=json&pageno=1&language=en`);
    const lb = await legacy.json();
    assert.equal(legacy.status, 200);
    assert.deepEqual(lb.results.map((x) => Object.keys(x).sort()), [["content", "title", "url"]]);
    assert.equal(lb.fcpi.profile, "aggregate");
    assert.equal(lb.fcpi.partial, true);
    // Evidence advice on acquired pages: the core's credential, its bounded payload, and the deterministic passages when Jev
    // cannot be reached (the fixture decision host does not resolve here).
    const evidence = (body, token = coreToken) => fetch(`${base}/internal/search/evidence`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body) });
    const page = "# Proxy\n\nThe proxy option forwards requests and accepts a timeout in milliseconds.";
    const payload = { schema: "fcpi.search-evidence/v1", requestId: `req-${randomUUID()}`, logicalSearchId: randomUUID(), principalId: "test-principal", originalQuery: "vite proxy timeout",
      intelligence: { documentation: "auto", evidence: "auto" }, absoluteDeadlineMs: Date.now() + 20000,
      documents: [{ documentId: "a".repeat(24), url: "https://docs.example/proxy", sourceUrl: "https://docs.example/proxy", contentSha256: sha(page), totalLength: page.length, basis: "markdown",
        windows: [{ start: 0, end: page.length, text: page }], droppedBytes: 0, droppedWindows: 0 }] };
    assert.equal((await evidence(payload, null)).status, 401);
    const ev = await evidence(payload);
    const eb = await ev.json();
    assert.equal(ev.status, 200, JSON.stringify(eb).slice(0, 400));
    assert.deepEqual(eb.documents.map((d) => d.documentId), ["a".repeat(24)]);
    assert.equal(eb.mode, "deterministic_fallback");
    assert.ok(eb.documents[0].evidence.passages.some((p) => /timeout in milliseconds/.test(p.text)));
    // A body past the 768 KiB bound is refused as every internal route refuses one: the upload is cut off, not read whole.
    const over = await evidence("x".repeat(786433)).catch((e) => e);
    assert.ok(over instanceof Error || over.status === 400, "a body past the bound is refused");
    assert.equal((await fetch(`${base}/healthz`)).status, 200, "and the server keeps serving");
    // The status derives Serper's balance from the ledger against its fixed allocation.
    const st = await (await fetch(`http://127.0.0.1:${extract}/internal/providers`, { headers: { authorization: `Bearer ${gatewayToken}` } })).json();
    assert.deepEqual(Object.keys(st.searchIntelligence.serperBalance).sort(), ["allocation", "basis", "remaining", "used"]);
    assert.equal(st.searchIntelligence.serperBalance.basis, "local_allocation_remaining");
    assert.equal(st.searchIntelligence.serperBalance.remaining, st.searchIntelligence.serperBalance.allocation - st.searchIntelligence.serperBalance.used);
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.match(out, /"event":"stopping".*"search_tasks_left":0/);
  } finally {
    if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
    await sx.close();
  }
});
