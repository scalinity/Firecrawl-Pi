// The service's configuration: environment keys and flags, and the host's local-network file
// (review finding W9).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv, loadLocalCidrs } from "../src/policy.mjs";

const env = { PI_RETRIEVAL_LISTEN: "10.231.5.10:3310", PI_RETRIEVAL_PROXY_LISTEN: "10.231.2.10:3312", PI_EGRESS_POLICY_FILE: "/p", PI_EGRESS_LOCAL_CIDRS_FILE: "/l",
  PI_RESOLVER: "10.231.6.1", PI_BROWSER_URL: "http://10.231.2.20:3320", PI_CREDENTIALS_DIR: "/run/secrets", PI_POSTGRES_HOST: "nuq-postgres", PI_POSTGRES_DB: "postgres", PI_POSTGRES_USER: "fcpi_retrieval" };

test("the environment: unknown keys, the flags that must stay false, the permit counts", () => {
  assert.deepEqual(loadEnv(env).permits, { url: 2, browser: 1 });
  assert.throws(() => loadEnv({ ...env, PI_SOMETHING_NEW: "1" }), /unknown configuration keys/);
  for (const k of ["PI_PAID_DISPATCH_ENABLED", "PI_CLOUD_ACCESS_ENABLED", "PI_BROWSER_EXTRAS_ENABLED"]) assert.throws(() => loadEnv({ ...env, [k]: "true" }), /must be false/);
  assert.throws(() => loadEnv({ ...env, PI_MAX_URL_ACQUISITIONS: "3" }), /spec §23.1/);
  assert.throws(() => loadEnv({ ...env, PI_RESOLVER: "dns.example" }), /IPv4/);
  assert.throws(() => loadEnv({ ...env, PI_RETRIEVAL_LISTEN: "0.0.0.0" }), /ip:port/);
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
