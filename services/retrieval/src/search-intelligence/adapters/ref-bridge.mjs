// The fetch the MCP client uses for Ref (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §6.2, §14.1): every exchange goes through
// provider.mjs's checks (the egress rules, one pinned address, no redirect, TLS verified, the deadline and the caller's
// cancellation), only to the session's own endpoint, with the key added here so the client never holds it.
//   POST    a request permit while it is open. An SSE answer is passed on as it arrives and ended as soon as it has delivered the
//           answers to every request the POST carried, so a server that keeps the connection open after its result holds
//           nothing; a JSON answer is bounded and read whole.
//   GET     the optional receive stream: a stream slot, never a request permit, taken only when one is free at once. Without
//           one the client is answered 405 (the server offers no stream) and carries on, so open sessions never starve the tool
//           calls they wait for.
//   DELETE  the session's goodbye, under a request permit and a one-second bound.
// A billable call tags its POST with its operation (a header removed here before sending). The client's own timeout never stops
// a request it has handed to the transport, so the caller asks the bridge instead: whether that operation's request was
// written, and to withdraw it if it was not, so nothing is sent after its reservation was released.
import { providerStreamRequest } from "../../provider.mjs";
import { paidDispatchActive } from "../../budget.mjs";

export const OP_HEADER = "x-fcpi-operation";

// The ids of the requests a POST body carries (a single message or a batch); notifications and responses have none.
function requestIds(body) {
  try {
    const m = JSON.parse(typeof body === "string" ? body : Buffer.from(body ?? "").toString("utf8"));
    return [m].flat().filter((x) => x && typeof x.method === "string" && x.id !== undefined && x.id !== null).map((x) => x.id);
  } catch { return []; }
}

// Passes an SSE stream through unchanged and ends it once a response (result or error) to every id has passed.
export function untilAnswered(ids) {
  const pending = new Set(ids), decoder = new TextDecoder();
  let buf = "";
  return new TransformStream({
    transform(chunk, ctl) {
      ctl.enqueue(chunk);
      buf += decoder.decode(chunk, { stream: true });
      for (let m = /\r?\n\r?\n/.exec(buf); m; m = /\r?\n\r?\n/.exec(buf)) {
        const event = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        try { for (const x of [JSON.parse(data)].flat()) if (x && pending.has(x.id) && ("result" in x || "error" in x)) pending.delete(x.id); } catch { /* not JSON: the client judges it */ }
      }
      if (!pending.size) ctl.terminate();
    },
  });
}

const toHeaders = (h) => {
  const out = new Headers();
  for (const [k, v] of Object.entries(h ?? {})) for (const x of [v].flat()) if (x !== undefined) out.append(k, String(x));
  return out;
};

export function makeRefBridge({ permits, getPolicy, resolvePublic, lookupFixture, getBudget, paidDispatch, limits, request = providerStreamRequest }) {
  // One session's fetch. endpoint: the session's MCP URL; deadlineAt: the session's until an operation extends it.
  return function makeFetch({ sub, key, searchId, endpoint, signal, deadlineAt }) {
    const session = new AbortController();
    const ops = new Map();
    let sessionDeadline = deadlineAt, wrote = false;
    const authorize = () => !signal?.aborted && !session.signal.aborted && (!sub.prov.paid || paidDispatchActive(getBudget(), paidDispatch));
    const exchange = (method, h, body, { sig, until, onWritten = () => {}, onEnd, auth = authorize }) => request({ baseUrl: endpoint.origin, path: endpoint.pathname, method, headers: h, body, timeoutMs: Math.max(1, until - Date.now()),
      maxBytes: limits().responseBytes.ref, getPolicy, resolvePublic, lookupFixture, signal: sig, authorize: auth, deadlineAt: until, onWritten: () => { wrote = true; onWritten(); }, onEnd });

    async function fetch(input, init = {}) {
      const u = new URL(String(input?.url ?? input));
      const method = String(init.method ?? "GET").toUpperCase();
      if (u.href !== endpoint.href) throw new TypeError("the Ref bridge serves only its session's endpoint");
      const h = Object.fromEntries(new Headers(init.headers ?? {}));
      const op = h[OP_HEADER] ? ops.get(h[OP_HEADER]) ?? null : null;
      delete h[OP_HEADER]; delete h.host; delete h["content-length"];
      h["x-ref-api-key"] = key;
      // The goodbye (DELETE) is not billable and is sent when the search ends, often past its deadline or after its
      // cancellation: it has its own one-second bound, and only the session's local close stops it.
      const goodbye = method === "DELETE";
      const mine = new AbortController();
      const sig = AbortSignal.any([session.signal, mine.signal, ...(signal && !goodbye ? [signal] : []), ...(init.signal ? [init.signal] : []), ...(op ? [op.signal] : [])]);
      const until = op ? op.deadlineAt : goodbye ? Date.now() + 1000 : sessionDeadline;
      if (method === "GET") {
        // Taken only when free now: a full pool answers 405 and the session works without its receive stream.
        let release;
        try { release = await permits.refStream(searchId, { signal: sig, deadlineAt: Date.now() }); }
        catch (e) { if (e.capacity) return new Response(null, { status: 405 }); throw e; }
        const res = await exchange("GET", h, null, { sig, until: sessionDeadline, onEnd: release });
        return new Response(res.body, { status: res.status, headers: toHeaders(res.headers) });
      }
      if (method !== "POST" && method !== "DELETE") throw new TypeError(`method ${method} is not used with Ref`);
      const release = await permits.api(sub.provider, searchId, { signal: sig, deadlineAt: until });
      if (op) op.pending.add(mine);
      let res;
      try {
        res = await exchange(method, h, method === "POST" ? Buffer.from(init.body ?? "") : null, { sig, until, auth: goodbye ? () => !session.signal.aborted : authorize,
          onWritten: () => { if (op) op.written = true; }, onEnd: () => { op?.pending.delete(mine); release(); } });
      } catch (e) { op?.pending.delete(mine); throw e; }
      const ids = method === "POST" ? requestIds(init.body) : [];
      const sse = /^text\/event-stream\b/i.test(String(res.headers["content-type"] ?? ""));
      const body = [204, 205, 304].includes(res.status) ? (await res.body.cancel(), null) : sse && ids.length ? res.body.pipeThrough(untilAnswered(ids)) : res.body;
      return new Response(body, { status: res.status, headers: toHeaders(res.headers) });
    }

    return {
      fetch,
      // A billable operation's handle: register it before the call that sends it, under its own cancellation and deadline.
      op(name, { signal: opSignal = null, deadlineAt: opDeadline }) {
        const ctl = new AbortController();
        const state = { written: false, pending: new Set(), deadlineAt: opDeadline, signal: opSignal ? AbortSignal.any([opSignal, ctl.signal]) : ctl.signal };
        ops.set(name, state);
        sessionDeadline = Math.max(sessionDeadline, opDeadline);
        return {
          header: { [OP_HEADER]: name },
          written: () => state.written,
          // Ends the operation's requests: one not yet written is never written; one written is cut off (its outcome stays unknown).
          withdraw: () => { ctl.abort(); for (const c of state.pending) c.abort(); },
        };
      },
      closeAll: () => session.abort(),
      // Whether anything of this session was written (a failed initialize was possibly seen by the provider).
      wroteAny: () => wrote,
    };
  };
}
