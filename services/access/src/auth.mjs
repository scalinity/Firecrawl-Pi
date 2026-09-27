// Client credentials (FIRECRAWL_PI_SPEC.md §20.3). The registry file holds one client per line:
//   <label> <principal> <scope,scope,…> sha256:<64 hex>
// The gateway holds only hashes; every stored hash is compared with the presented token's, in
// constant time and without an early exit. The file is replaced atomically by
// scripts/m3/pi-client-token.sh; the gateway notices a new inode or mtime within a second, so a
// revoked token stops working without a restart. A file that fails to parse keeps the last good set.
import { readFileSync, statSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

const LINE = /^([a-z0-9]{1,32})\s+([a-z0-9][a-z0-9-]{0,62})\s+([a-z,]+)\s+sha256:([0-9a-f]{64})$/;

export function parseClients(text, scopes) {
  const out = [];
  const labels = new Set();
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    const m = LINE.exec(l);
    if (!m) throw new Error("client registry: each line must be '<label> <principal> <scopes> sha256:<64 hex>'");
    const s = m[3].split(",");
    if (!s.length || s.some((x) => !scopes.includes(x))) throw new Error(`client registry: ${m[1]} names an unknown scope`);
    if (labels.has(m[1])) throw new Error(`client registry: label ${m[1]} appears twice`);
    labels.add(m[1]);
    out.push({ label: m[1], principal: m[2], scopes: new Set(s), digest: Buffer.from(m[4], "hex") });
  }
  return out;
}

export function makeRegistry(path, scopes, log = () => {}) {
  let clients = [];
  let seen = null;
  let checkedAt = 0;
  const refresh = (force = false) => {
    const t = Date.now();
    if (!force && t - checkedAt < 1000) return;
    checkedAt = t;
    const st = statSync(path);
    const id = `${st.ino}:${st.mtimeMs}:${st.size}`;
    if (id === seen) return;
    try {
      clients = parseClients(readFileSync(path, "utf8"), scopes);
      seen = id;
      log({ event: "clients_loaded", clients: clients.length });
    } catch (e) {
      if (seen === null) throw e;
      log({ event: "clients_rejected", error: e.message });
    }
  };
  refresh(true);
  return {
    get size() { return clients.length; },
    // The client whose token this is, or null. A malformed header costs the same comparisons.
    authenticate(header) {
      try { refresh(); } catch (e) { log({ event: "clients_unreadable", error: e.message }); }
      const m = /^Bearer ([\x21-\x7e]{16,512})$/.exec(header ?? "");
      const digest = createHash("sha256").update(m ? m[1] : "\0invalid").digest();
      let found = null;
      for (const c of clients) if (timingSafeEqual(digest, c.digest) && m && found === null) found = c;
      return found;
    },
  };
}

// Authentication failures share one budget per minute (spec §20.3). Past it, a failed attempt is
// answered 429 instead of 401; a valid token is never slowed by it.
export function makeFailureLimiter(perMinute) {
  let windowStart = Date.now(), count = 0;
  return {
    fail() {
      const t = Date.now();
      if (t - windowStart >= 60000) { windowStart = t; count = 0; }
      count += 1;
      return count > perMinute ? Math.ceil((windowStart + 60000 - t) / 1000) : 0;
    },
  };
}

// M7 (M5 review S1): the tag the core and the retrieval service know a principal by, carried in the origin of every
// request the gateway sends the core as "fcpi:<tag>:<rest>" (patch 0010 reads it). Sixteen hex digits of a labelled
// SHA-256: the principal's name stays in the gateway, and caches keyed by the tag stay apart per principal. The gateway
// replaces any client-sent origin, so no client can claim another's tag.
export const ownerTag = (principal) => createHash("sha256").update(`fcpi.owner.v1|${principal}`).digest("hex").slice(0, 16);
export const originFor = (principal, rest) => `fcpi:${ownerTag(principal)}:${rest}`;
