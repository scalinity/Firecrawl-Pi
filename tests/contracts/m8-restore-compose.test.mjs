// The restore test's isolated copy (scripts/ops/restore.jq, run by scripts/ops/restore-test.sh) against the Compose file
// the Pi renders (tests/fixtures/m8/rendered-compose.json, from scripts/m1/pi-rendered-compose.sh): the copy must share
// no host path with production, publish nothing, reach nothing outside (no egress network, every network internal and
// isolated, its own addresses and bridge names), keep webhooks and paid dispatch off, and label every container transient.
// The first test is the positive control: the unchanged file does name production's paths. Runs on the workstation (jq):
//   node --test tests/contracts/m8-restore-compose.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = join(ROOT, "tests/fixtures/m8/rendered-compose.json");
const R = "/srv/firecrawl-pi/restore-test";
const jq = (program, input = FIXTURE) => JSON.parse(execFileSync("jq", ["-L", join(ROOT, "scripts/ops"), "--arg", "R", R, `include "restore"; ${program}`, input], { encoding: "utf8" }));
const prod = JSON.parse(readFileSync(FIXTURE, "utf8"));
const copy = jq("compose($R)");
const KEPT = ["nuq-postgres", "redis", "rabbitmq", "firecrawl-core", "access-gateway", "mcp-gateway", "retrieval-service", "fixture"];

test("the positive control: production's file names host paths outside the copy, publishes a port and has the egress network", () => {
  assert.ok(jq("outside($R)").length > 10);
  assert.ok(Object.values(prod.services).some((s) => (s.ports ?? []).length > 0));
  assert.ok(prod.networks.egress);
});

test("every host path the copy names is under its directory", () => {
  assert.deepEqual(jq("compose($R) | outside($R)"), []);
  assert.ok(!JSON.stringify(copy).match(/"\/(srv\/firecrawl-pi\/data|etc\/firecrawl-pi|opt\/firecrawl-pi|run\/firecrawl-pi\/admission)\//), "a production path is left in the copy");
});

test("the copy runs only the kept services, publishes nothing and reaches no egress network", () => {
  assert.equal(copy.name, "fcpi-restore");
  assert.deepEqual(Object.keys(copy.services).sort(), [...KEPT].sort());
  for (const [name, s] of Object.entries(copy.services)) {
    assert.equal(s.ports, undefined, `${name} publishes a port`);
    assert.ok(!Object.keys(s.networks ?? {}).includes("egress"), `${name} is on the egress network`);
    assert.equal(s.labels?.["fcpi.transient"], "restore-test", `${name} is not labelled transient`);
    for (const d of Object.keys(s.depends_on ?? {})) assert.ok(KEPT.includes(d), `${name} depends on ${d}, which the copy does not run`);
  }
});

test("every network is internal, isolated, renamed and moved off production's addresses", () => {
  assert.equal(copy.networks.egress, undefined);
  for (const [k, n] of Object.entries(copy.networks)) {
    assert.equal(n.internal, true, `${k} is not internal`);
    assert.match(n.name, /^fcpi_r_/);
    assert.equal(n.driver_opts?.["com.docker.network.bridge.gateway_mode_ipv4"], "isolated", `${k} is not isolated`);
    if (n.driver_opts?.["com.docker.network.bridge.name"]) assert.match(n.driver_opts["com.docker.network.bridge.name"], /^fcpi-r-/);
    for (const c of n.ipam?.config ?? []) assert.match(c.subnet, /^10\.231\.2\d\d\./, `${k} keeps production's subnet ${c.subnet}`);
  }
});

test("webhook delivery and paid dispatch are off in the copy", () => {
  assert.equal(copy.services["retrieval-service"].environment.PI_WEBHOOK_DELIVERY, "suppressed");
  assert.equal(copy.services["retrieval-service"].environment.PI_PAID_DISPATCH_ENABLED, "false");
  assert.equal(copy.services["firecrawl-core"].environment.DISABLE_WEBHOOK_DELIVERY, "true");
});
