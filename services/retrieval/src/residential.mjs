// The residential proxy route (FIRECRAWL_PI_SPEC.md §10, §28.3): which provider the host's selection names and
// whether it may be used now, the HTTP CONNECT tunnel every residential request travels through, and the byte
// reservations that bound its spend.
//
// Availability is checked in one order, every refusal named, before anything is reserved or sent:
//   1. a proxy is selected (the host's selection; the budget policy's default otherwise);
//   2. its rate card is in effect;
//   3. a paid provider needs PI_PAID_DISPATCH_ENABLED (a key present is not an authorization to spend);
//   4. its credential file is present;
//   5. its breaker is not open;
//   6. its category has room for one attempt's reservation (a zero cap has none).
// Work that needs this route and cannot have it is refused as PROXY_REQUIRED by the caller; it never falls back
// to the home connection.
//
// The tunnel: the provider's endpoint is deployment configuration, never caller input. Its name is resolved by
// the service's resolver and every answer must be public (a fixture proxy's must lie in its fixture subnet), and
// the connection is made to exactly that address. The target's own name is validated and resolved as for a
// direct fetch before the CONNECT is sent, so the residential route never reaches what the direct route would
// refuse (spec §9.2: a proxy is no SSRF workaround); the exit resolves the name itself. TLS to the target is
// end to end and always verified. The credential travels only in Proxy-Authorization to the provider, never to
// a target and never into a log.
//
// A failure before the tunnel is up is the provider's (spec §9.2): 407 PROVIDER_AUTH_FAILED, 402
// PROVIDER_BILLING, 429 PROVIDER_RATE_LIMITED, any other answer PROVIDER_ERROR (an exit that cannot reach the
// target answers the same way, and is not told apart), no answer PROVIDER_UNREACHABLE. Each counts on the
// provider's breaker and never on the target's routing record.
import net from "node:net";
import tls from "node:tls";
import { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { Breaker, rateCardFor, proxyCost, periodStarts } from "./budget.mjs";
import { readCredential } from "./provider.mjs";
import { parseTarget, Denied } from "./ssrf.mjs";
import { resolveTarget } from "./resolve.mjs";
import { sessionUsername } from "./route.mjs";
import { transportFailure } from "./httpfetch.mjs";

const HEAD_MAX = 16384;
const PROVIDER_STATUS = { 407: "PROVIDER_AUTH_FAILED", 402: "PROVIDER_BILLING", 429: "PROVIDER_RATE_LIMITED" };

export class ProviderRefusal extends Denied {
  constructor(failureClass, detail, extra = {}) { super(failureClass, detail, extra); this.provider = true; }
}

// The credential file: "<proxy username>:<password>", the username without Decodo's "user-" prefix, letters, digits
// and underscores only (review S18: anything else would change the session username's meaning).
export function parseProxyCredential(text) {
  const i = text?.indexOf(":") ?? -1;
  if (i <= 0 || i === text.length - 1) return null;
  const name = text.slice(0, i);
  return /^[A-Za-z0-9_]+$/.test(name) ? { name, password: text.slice(i + 1) } : null;
}

// Counts every byte a tunnel carries in both directions on the connection to the provider, the CONNECT exchange
// and TLS included, since that is what a provider bills; past its cap it destroys every tunnel it serves. A meter
// serves one attempt (all its tunnels: redirects, a browser's subresources) and records whether any tunnel broke
// after it was up, the case whose charge cannot be known locally (spec §28.3: it stays reserved whole).
// Bytes are counted in JavaScript, where they pass: Node's HTTP and TLS layers may read a socket's handle
// directly, past its data events, so no consumer ever gets the raw socket: tunnel() returns only the metered stream,
// which also records a break of the tunnel after it was up (review W11).
// The part of a chunk read from a tunnel that is not yet counted: the bytes the CONNECT reader already counted and
// returned to the socket come first.
function uncounted(raw, n) {
  const skip = Math.min(raw.fcpiUncounted ?? 0, n);
  if (skip) raw.fcpiUncounted -= skip;
  return n - skip;
}

export class Meter {
  constructor(cap) { this.cap = cap; this.bytes = 0; this.sockets = new Set(); this.errored = false; this.capped = false; this.tunnels = 0; }
  add(n) {
    this.bytes += n;
    if (this.bytes > this.cap && !this.capped) { this.capped = true; for (const s of this.sockets) { s.fcpiCapped = true; s.destroy(); } }
  }
  // A tunnel opened after the cap tripped is cut at once, like the ones open when it tripped (review W2).
  attach(socket) {
    this.tunnels++;
    if (this.capped) { socket.fcpiCapped = true; socket.destroy(); return; }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }
  // Ends every tunnel still open, so nothing crosses after the count is read (review S7).
  closeAll() { for (const s of this.sockets) s.destroy(); }
  // A Duplex over an established tunnel that counts what crosses it, for an HTTP request, a TLS session or a pipe.
  // An error on the tunnel itself (a reset by the provider, not this service's own destroy) leaves the charge unknown.
  wrap(raw) {
    const meter = this;
    const d = new Duplex({
      read() { raw.resume(); },
      write(chunk, enc, cb) { meter.add(chunk.length); raw.write(chunk, enc, cb); },
      final(cb) { raw.end(); cb(); },
      destroy(err, cb) { raw.destroy(); cb(err); },
    });
    raw.on("data", (c) => { meter.add(uncounted(raw, c.length)); if (!d.push(c)) raw.pause(); });
    raw.on("end", () => d.push(null));
    raw.on("error", (e) => { meter.errored = true; d.destroy(e); });
    raw.on("close", () => { if (raw.fcpiCapped) d.destroy(Object.assign(new Error("the attempt passed its proxy byte budget"), { code: "FCPI_PROXY_BYTES" })); else d.destroy(); });
    for (const k of ["setNoDelay", "setKeepAlive", "setTimeout", "ref", "unref"]) d[k] = () => d;
    return d;
  }
}

export function makeResidential({ getBudget, getPolicy, getSelection, providersDir, paidDispatch, store, resolvePublic, lookupFixture, log }) {
  const breakers = new Map();
  const breakerFor = (name) => breakers.get(name) ?? breakers.set(name, new Breaker(getBudget().breaker)).get(name);
  // The provider's credential, read at most every five seconds (review S3; a key placed later is seen within that),
  // and kept here: the route's state carries only whether it is present (review S2).
  const creds = new Map();
  function credentialOf(provider) {
    const c = creds.get(provider.credential);
    if (c && Date.now() - c.at < 5000) return c.value;
    const value = parseProxyCredential(readCredential(providersDir, provider.credential));
    creds.set(provider.credential, { at: Date.now(), value });
    return value;
  }

  // The selected proxy and whatever stops it being used, checks 1-5 (synchronous, no reservation).
  function state() {
    const budget = getBudget(), subject = getSelection().proxy ?? null;
    if (!subject) return { available: false, reason: "NO_PROXY_SELECTED", subject: null };
    const s = budget.proxies[subject], provider = budget.providers[s.provider], category = budget.categories[s.category];
    const base = { subject, providerName: s.provider, provider, categoryName: s.category, category, paid: provider.paid };
    const card = rateCardFor(budget, subject);
    if (!card) return { ...base, available: false, reason: "RATE_CARD_MISSING" };
    if (provider.paid && !paidDispatch) return { ...base, card, available: false, reason: "PAID_DISPATCH_DISABLED" };
    if (!credentialOf(provider)) return { ...base, card, available: false, reason: "BLOCKED_CREDENTIAL" };
    const b = breakerFor(s.provider);
    if (b.state() === "open") return { ...base, card, available: false, reason: "PROVIDER_UNAVAILABLE", retryAfter: b.retryAfterS() };
    return { ...base, card, credential: "present", available: true, reason: null };
  }

  // Check 6 as well: the category's remaining room for one attempt, read from the ledger (a zero cap has none).
  // Advisory: the reservation itself is the transactional check, this only lets a route be refused before work.
  async function availability(bytes = getBudget().proxying.maxAttemptBytes) {
    const st = state();
    if (!st.available) return st;
    const need = proxyCost(st.card, bytes);
    const { day, month } = periodStarts();
    const rows = await store.budgetUsage(day, month);
    for (const [period, cap] of Object.entries(st.category.caps)) {
      const r = rows.find((x) => x.category === st.categoryName && x.period === period);
      if ((r ? r.reserved + r.settled : 0) + need > cap) return { ...st, available: false, reason: "BUDGET_EXHAUSTED", period, cap };
    }
    if (st.paid) {
      const r = rows.find((x) => x.category === "_paid_total" && x.period === "day");
      if ((r ? r.reserved + r.settled : 0) + need > getBudget().paidTotal.caps.day) return { ...st, available: false, reason: "BUDGET_EXHAUSTED", period: "day", cap: getBudget().paidTotal.caps.day };
    }
    return st;
  }

  // Reserves one attempt's (or one search tunnel's) maximum spend before anything is sent. The call key is the
  // attempt's, so a retried attempt can never be charged twice.
  async function reserve(st, { callKey, logicalId, bytes, kind = "proxy" }) {
    const budget = getBudget();
    const { day, month } = periodStarts();
    const amount = Math.max(1, proxyCost(st.card, bytes));
    const r = await store.reserveBudget({ id: randomUUID(), callKey, logicalId, category: st.categoryName, provider: st.providerName, subject: st.subject, kind, unit: "micro_usd",
      rateCard: st.card.id, requestHash: `bytes:${bytes}`, amount, caps: st.category.caps, paidTotalCap: st.paid ? budget.paidTotal.caps.day : null, paidTotalRate: 1, day, month, notifyAt: budget.notifyAtFraction });
    for (const n of r.notices ?? []) log({ event: "budget_notice", category: n.category, period: n.period, used: n.used, cap: n.cap });
    if (r.exhausted) return { failure: { class: "BUDGET_EXHAUSTED", detail: `the ${r.exhausted.category} ${r.exhausted.period} cap (${r.exhausted.cap} micro-USD) has no room for this attempt's ${amount} micro-USD reservation`, retryable: false, retryAfter: null } };
    if (r.existing) return { failure: { class: "LOGICAL_ID_CONFLICT", detail: "this attempt's proxy reservation already exists", retryable: false, retryAfter: null } };
    return { reservation: r.reservation, amount };
  }

  // Settles at the measured bytes, the tunnels closed first so nothing crosses after the count; a tunnel that broke
  // after it was up leaves the charge unknown, so the whole reservation stays counted (UNCERTAIN) until provider usage
  // reconciles it (reconcile.mjs). The measured charge is recorded as it is, above the reservation too (by at most the
  // chunk that tripped the cap): hiding it would leave the ledger short of the provider's bill (review W2).
  async function settle(st, reservation, meter, detail) {
    meter.closeAll();
    const bytes = meter.bytes, actual = proxyCost(st.card, bytes);
    if (meter.errored) {
      await store.markBudgetUncertain(reservation.id, `a tunnel broke after it was up; ${bytes} bytes measured locally (${detail})`, { bytes, tunnels: meter.tunnels, capped: meter.capped });
      return { state: "UNCERTAIN", bytes, actual: null, reserved: Number(reservation.reserved) };
    }
    const above = actual > Number(reservation.reserved);
    const row = await store.settleBudget(reservation.id, actual, { usage: { bytes, tunnels: meter.tunnels, capped: meter.capped }, detail: above ? `${detail}; settled above its reservation of ${reservation.reserved} micro-USD` : detail });
    return { state: row?.state ?? "SETTLED", bytes, actual, reserved: Number(reservation.reserved), above };
  }

  // The provider endpoint's one address: a fixture proxy inside its fixture subnet, a public one by the service's
  // resolver with every answer public, neither ever a Cloud destination.
  async function endpointAddress(provider) {
    const u = new URL(provider.baseUrl), port = Number(u.port), policy = getPolicy();
    const fixture = policy.fixtures.find((f) => f.host === u.hostname && f.port === port);
    const target = fixture ? { host: u.hostname, port, fixture } : parseTarget(`https://${u.hostname}/`, { ...policy, fixtures: [] });
    return { address: await resolveTarget(target, { resolvePublic, policy, lookupFixture }), host: u.hostname, port };
  }

  // A tunnel to host:port through the selected provider, under one sticky session; resolves the metered stream over it
  // (never the raw socket). Rejects with a ProviderRefusal (the provider's failure) or a Denied (cancel, deadline).
  async function tunnel(st, { host, port, sessionId, deadline, signal, meter }) {
    if (signal?.aborted) throw new Denied("CANCELLED", "the caller cancelled the acquisition");
    if (meter.capped) throw new Denied("SIZE_LIMIT", "the attempt passed its proxy byte budget");
    const cred = credentialOf(st.provider);
    if (!cred) throw new ProviderRefusal("BLOCKED_CREDENTIAL", "the proxy credential is absent or malformed", { retryable: false });
    let ep;
    try { ep = await endpointAddress(st.provider); }
    catch (e) { breakerFor(st.providerName).failure(); throw new ProviderRefusal("PROVIDER_UNREACHABLE", `the proxy endpoint could not be resolved (${e.failureClass ?? e.message})`, { retryable: true }); }
    const policy = getPolicy();
    const timeoutMs = Math.min(policy.residential.connectTimeoutMs, deadline - Date.now());
    if (timeoutMs <= 0) throw new Denied("DEADLINE_EXCEEDED", "no time left to open the proxy tunnel");
    const auth = Buffer.from(`${sessionUsername(cred.name, sessionId, policy.residential.sessionMinutes)}:${cred.password}`).toString("base64");
    return new Promise((resolve, reject) => {
      let settled = false, up = false;
      const socket = net.connect({ host: ep.address, port: ep.port });
      meter?.attach(socket);
      const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); socket.destroy(); reject(e); };
      const providerFail = (cls, detail, retryable) => { breakerFor(st.providerName).failure(); fail(new ProviderRefusal(cls, detail, { retryable })); };
      const onAbort = () => fail(new Denied("CANCELLED", "the caller cancelled the acquisition"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => providerFail("PROVIDER_UNREACHABLE", `the proxy did not open a tunnel within ${timeoutMs} ms`, true), timeoutMs);
      socket.once("connect", () => {
        if (socket.remoteAddress !== ep.address) return fail(new Denied("SSRF_DENIED", `connected peer ${socket.remoteAddress} is not the proxy's validated address`));
        const req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: Basic ${auth}\r\nProxy-Connection: keep-alive\r\n\r\n`;
        meter?.add(Buffer.byteLength(req));
        socket.write(req);
      });
      let head = Buffer.alloc(0);
      const onData = (c) => {
        meter?.add(c.length);
        head = Buffer.concat([head, c]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) { if (head.length > HEAD_MAX) providerFail("PROVIDER_ERROR", "the proxy's answer to CONNECT has no end of headers", false); return; }
        socket.off("data", onData);
        const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1")) ?? [])[1]);
        if (status !== 200) return providerFail(PROVIDER_STATUS[status] ?? "PROVIDER_ERROR", `the proxy answered CONNECT with ${status || "an unreadable status"}`, status === 429 || status >= 500);
        // Bytes after the headers belong to the tunnel; they were counted above, so they are returned uncounted.
        const rest = head.subarray(end + 4);
        socket.pause();
        if (rest.length) socket.unshift(rest);
        socket.fcpiUncounted = rest.length;
        settled = true; up = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        breakerFor(st.providerName).success();
        resolve(meter.wrap(socket));
      };
      socket.on("data", onData);
      // Once the tunnel is up, its errors are the metered stream's (wrap records them).
      socket.on("error", (e) => {
        if (up) return;
        providerFail("PROVIDER_UNREACHABLE", `the proxy could not be reached (${e.code ?? e.message})`, true);
      });
      socket.once("close", () => { if (!settled) providerFail("PROVIDER_UNREACHABLE", "the proxy closed the connection before answering CONNECT", true); });
    });
  }

  // One attempt's leg, the only shape every consumer uses (review W11): its meter, and open(host, port) for each
  // tunnel under the attempt's session, bounded by the attempt's deadline and signal unless a hop passes its own.
  function leg(st, { meter, sessionId, deadline, signal }) {
    return { st, meter, sessionId, open: (host, port, o = {}) => tunnel(st, { host, port, sessionId, deadline: o.deadline ?? deadline, signal: o.signal ?? signal, meter }) };
  }

  // The transport guardedFetch uses for a residential attempt: each hop opens its own tunnel on the attempt's leg, and
  // an https target gets its own TLS session over it, verified against the target's name. The handshake is bounded by
  // the hop's deadline and ends at the caller's cancel, as the direct path's request timer bounds its own (review W3).
  function via(l) {
    return {
      async open(target, { deadline, signal }) {
        const counted = await l.open(target.host, target.port, { deadline, signal });
        if (target.url.protocol !== "https:") return counted;
        return new Promise((resolve, reject) => {
          const s = tls.connect({ socket: counted, ...(net.isIP(target.host) ? {} : { servername: target.host }), rejectUnauthorized: true });
          let done = false;
          const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); s.off("error", bad); fn(v); };
          const fail = (err) => { s.destroy(); finish(reject, err); };
          const bad = (e) => fail(transportFailure(e, target.host));
          const onAbort = () => fail(new Denied("CANCELLED", "the caller cancelled the acquisition"));
          const timer = setTimeout(() => fail(new Denied("TIMEOUT", `no TLS handshake with ${target.host} before the deadline`)), Math.max(0, deadline - Date.now()));
          if (signal?.aborted) return onAbort();
          signal?.addEventListener("abort", onAbort, { once: true });
          s.once("secureConnect", () => finish(resolve, s));
          s.once("error", bad);
        });
      },
    };
  }

  return { state, availability, reserve, settle, tunnel, leg, via, breakerState: (name) => breakerFor(name).state(), breakers: () => Object.fromEntries([...breakers].map(([k, b]) => [k, b.state()])) };
}

// A session id for one logical acquisition: letters and digits only, stable across its attempts, and not the
// logical id itself (which would tell the provider the core's job ids).
export const sessionIdFor = (key, logicalId) => key(`fcpi.residential.session.v1|${logicalId}`).slice(0, 24);
