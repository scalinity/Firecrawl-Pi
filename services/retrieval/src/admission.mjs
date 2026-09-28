// Host admission (FIRECRAWL_PI_SPEC.md §23.1, §24.2 "Memory/thermal pressure"), the gateway's module (services/access/src/
// admission.mjs) as this service reads it. The host's tick (scripts/ops/tick.sh) writes one small JSON file, mounted here
// read-only: browser "paused" at 75 °C, under 1 GiB of available memory, at the critical disk mark or while a backup
// holds the platform still. A paused browser refuses the browser tier (RESOURCE_BUSY, retryable) before any Chromium
// work; direct HTTP and every other tier go on. The file carries its time, and one older than
// three minutes, unreadable or absent counts as open: a stopped tick must not stop the platform (the host's probe
// reports a stale tick as its own incident).
import { readFile } from "node:fs/promises";

export const STALE_MS = 180000;

export function parseAdmission(text, nowMs) {
  let j;
  try { j = JSON.parse(text); } catch { return { dispatch: "open", browser: "open", reasons: [], state: "unreadable" }; }
  const at = Date.parse(j?.utc);
  // A time in the future beyond a minute's clock difference is as untrustworthy as an old one.
  if (!Number.isFinite(at) || nowMs - at > STALE_MS || at - nowMs > 60000) return { dispatch: "open", browser: "open", reasons: [], state: "stale" };
  const reasons = Array.isArray(j.reasons) ? j.reasons.filter((r) => typeof r === "string" && /^[a-z0-9:_-]{1,40}$/.test(r)).slice(0, 8) : [];
  return { dispatch: j.dispatch === "paused" ? "paused" : "open", browser: j.browser === "paused" ? "paused" : "open", reasons, state: "fresh", utc: j.utc };
}

// read() is cached for cacheMs, so a burst of requests reads the file once.
export function makeAdmission(file, { cacheMs = 2000, now = Date.now } = {}) {
  let cached = null, at = -Infinity;
  return {
    async read() {
      if (!file) return { dispatch: "open", browser: "open", reasons: [], state: "unset" };
      const t = now();
      if (cached && t - at < cacheMs) return cached;
      let text = null;
      try { text = await readFile(file, "utf8"); } catch { /* absent or unreadable: open */ }
      cached = text === null ? { dispatch: "open", browser: "open", reasons: [], state: "unreadable" } : parseAdmission(text, t);
      at = t;
      return cached;
    },
  };
}
