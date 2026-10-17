// Shared by M5's unit tests: loopback fixture providers (tests/fixtures/m5/providers.mjs, mounted at
// ../fixtures as the runners mount it), a policy whose fixture hosts resolve to them, the deployed budget
// policy pointed at them, and an in-memory ledger with the Store's reservation semantics (its SQL, and
// the race it must win, are tested against PostgreSQL in m5-store.test.mjs).
import http from "node:http";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockList } from "node:net";
import { loadBudgetPolicy } from "../src/budget.mjs";

export const fixtures = await import("../fixtures/m5/providers.mjs");

export async function serve(handler) {
  const s = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(() => res.destroy()));
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { port: s.address().port, close: () => new Promise((r) => { s.closeAllConnections(); s.close(r); }) };
}

export function policyFor(hosts) {
  const local = new BlockList();
  local.addSubnet("192.168.0.0", 16, "ipv4");
  return { ports: [80, 443], maxRedirects: 3, cloudDenylist: ["firecrawl.dev", "*.firecrawl.dev"], localCidrs: local,
    fixtures: Object.entries(hosts).map(([host, port]) => ({ host, port, cidr: "127.0.0.0/24", limits: "fixture" })) };
}
export const lookupFixture = async () => ["127.0.0.1"];

// The deployed budget policy with its fixture providers moved to loopback ports and the given changes.
export function budgetFor({ modelPort = 1, parserPort = 1, mutate = () => {} } = {}) {
  const b = JSON.parse(readFileSync(new URL("../policy/budget.json", import.meta.url), "utf8"));
  b.providers["fixture-model"].baseUrl = `http://model.fixture.fcpi.test:${modelPort}/v1`;
  b.providers["fixture-parser"].baseUrl = `http://parser.fixture.fcpi.test:${parserPort}`;
  mutate(b);
  return loadBudgetPolicy(JSON.stringify(b));
}

export function providersDir(files = {}) {
  const d = mkdtempSync(join(tmpdir(), "fcpi-providers-"));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return d;
}

// The Store's budget methods over memory: the same outcomes for every state, minus the SQL.
export class FakeLedger {
  constructor() { this.usage = new Map(); this.rows = new Map(); this.cache = new Map(); }
  #key(c, p, s) { return `${c}|${p}|${s}`; }
  async reserveBudget(r) {
    const prior = this.rows.get(r.callKey);
    if (prior && prior.state !== "RELEASED") return { existing: prior };
    const periods = [...Object.entries(r.caps).map(([period, cap]) => ({ category: r.category, period, cap })), ...(r.paidTotalCap != null ? [{ category: "_paid_total", period: "day", cap: r.paidTotalCap }] : [])];
    for (const p of periods) {
      const u = this.usage.get(this.#key(p.category, p.period, p.period === "day" ? r.day : r.month)) ?? { reserved: 0, settled: 0 };
      if (u.reserved + u.settled + r.amount > p.cap) return { exhausted: { category: p.category, period: p.period, cap: p.cap, used: u.reserved + u.settled } };
    }
    for (const p of periods) {
      const k = this.#key(p.category, p.period, p.period === "day" ? r.day : r.month);
      const u = this.usage.get(k) ?? { reserved: 0, settled: 0 };
      u.reserved += r.amount; this.usage.set(k, u);
    }
    const row = { id: r.id, call_key: r.callKey, logical_id: r.logicalId, category: r.category, provider: r.provider, subject: r.subject, kind: r.kind, request_hash: r.requestHash,
      reserved: r.amount, actual: null, state: "RESERVED", day_start: r.day, month_start: r.month, paid_total: r.paidTotalCap != null, result: null, usage: null, created_at: new Date() };
    this.rows.set(r.callKey, row);
    return { reservation: row, notices: [] };
  }
  #byId(id) { return [...this.rows.values()].find((x) => x.id === id); }
  #move(id, to, actual, f = {}) {
    const row = this.#byId(id);
    if (!row || !["RESERVED", "UNCERTAIN"].includes(row.state)) return null;
    for (const [period, start] of [["day", row.day_start], ["month", row.month_start]]) for (const cat of [row.category, ...(row.paid_total ? ["_paid_total"] : [])]) {
      const u = this.usage.get(this.#key(cat, period, start));
      if (u) { u.reserved = Math.max(0, u.reserved - row.reserved); u.settled += actual; }
    }
    Object.assign(row, { state: to, actual, usage: f.usage ?? null, result: f.result ?? null, detail: f.detail ?? null });
    return row;
  }
  async settleBudget(id, actual, f) { return this.#move(id, "SETTLED", actual, f); }
  async releaseBudget(id, detail) { return this.#move(id, "RELEASED", 0, { detail }); }
  async markBudgetUncertain(id, detail) { const r = this.#byId(id); if (r?.state === "RESERVED") Object.assign(r, { state: "UNCERTAIN", detail }); }
  async reservationByCallKey(k) { const r = this.rows.get(k); return r && r.state !== "RELEASED" ? r : null; }
  async parseCacheGet(k) { return this.cache.get(k) ?? null; }
  async parseCachePut(p) { this.cache.set(p.key, { pages: p.pages, markdown: p.markdown }); }
  used(category, period = "day") { let n = 0; for (const [k, u] of this.usage) if (k.startsWith(`${category}|${period}|`)) n += u.reserved + u.settled; return n; }
  states() { return [...this.rows.values()].map((r) => r.state); }
}
