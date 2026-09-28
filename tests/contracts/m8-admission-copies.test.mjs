// The host admission reader exists twice, once in each image that reads the admission file (services/access and
// services/retrieval each build their own, so neither can import the other's): below their header comments the two
// must be the same code, so the gateway and the retrieval service read one file one way, and their staleness bound is the
// one the operations scripts use (scripts/ops/lib.sh STALE_S). Runs on the workstation:
//   node --test tests/contracts/m8-admission-copies.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const body = (p) => { const lines = readFileSync(join(ROOT, p), "utf8").split("\n"); return lines.slice(lines.findIndex((l) => !l.startsWith("//"))).join("\n"); };

test("the gateway's and the retrieval service's admission readers are the same code below their headers", () => {
  const a = body("services/access/src/admission.mjs"), r = body("services/retrieval/src/admission.mjs");
  assert.ok(a.includes("export function parseAdmission") && a.length > 500, "the control: the body read is the module's code");
  assert.equal(r, a);
});

test("the services' staleness bound is the operations scripts' STALE_S", async () => {
  const { STALE_MS } = await import(join(ROOT, "services/access/src/admission.mjs"));
  const m = readFileSync(join(ROOT, "scripts/ops/lib.sh"), "utf8").match(/\bSTALE_S=(\d+)\b/);
  assert.ok(m, "the control: lib.sh states STALE_S");
  assert.equal(STALE_MS, +m[1] * 1000);
});
