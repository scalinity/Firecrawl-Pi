// Shared by M6's unit tests: the fixture proxy and targets (tests/fixtures/m6/fixture.mjs, mounted at ../fixtures)
// on loopback, a policy whose fixture hosts resolve to them, the deployed budget policy with its fixture proxy
// moved to the loopback port, a provider directory holding the fixture proxy's credential, and a store that
// joins the acquisition FakeStore to M5's in-memory ledger.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FakeStore, policyFor } from "./acquire-helpers.mjs";
import { FakeLedger, providersDir } from "./m5-helpers.mjs";
import { loadBudgetPolicy } from "../src/budget.mjs";
import { makeResidential } from "../src/residential.mjs";
import { makeAcquirer, makeFetcher, makeUrlHmac } from "../src/acquire.mjs";

export const fixture = await import("../fixtures/m6/fixture.mjs");
export const CRED = "fcpi_fixture:0123456789abcdef0123456789abcdef";
export const CRED_SHA = createHash("sha256").update(CRED).digest("hex");

export async function startFixture() {
  const state = fixture.makeState();
  const proxy = fixture.makeProxy(state, { credentialSha256: CRED_SHA, resolve: async () => "127.0.0.1" });
  const target = fixture.makeTarget(state);
  await Promise.all([new Promise((r) => proxy.listen(0, "127.0.0.1", r)), new Promise((r) => target.listen(0, "127.0.0.1", r))]);
  // A CONNECT socket leaves the HTTP server's own tracking, so the harness ends each one itself.
  const tunnels = new Set();
  proxy.on("connect", (_req, sock) => { tunnels.add(sock); sock.once("close", () => tunnels.delete(sock)); });
  const close = () => { for (const s of tunnels) s.destroy(); return Promise.all([proxy, target].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))); };
  return { state, proxyPort: proxy.address().port, targetPort: target.address().port, close };
}

// The M6 hosts on the target's loopback port, and the proxy's.
export function m6Policy(fx, { proxyFirst = [], direct } = {}) {
  const hosts = ["m6.fixture.fcpi.test", "m6hard.fixture.fcpi.test", "m6learn.fixture.fcpi.test", "m6cool.fixture.fcpi.test"].map((h) => [h, fx.targetPort, "fixture"]);
  const p = policyFor([...hosts, ["m6pace.fixture.fcpi.test", fx.targetPort, "direct"], ["proxy.fixture.fcpi.test", fx.proxyPort, "fixture"]], direct);
  p.residential.proxyFirstDomains = proxyFirst;
  return p;
}

export function m6Budget(fx, mutate = () => {}) {
  const b = JSON.parse(readFileSync(new URL("../policy/budget.json", import.meta.url), "utf8"));
  b.providers["fixture-proxy"].baseUrl = `http://proxy.fixture.fcpi.test:${fx.proxyPort}`;
  b.providers["fixture-proxy"].usageUrl = `http://proxy.fixture.fcpi.test:${fx.proxyPort}/__usage`;
  mutate(b);
  return loadBudgetPolicy(JSON.stringify(b));
}

export class M6Store extends FakeStore {
  constructor() { super(); this.ledger = new FakeLedger(); }
  reserveBudget(r) { return this.ledger.reserveBudget(r); }
  settleBudget(...a) { return this.ledger.settleBudget(...a); }
  releaseBudget(...a) { return this.ledger.releaseBudget(...a); }
  markBudgetUncertain(...a) { return this.ledger.markBudgetUncertain(...a); }
  reservationByCallKey(k) { return this.ledger.reservationByCallKey(k); }
  async budgetUsage(day, month) {
    const out = [];
    for (const [k, u] of this.ledger.usage) {
      const [category, period, start] = k.split("|");
      if ((period === "day" && start === day) || (period === "month" && start === month)) out.push({ category, period, period_start: start, reserved: u.reserved, settled: u.settled });
    }
    return out;
  }
}

export const urlHmac = makeUrlHmac(Buffer.alloc(32, 9));

// A residential route and an acquirer over the fixture. selection.proxy picks the subject (null: none).
export function rig(fx, { proxy = "fcpi-fixture-proxy", cred = CRED, policy = m6Policy(fx), budget = m6Budget(fx), paidDispatch = false, browser, store = new M6Store(), logs = [], resolvePublic = async () => [] } = {}) {
  const dir = providersDir(cred === null ? {} : { fixture_proxy: cred });
  const log = (o) => logs.push(o);
  const getPolicy = () => policy, getBudget = () => budget, getSelection = () => ({ proxy });
  const lookupFixture = async () => ["127.0.0.1"];
  const residential = makeResidential({ getBudget, getPolicy, getSelection, providersDir: dir, paidDispatch, store, resolvePublic, lookupFixture, log });
  const common = { store, getPolicy, getLocalReady: () => true, permits: { url: 2, browser: 1 }, resolvePublic, lookupFixture, urlHmac, log, residential, getBudget };
  const acquire = makeAcquirer({ ...common, browser: browser ?? { render: async () => ({ ok: false, failure: { class: "BROWSER_UNAVAILABLE", detail: "none" } }) } });
  const fetchOnce = makeFetcher(common);
  return { store, residential, acquire, fetchOnce, logs, policy, budget };
}

let n = 0;
export const req = (url, over = {}) => ({ requestId: `r-${++n}`, logicalAcquisitionId: `l-${n}-${Math.random()}`, url, deadline: new Date(Date.now() + 30000).toISOString(), purpose: "page", expect: "html", ...over });
