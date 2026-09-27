// Screenshot artifacts (FIRECRAWL_PI_SPEC.md §12, §16.1; M7). The core returns each capture as a data URL (patch 0010);
// before the answer leaves the gateway, every one is decoded, checked to be a PNG, written to the archive (fsynced
// before its row commits), recorded as an artifact owned by the caller's principal with the results' retention, and
// replaced by its address, /platform/v1/artifacts/{id}. The answer names each artifact's type, size, dimensions (from
// the PNG's own header) and whether a full-page capture was clipped at 20,000 px, so a clipped image is never passed off
// as the whole page. An artifact is served only to its principal, and not after it expires.
import { randomUUID } from "node:crypto";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URL = /^data:(image\/png)((?:;[a-z-]+=[a-z0-9-]+)*);base64,([A-Za-z0-9+/]*={0,2})$/;
export const ARTIFACT_MAX_BYTES = 10 * 1048576;
// The browser worker clips a full-page capture at this height (services/browser/src/server.mjs).
export const CAPTURE_MAX_HEIGHT = 20000;

// The PNG's width and height from its IHDR chunk, or null when the bytes are not a PNG.
export function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG) || buf.toString("latin1", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

// A capture's data URL: { mime, truncated, buf }, or null when it is not one this deployment made.
export function parseCapture(s) {
  const m = typeof s === "string" ? DATA_URL.exec(s) : null;
  if (!m) return null;
  const params = Object.fromEntries(m[2].split(";").filter(Boolean).map((p) => p.split("=")));
  return { mime: m[1], truncated: params.truncated === "true", buf: Buffer.from(m[3], "base64") };
}

// Replaces every capture in a scrape's document with its artifact's address. Returns the artifacts' descriptions, in
// the order they appear (the screenshot format first, then the actions' screenshots). Throws with a code when a capture
// is malformed or storage has no room; nothing then reaches the caller.
export async function storeCaptures(doc, { principal, origin, archive, store, quotaBytes }) {
  const slots = [];
  if (typeof doc.screenshot === "string") slots.push({ get: () => doc.screenshot, set: (v) => { doc.screenshot = v; }, source: "screenshot" });
  (doc.actions?.screenshots ?? []).forEach((_, i) => slots.push({ get: () => doc.actions.screenshots[i], set: (v) => { doc.actions.screenshots[i] = v; }, source: `actions.screenshots[${i}]` }));
  // Every capture is checked and written first; the rows then commit in one transaction. A file whose row never commits
  // is referenced by nothing and goes with the archive's sweep (review S5).
  const pending = [];
  let used = await store.archiveBytes();
  for (const slot of slots) {
    const c = parseCapture(slot.get());
    const size = c && pngSize(c.buf);
    if (!size) throw Object.assign(new Error(`${slot.source} is not a PNG data URL`), { code: "CAPTURE_INVALID" });
    if (c.buf.length > ARTIFACT_MAX_BYTES) throw Object.assign(new Error(`${slot.source} exceeds ${ARTIFACT_MAX_BYTES} bytes`), { code: "CAPTURE_TOO_LARGE" });
    if (used + c.buf.length > quotaBytes || !(await archive.hasRoom(c.buf.length))) throw Object.assign(new Error("the result store is at its quota or free-space floor"), { code: "STORAGE_QUOTA" });
    const put = await archive.put(c.buf);
    used += put.bytes;
    // The page reports its own height to the worker, so a hostile one could hide a clip: an image at the clip height is
    // marked truncated whatever the page said (review S6).
    const truncated = c.truncated || size.height >= CAPTURE_MAX_HEIGHT;
    pending.push({ slot, row: { id: randomUUID(), principal, sha256: put.sha256, bytes: put.bytes, mime: c.mime, width: size.width, height: size.height, truncated } });
  }
  const rows = pending.length ? await store.addArtifacts(pending.map((p) => p.row)) : [];
  return rows.map((row, i) => {
    const url = `${origin}/platform/v1/artifacts/${row.id}`;
    pending[i].slot.set(url);
    return { source: pending[i].slot.source, url, id: row.id, mime: row.mime, bytes: row.bytes, width: row.width, height: row.height, truncated: row.truncated, sha256: row.sha256,
      expiresAt: new Date(row.expires_at).toISOString() };
  });
}
