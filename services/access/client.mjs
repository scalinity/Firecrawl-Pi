// FCPI client binding (FIRECRAWL_PI_SPEC.md §16.1): every URL is built from the capability manifest's
// route table, whose upstream shapes scripts/m3/route-shapes.mjs checks against the pinned source, so
// no route shape is guessed. There is no default base URL: a client without one fails at construction
// rather than reach a vendor endpoint. Node built-ins only (global fetch).
import { readFileSync } from "node:fs";

export function loadManifest(path = new URL("../../deploy/policies/capabilities.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function makeClient({ baseUrl, token, manifest = loadManifest(), timeoutMs = 130000 }) {
  if (!baseUrl) throw new Error("fcpi client: a base URL is required (there is no default)");
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.origin !== baseUrl.replace(/\/$/, "")) throw new Error(`fcpi client: '${baseUrl}' is not an http(s) origin`);
  if (!/^fcpi_[a-z0-9]+_[0-9a-f]{64}$/.test(token ?? "")) throw new Error("fcpi client: the token is not a gateway token");
  const routes = Object.fromEntries(manifest.routes.map((r) => [r.id, r]));

  function urlFor(id, { id: jobId, query } = {}) {
    const r = routes[id];
    if (!r) throw new Error(`fcpi client: no route '${id}' in the manifest`);
    const u = new URL(r.path.replace("{id}", encodeURIComponent(jobId ?? "")), base.origin);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u;
  }

  async function request(method, url, { body, headers } = {}) {
    const res = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${token}`, accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, headers: Object.fromEntries(res.headers), json, text };
  }

  return {
    urlFor,
    // One call by route id: { id, query, body, headers }.
    call(routeId, opts = {}) { return request(routes[routeId].method, urlFor(routeId, opts), opts); },
    // Follows a `next` URL the gateway returned; it must stay on this client's origin.
    follow(next) {
      const u = new URL(next);
      if (u.origin !== base.origin) throw new Error(`fcpi client: refusing to follow ${u.origin}, which is not ${base.origin}`);
      return request("GET", u);
    },
  };
}
