// The host admission reader exists twice, once in each image that reads the admission file (services/access and
// services/retrieval each build their own, so neither can import the other's): below their header comments the two
// must be the same code, so the gateway and the retrieval service read one file one way. Runs on the workstation:
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
