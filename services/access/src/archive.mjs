// The archived-result store (FIRECRAWL_PI_SPEC.md §21.2, §21.3): documents as content-addressed files
// under <root>/results/<first two hex>/<sha256>.json. A document is written to a temporary file,
// fsynced, renamed into place and its directory fsynced before its manifest row may commit, so a
// crash leaves at worst an unreferenced file, which the sweep removes, never a referenced one missing.
// The root must hold the marker scripts/m3/pi-init-m3.sh writes: without it the store refuses to
// start rather than write into a directory that is not the project's data mount.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, open, rename, readdir, stat, unlink, statfs, utimes, readFile } from "node:fs/promises";
import { join } from "node:path";

export const MARKER = ".fcpi-artifact-root";

export async function openArchive(root) {
  if (!existsSync(join(root, MARKER))) throw new Error(`artifact root ${root} lacks ${MARKER}: refusing to write outside the project's data mount`);
  const results = join(root, "results"), tmp = join(root, "tmp");
  await mkdir(results, { recursive: true, mode: 0o700 });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  const pathOf = (sha) => join(results, sha.slice(0, 2), `${sha}.json`);
  const fsyncDir = async (dir) => { const h = await open(dir, "r"); try { await h.sync(); } finally { await h.close(); } };

  return {
    pathOf,
    // Stores the bytes if absent; returns { sha256, bytes }.
    async put(buf) {
      const sha = createHash("sha256").update(buf).digest("hex");
      const final = pathOf(sha);
      // An existing copy is touched, so a sweep cannot take it as an hour-old orphan before its row commits.
      if (existsSync(final)) { const t = new Date(); await utimes(final, t, t); return { sha256: sha, bytes: buf.length }; }
      const dir = join(results, sha.slice(0, 2));
      // A shard created here has its own entry in results/ made durable too, before a row can name a file in it.
      if (await mkdir(dir, { recursive: true, mode: 0o700 })) await fsyncDir(results);
      const t = join(tmp, `${randomUUID()}.part`);
      const h = await open(t, "wx", 0o600);
      try { await h.writeFile(buf); await h.sync(); } finally { await h.close(); }
      await rename(t, final);
      await fsyncDir(dir);
      return { sha256: sha, bytes: buf.length };
    },
    stream: (sha) => createReadStream(pathOf(sha)),
    // A whole document, checked against its name (M5: an extraction resumes from the pages it archived).
    async read(sha) {
      const buf = await readFile(pathOf(sha));
      if (createHash("sha256").update(buf).digest("hex") !== sha) throw new Error(`archived document ${sha} does not match its name`);
      return buf;
    },
    // The quota (spec §21.3): the smaller of 10 GiB and 20% of the filesystem holding the root.
    async quotaBytes() {
      const s = await statfs(root);
      return Math.min(10 * 1024 ** 3, Math.floor(s.blocks * s.bsize * 0.2));
    },
    // Whether `bytes` more still leave the filesystem its floor of free space: the smaller of 1 GiB and
    // 5% of it, since other data (the ledger's PostgreSQL among it) shares the filesystem.
    async hasRoom(bytes) {
      const s = await statfs(root);
      return s.bavail * s.bsize - bytes >= Math.min(1024 ** 3, Math.floor(s.blocks * s.bsize * 0.05));
    },
    // Removes temporary files and unreferenced documents older than an hour; `referenced(shas)`
    // answers which of a batch of hashes a manifest row still names.
    async sweep(referenced, olderThanMs = 3600000) {
      const now = Date.now();
      let removed = 0;
      for (const f of await readdir(tmp)) {
        const p = join(tmp, f);
        if (now - (await stat(p)).mtimeMs > olderThanMs) { await unlink(p); removed += 1; }
      }
      for (const d of await readdir(results)) {
        const files = (await readdir(join(results, d))).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
        const keep = await referenced(files.map((f) => f.slice(0, 64)));
        for (const f of files) {
          const p = join(results, d, f);
          if (!keep.has(f.slice(0, 64)) && now - (await stat(p)).mtimeMs > olderThanMs) { await unlink(p); removed += 1; }
        }
      }
      return removed;
    },
  };
}
