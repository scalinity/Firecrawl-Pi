// The service's configuration: environment keys and flags, and the host's local-network file
// (review finding W9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadEnv, loadLocalCidrs, loadPolicy, parseSha256 } from "../src/policy.mjs";

const env = { PI_RETRIEVAL_LISTEN: "10.231.5.10:3310", PI_RETRIEVAL_PROXY_LISTEN: "10.231.2.10:3312", PI_EGRESS_POLICY_FILE: "/p", PI_EGRESS_LOCAL_CIDRS_FILE: "/l",
  PI_RESOLVER: "10.231.6.1", PI_BROWSER_URL: "http://10.231.2.20:3320", PI_CREDENTIALS_DIR: "/run/secrets", PI_POSTGRES_HOST: "nuq-postgres", PI_POSTGRES_DB: "postgres", PI_POSTGRES_USER: "fcpi_retrieval",
  PI_SEARCH_URL: "http://10.231.10.20:8080/search", PI_SEARCH_PROXY_LISTEN: "10.231.10.10:3313", PI_EXTRACT_LISTEN: "10.231.9.20:3314", PI_BUDGET_POLICY_FILE: "/b",
  PI_PROVIDERS_DIR: "/run/providers", PI_SELECTION_FILE: "/srv/providers/selection.json" };

test("the environment: unknown keys, the flags that must stay false, paid dispatch as a switch, the permit counts", () => {
  assert.deepEqual(loadEnv(env).permits, { url: 2, browser: 1 });
  assert.throws(() => loadEnv({ ...env, PI_SOMETHING_NEW: "1" }), /unknown configuration keys/);
  assert.throws(() => loadEnv({ ...env, PI_CLOUD_ACCESS_ENABLED: "true" }), /must be false/);
  // M7: the browser extras and webhook delivery are switches with a closed default.
  assert.equal(loadEnv(env).browserExtras, false);
  assert.equal(loadEnv({ ...env, PI_BROWSER_EXTRAS_ENABLED: "true" }).browserExtras, true);
  assert.throws(() => loadEnv({ ...env, PI_BROWSER_EXTRAS_ENABLED: "yes" }), /true or false/);
  assert.equal(loadEnv(env).webhookDelivery, "suppressed");
  assert.equal(loadEnv({ ...env, PI_WEBHOOK_DELIVERY: "enabled" }).webhookDelivery, "enabled");
  assert.throws(() => loadEnv({ ...env, PI_WEBHOOK_DELIVERY: "on" }), /enabled or suppressed/);
  // M5: paid dispatch is off unless set exactly to "true"; anything else stops startup.
  assert.equal(loadEnv(env).paidDispatch, false);
  assert.equal(loadEnv({ ...env, PI_PAID_DISPATCH_ENABLED: "true" }).paidDispatch, true);
  assert.throws(() => loadEnv({ ...env, PI_PAID_DISPATCH_ENABLED: "yes" }), /true or false/);
  assert.throws(() => loadEnv({ ...env, PI_SEARCH_URL: "http://searxng:8080/search" }), /fixed address/);
  assert.throws(() => loadEnv({ ...env, PI_MAX_URL_ACQUISITIONS: "3" }), /spec §23.1/);
  assert.throws(() => loadEnv({ ...env, PI_RESOLVER: "dns.example" }), /IPv4/);
  assert.throws(() => loadEnv({ ...env, PI_RETRIEVAL_LISTEN: "0.0.0.0" }), /ip:port/);
});

test("a permit lease shorter than an acquisition, or a token hash of the wrong length, fails at startup (review finding S3)", () => {
  const deployed = JSON.parse(readFileSync(new URL("../policy/egress.json", import.meta.url), "utf8"));
  assert.equal(loadPolicy(JSON.stringify(deployed)).permitLeaseMs, 120000);
  assert.throws(() => loadPolicy(JSON.stringify({ ...deployed, permitLeaseMs: 119999 })), /acquisitionDeadlineMs \+ 30000/);
  const hex = "ab".repeat(32);
  assert.equal(parseSha256(`sha256:${hex}`, "t").length, 32);
  assert.equal(parseSha256(hex, "t").length, 32);
  for (const bad of [`sha256:${hex}0`, `sha256:${hex.slice(2)}`, "sha256:", `sha256:${"zz".repeat(32)}`]) assert.throws(() => parseSha256(bad, "t"), /not a SHA-256/);
});

test("the local-network file must name at least one real network", () => {
  const l = loadLocalCidrs("# comment\n192.168.1.0/24\n\n2001:db8::/32\n");
  assert.equal(l.count, 2);
  assert.equal(l.list.check("192.168.1.9", "ipv4"), true);
  assert.throws(() => loadLocalCidrs(""), /names no network/);
  assert.throws(() => loadLocalCidrs("# only a comment\n"), /names no network/);
  assert.throws(() => loadLocalCidrs("192.168.1.0\n"), /not a network/);
  assert.throws(() => loadLocalCidrs("printer.lan/24\n"), /not a network/);
});
