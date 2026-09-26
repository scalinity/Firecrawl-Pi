// Unit tests for the content-addressed result store (services/access/src/archive.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive, MARKER } from "../src/archive.mjs";

const root = () => { const d = mkdtempSync(join(tmpdir(), "fcpi-archive-")); writeFileSync(join(d, MARKER), "test\n"); return d; };

test("a root without the marker is refused, so nothing is written to a shadow directory", async () => {
  const d = mkdtempSync(join(tmpdir(), "fcpi-archive-"));
  try {
    await assert.rejects(openArchive(d), /lacks/);
    assert.deepEqual(readdirSync(d), []);
  } finally { rmSync(d, { recursive: true }); }
});

test("put stores bytes under their SHA-256, once, and nothing stays in tmp", async () => {
  const d = root();
  try {
    const a = await openArchive(d);
    const buf = Buffer.from('{"markdown":"hello"}');
    const r = await a.put(buf);
    assert.equal(r.sha256, createHash("sha256").update(buf).digest("hex"));
    assert.equal(r.bytes, buf.length);
    assert.deepEqual(readFileSync(a.pathOf(r.sha256)), buf);
    assert.deepEqual(await a.put(buf), r);
    assert.deepEqual(readdirSync(join(d, "tmp")), []);
  } finally { rmSync(d, { recursive: true }); }
});

test("the sweep keeps referenced and recent files and removes old orphans and temp files", async () => {
  const d = root();
  try {
    const a = await openArchive(d);
    const keep = await a.put(Buffer.from("keep"));
    const orphan = await a.put(Buffer.from("orphan"));
    const fresh = await a.put(Buffer.from("fresh"));
    const old = new Date(Date.now() - 2 * 3600000);
    utimesSync(a.pathOf(keep.sha256), old, old);
    utimesSync(a.pathOf(orphan.sha256), old, old);
    writeFileSync(join(d, "tmp", "x.part"), "partial");
    utimesSync(join(d, "tmp", "x.part"), old, old);
    const removed = await a.sweep(async (shas) => new Set(shas.filter((s) => s === keep.sha256)));
    assert.equal(removed, 2);
    assert.ok(existsSync(a.pathOf(keep.sha256)));
    assert.ok(existsSync(a.pathOf(fresh.sha256)));
    assert.equal(existsSync(a.pathOf(orphan.sha256)), false);
  } finally { rmSync(d, { recursive: true }); }
});

test("putting bytes again refreshes an old copy, so a sweep cannot take it before its row commits", async () => {
  const d = root();
  try {
    const a = await openArchive(d);
    const r = await a.put(Buffer.from("again"));
    const old = new Date(Date.now() - 2 * 3600000);
    utimesSync(a.pathOf(r.sha256), old, old);
    await a.put(Buffer.from("again"));
    assert.equal(await a.sweep(async () => new Set()), 0);
    assert.ok(existsSync(a.pathOf(r.sha256)));
  } finally { rmSync(d, { recursive: true }); }
});

test("the quota is at most 10 GiB", async () => {
  const d = root();
  try { const q = await (await openArchive(d)).quotaBytes(); assert.ok(q > 0 && q <= 10 * 1024 ** 3); } finally { rmSync(d, { recursive: true }); }
});

test("room is refused for more than the filesystem can hold above its free-space floor", async () => {
  const d = root();
  try {
    const a = await openArchive(d);
    assert.equal(await a.hasRoom(1), true);
    assert.equal(await a.hasRoom(Number.MAX_SAFE_INTEGER), false);
  } finally { rmSync(d, { recursive: true }); }
});
