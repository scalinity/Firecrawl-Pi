// SI5's captures: a page that is a bot interstitial is not a capture of the page (spec §23.1: missing or inaccessible material
// is unjudged, not irrelevant). The test is the retrieval service's own (services/retrieval/src/quality.mjs), applied to a
// capture's final URL; a gated capture is rewritten as blocked, with its hashes kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gated, asBlocked } from "../scripts/si5/gate.mjs";

const thread = "https://www.reddit.com/r/linuxadmin/comments/1j417bx/struggling_with_forcing_systemd_to_keep/";
const gate = { url: thread, capturedAt: "2026-10-18T02:00:00.000Z", status: "captured", statusCode: 200, proxyUsed: "basic", error: null, title: "Reddit - Prove your humanity",
  finalUrl: `${thread}?solution=0a1b&js_challenge=1&jsc_token=t0k3n&jsc_orig_r=`, markdownSha256: "a".repeat(64), markdownChars: 165 };

test("a capture whose final URL carries Reddit's challenge parameters is gated; the thread itself and look-alikes are not", () => {
  assert.equal(gated(gate), true);
  assert.equal(gated({ ...gate, finalUrl: thread, title: "Struggling with systemd : r/linuxadmin" }), false, "the thread's own URL");
  assert.equal(gated({ ...gate, finalUrl: `${thread}?js_challenge=1` }), false, "one parameter alone");
  assert.equal(gated({ ...gate, finalUrl: "https://example.org/a?js_challenge=1&jsc_token=t" }), false, "another host");
  assert.equal(gated({ ...gate, finalUrl: "https://notreddit.com/a?js_challenge=1&jsc_token=t" }), false, "a look-alike host");
  assert.equal(gated({ ...gate, finalUrl: null }), false, "a capture that kept no final URL");
  assert.equal(gated({ ...gate, finalUrl: "not a url" }), false, "an unparseable final URL");
});

test("a gated capture becomes blocked with the platform's failure class, keeping every hash, and the input is not changed", () => {
  const before = structuredClone(gate), b = asBlocked(gate);
  assert.deepEqual(gate, before, "the input is untouched");
  assert.equal(b.status, "blocked");
  assert.match(b.error, /^BLOCKED_PUBLIC_CONTENT: /);
  for (const k of ["url", "capturedAt", "statusCode", "proxyUsed", "finalUrl", "markdownSha256", "markdownChars"]) assert.equal(b[k], gate[k], k);
});
