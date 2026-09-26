#!/usr/bin/env node
// Resolve image references to their index digest and linux/arm64 manifest digest through the
// registry HTTP API, with anonymous pull tokens only (no docker on the workstation). The exact
// bytes of each index and arm64 manifest go to evidence/M2/registry/, so every digest can be
// recomputed offline as the SHA-256 of a saved file; one JSON line per reference is appended
// to evidence/M2/registry/resolved.jsonl. M0's resolver is not used: it writes into M0's record.
//   node scripts/m2/resolve-images.mjs registry-1.docker.io/library/golang:1.27.1-bookworm …
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "../m0/lib.mjs";

const OUT = resolve(ROOT, "evidence/M2/registry");
mkdirSync(OUT, { recursive: true });
const ACCEPT = "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json";
const sha256 = (b) => "sha256:" + createHash("sha256").update(b).digest("hex");

async function get(registry, repo, ref, token) {
  const r = await fetch(`https://${registry}/v2/${repo}/manifests/${ref}`, { headers: { accept: ACCEPT, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (r.status === 401 && !token) {
    const ch = r.headers.get("www-authenticate") ?? "";
    const realm = (ch.match(/realm="([^"]+)"/) ?? [])[1], service = (ch.match(/service="([^"]+)"/) ?? [])[1];
    if (!realm) throw new Error(`${registry}/${repo}: 401 without a usable challenge`);
    const u = new URL(realm);
    if (service) u.searchParams.set("service", service);
    u.searchParams.set("scope", `repository:${repo}:pull`);
    const t = await (await fetch(u)).json();
    return get(registry, repo, ref, t.token ?? t.access_token);
  }
  if (!r.ok) throw new Error(`${registry}/${repo}:${ref}: HTTP ${r.status}`);
  return { body: Buffer.from(await r.arrayBuffer()), header: r.headers.get("docker-content-digest"), token };
}

for (const spec of process.argv.slice(2)) {
  const m = spec.match(/^([^/]+)\/(.+):([^:]+)$/);
  if (!m) throw new Error(`expected registry/repository:tag, got ${spec}`);
  const [, registry, repo, tag] = m;
  const utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const top = await get(registry, repo, tag);
  const index = JSON.parse(top.body);
  const safe = `${registry}_${repo}_${tag}`.replace(/[/:@]/g, "_");
  writeFileSync(resolve(OUT, `${safe}.index.json`), top.body);
  const arm = (index.manifests ?? []).find((x) => x.platform?.os === "linux" && x.platform?.architecture === "arm64" && (x.platform.variant ?? "v8") === "v8");
  if (!arm) throw new Error(`${spec}: no linux/arm64 manifest in the index`);
  const man = await get(registry, repo, arm.digest, top.token);
  if (sha256(man.body) !== arm.digest) throw new Error(`${spec}: arm64 manifest bytes do not hash to ${arm.digest}`);
  writeFileSync(resolve(OUT, `${safe}.arm64.json`), man.body);
  const row = { registry, repository: repo, tag, resolved_utc: utc, index_digest: sha256(top.body), registry_reported_digest: top.header, arm64_manifest_digest: arm.digest,
    index_file: `evidence/M2/registry/${safe}.index.json`, arm64_manifest_file: `evidence/M2/registry/${safe}.arm64.json` };
  if (row.index_digest !== row.registry_reported_digest) throw new Error(`${spec}: saved index hashes to ${row.index_digest}, registry reported ${row.registry_reported_digest}`);
  appendFileSync(resolve(OUT, "resolved.jsonl"), JSON.stringify(row) + "\n");
  console.log(`${spec} index=${row.index_digest} arm64=${row.arm64_manifest_digest}`);
}
