// The owner's paid-dispatch switch (FIRECRAWL_PI_SPEC.md §28.3; review R4): the retrieval service reads
// PI_PAID_DISPATCH_ENABLED from the optional host file /etc/firecrawl-pi/paid-dispatch.env alone, so every start without
// it, a reboot or a restore included, runs with paid dispatch off; the restore test's isolated copy forces it off even
// when the rendered file carries it on; and the restore and rollback procedures move the switch aside before anything
// starts. Runs on the workstation (jq):   node --test tests/contracts/paid-dispatch-switch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const SWITCH = "/etc/firecrawl-pi/paid-dispatch.env";

test("the retrieval service takes the switch from the optional host file alone; no other service or setting names it", () => {
  const compose = read("deploy/compose.yaml");
  const block = compose.slice(compose.indexOf("\n  retrieval-service:\n"), compose.indexOf("\n  browser-worker:\n"));
  assert.ok(block.length > 100, "the retrieval service's block was found");
  assert.match(block, new RegExp(`\\n    env_file:\\n      - path: ${SWITCH.replace(/\./g, "\\.")}\\n        required: false\\n`));
  assert.equal(compose.split(SWITCH).length, block.split(SWITCH).length, "only the retrieval service names the switch");
  assert.doesNotMatch(compose, /PI_PAID_DISPATCH_ENABLED:/, "no environment entry overrides the switch");
});

test("the restore test's copy runs with paid dispatch off, its env file moved under the copy, even when the rendered file carries the switch on", () => {
  const rendered = JSON.parse(read("tests/fixtures/m8/rendered-compose.json"));
  const r = rendered.services["retrieval-service"];
  r.env_file = [{ path: SWITCH, required: false }];
  r.environment = { ...r.environment, PI_PAID_DISPATCH_ENABLED: "true" };   // as `docker compose config` merges the file in
  const R = "/srv/firecrawl-pi/restore-test";
  const run = (program) => JSON.parse(execFileSync("jq", ["-L", join(ROOT, "scripts/ops"), "--arg", "R", R, `include "restore"; ${program}`], { input: JSON.stringify(rendered), encoding: "utf8" }));
  const copy = run("compose($R)");
  assert.equal(copy.services["retrieval-service"].environment.PI_PAID_DISPATCH_ENABLED, "false");
  assert.deepEqual(copy.services["retrieval-service"].env_file, [{ path: `${R}/fs${SWITCH}`, required: false }]);
  assert.deepEqual(run("compose($R) | outside($R)"), []);
});

test("restore and rollback move the switch aside before anything starts, and say when it returns", () => {
  const steps = read("scripts/ops/restore-procedure.txt");
  const six = steps.slice(steps.indexOf("\n6. "), steps.indexOf("\n7. "));
  const aside = six.indexOf(`mv ${SWITCH} ${SWITCH}.held`), up = six.indexOf("up -d --wait");
  assert.ok(aside > 0 && up > aside, "step 6 moves the switch aside before it starts the stack");
  assert.match(six, /fcpi paid on/);
  const plan = read("scripts/ops/plan.sh");
  const moved = plan.indexOf(`mv ${SWITCH} ${SWITCH}.held`), restored = plan.indexOf("restore the data directories from backup");
  assert.ok(moved > 0 && restored > moved, "the rollback plan moves the switch aside before it restores data");
  assert.match(plan, /reconcile provider spend newer than the backup, then fcpi paid on/);
  // fcpi paid writes exactly the line the service reads, and leaves a stopped service stopped.
  const fcpi = read("scripts/fcpi");
  assert.match(fcpi, /printf 'PI_PAID_DISPATCH_ENABLED=true\\n' \| write_atomic "\$f" 0644/);
  assert.match(fcpi, /docker ps -q --filter name=\^fcpi-retrieval-service-1\$/);
});
