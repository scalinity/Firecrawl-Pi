// Unit tests for the client registry and the failure limiter (services/access/src/auth.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClients, makeRegistry, makeFailureLimiter } from "../src/auth.mjs";

const SCOPES = ["read", "scrape", "map", "crawl", "batch", "cancel"];
const tok = (label, n) => `fcpi_${label}_${String(n).repeat(64).slice(0, 64)}`;
const line = (label, principal, scopes, t) => `${label} ${principal} ${scopes} sha256:${createHash("sha256").update(t).digest("hex")}`;

test("the registry parses labels, principals and scopes and refuses what it cannot read", () => {
  const c = parseClients(`# comment\n${line("a", "owner", "read,crawl", tok("a", 1))}\n`, SCOPES);
  assert.equal(c.length, 1);
  assert.deepEqual([...c[0].scopes], ["read", "crawl"]);
  assert.throws(() => parseClients(line("a", "owner", "read,admin", tok("a", 1)), SCOPES), /unknown scope/);
  assert.throws(() => parseClients(`${line("a", "o", "read", tok("a", 1))}\n${line("a", "o", "read", tok("a", 2))}`, SCOPES), /twice/);
  assert.throws(() => parseClients("a owner read sha256:abc", SCOPES), /each line/);
});

test("authentication: the right token maps to its client; anything else is null", () => {
  const dir = mkdtempSync(join(tmpdir(), "fcpi-auth-"));
  try {
    const f = join(dir, "clients");
    writeFileSync(f, `${line("a", "pa", "read,crawl", tok("a", 1))}\n${line("b", "pb", "read", tok("b", 2))}\n`);
    const r = makeRegistry(f, SCOPES);
    assert.equal(r.authenticate(`Bearer ${tok("a", 1)}`).principal, "pa");
    assert.equal(r.authenticate(`Bearer ${tok("b", 2)}`).label, "b");
    for (const h of [undefined, "", "Bearer ", `Basic ${tok("a", 1)}`, `Bearer ${tok("a", 1)} x`, `Bearer ${tok("a", 3)}`, "Bearer short"]) assert.equal(r.authenticate(h), null, String(h));
  } finally { rmSync(dir, { recursive: true }); }
});

test("a replaced registry takes effect within a second: a removed token is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fcpi-auth-"));
  try {
    const f = join(dir, "clients");
    writeFileSync(f, `${line("a", "pa", "read", tok("a", 1))}\n${line("r", "pa", "read", tok("r", 9))}\n`);
    const r = makeRegistry(f, SCOPES);
    assert.ok(r.authenticate(`Bearer ${tok("r", 9)}`));
    writeFileSync(join(dir, "next"), `${line("a", "pa", "read", tok("a", 1))}\n`);
    renameSync(join(dir, "next"), f);
    // Polled rather than slept past the reload, so a loaded machine cannot turn it into a flake; the
    // bound it asserts is the spec's (a revocation takes effect within two seconds).
    const t0 = Date.now();
    while (r.authenticate(`Bearer ${tok("r", 9)}`) && Date.now() - t0 < 2000) await new Promise((res) => setTimeout(res, 50));
    assert.equal(r.authenticate(`Bearer ${tok("r", 9)}`), null);
    assert.ok(Date.now() - t0 <= 2050, `refused after ${Date.now() - t0} ms`);
    assert.ok(r.authenticate(`Bearer ${tok("a", 1)}`));
  } finally { rmSync(dir, { recursive: true }); }
});

test("a registry that stops parsing keeps the last good set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fcpi-auth-"));
  try {
    const f = join(dir, "clients");
    writeFileSync(f, `${line("a", "pa", "read", tok("a", 1))}\n`);
    const events = [];
    const r = makeRegistry(f, SCOPES, (e) => events.push(e.event));
    writeFileSync(join(dir, "next"), "garbage\n");
    renameSync(join(dir, "next"), f);
    await new Promise((res) => setTimeout(res, 1100));
    assert.ok(r.authenticate(`Bearer ${tok("a", 1)}`));
    assert.ok(events.includes("clients_rejected"));
  } finally { rmSync(dir, { recursive: true }); }
});

test("the failure limiter answers 0 within its budget and a wait past it", () => {
  const l = makeFailureLimiter(3);
  assert.deepEqual([l.fail(), l.fail(), l.fail()], [0, 0, 0]);
  const w = l.fail();
  assert.ok(w > 0 && w <= 60);
});
