#!/usr/bin/env node
// The native route shapes at the pinned revision (spec §16.1: "verify the pinned methods and route
// suffixes for every native status/cancel endpoint"), from a source tree prepared by
// scripts/m2/prepare-api-source.sh (upstream 7666c1f9 plus the patch series):
//   node scripts/m3/route-shapes.mjs <prepared-source-dir> > evidence/M3/raw/route-shapes.txt
// Prints the tree's identity, the hashes of the route and schema files, every v2Router registration,
// each manifest route with the upstream registration it names (or MISSING), each route the manifest
// does not enable with whether upstream registers it, and the routes the pinned official client
// (apps/js-sdk/firecrawl) calls. scripts/m3/verify.mjs (R01) recomputes the verdicts from this output.
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src) { console.error("usage: route-shapes.mjs <prepared-source-dir>"); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(join(root, "deploy/policies/capabilities.json"), "utf8"));
const sha = (p) => createHash("sha256").update(readFileSync(join(src, p))).digest("hex");
const git = (...a) => execFileSync("git", ["-C", src, ...a], { encoding: "utf8" }).trim();
const out = (s) => process.stdout.write(`${s}\n`);

out("### meta");
out(`utc=${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`);
out(`head=${git("rev-parse", "HEAD")}`);
git("add", "-A");
out(`tree=${git("write-tree")}`);
out(`routes_file=${manifest.upstream.routes_file} sha256=${sha(manifest.upstream.routes_file)}`);
out(`schemas_file=${manifest.upstream.schemas_file} sha256=${sha(manifest.upstream.schemas_file)}`);
const sdk = JSON.parse(readFileSync(join(src, "apps/js-sdk/firecrawl/package.json"), "utf8"));
out(`client=${sdk.name}@${sdk.version}`);

// Registrations in apps/api/src/routes/v2.ts: v2Router.<method>( followed by one quoted path, or an
// array of them (["/browser", "/interact"]).
const text = readFileSync(join(src, manifest.upstream.routes_file), "utf8");
const REG = /v2Router\.(get|post|put|delete|ws)\(\s*(\[[^\]]*\]|"[^"]+")/g;
const regs = [...text.matchAll(REG)].flatMap((m) => [...m[2].matchAll(/"([^"]+)"/g)].map((p) => `${m[1].toUpperCase()} /v2${p[1]}`));
out("### registrations");
for (const r of regs) out(r);

// A manifest path with {id} corresponds to upstream's :jobId (or :id).
const upstreamForm = (method, path) => `${method} ${path.replace("{id}", ":jobId")}`;
out("### manifest_routes");
for (const r of manifest.routes) {
  if (!r.upstream) { out(`${r.id} ${r.method} ${r.path} platform`); continue; }
  const found = regs.includes(r.upstream);
  out(`${r.id} ${r.method} ${r.path} upstream=${r.upstream.replace(" ", "_")} ${found ? "FOUND" : "MISSING"} same_shape=${upstreamForm(r.method, r.path) === r.upstream}`);
}
out("### not_enabled");
for (const r of manifest.not_enabled) {
  const up = upstreamForm(r.method, r.path);
  out(`${r.method} ${r.path} ${regs.includes(up) || regs.includes(up.replace(":jobId", ":id")) ? "REGISTERED" : "ABSENT"}`);
}

// The official client's calls: the first /v2 string after http.get/post/delete, past any type
// argument however nested (http.get<{ data?: Array<…> }>(`/v2/crawl/${id}/errors`)).
out("### client_calls");
const mdir = join(src, "apps/js-sdk/firecrawl/src/v2/methods");
const CALL = /http\.(get|post|delete)[\s\S]{0,600}?\(\s*[`"](\/v2\/[^`"]+)[`"]/g;
const calls = new Set();
for (const f of readdirSync(mdir)) {
  for (const m of readFileSync(join(mdir, f), "utf8").matchAll(CALL)) calls.add(`${m[1].toUpperCase()} ${m[2].replace(/\$\{[^}]+\}/g, "{id}")}`);
}
for (const c of [...calls].sort()) {
  const served = manifest.routes.some((r) => `${r.method} ${r.path}` === c) ? "served" : manifest.not_enabled.some((r) => `${r.method} ${r.path}` === c) ? "not_enabled" : "unserved";
  out(`${c} ${served}`);
}
out("end");
