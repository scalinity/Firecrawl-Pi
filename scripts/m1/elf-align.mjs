// Prints the smallest PT_LOAD p_align of each ELF64 little-endian file given as an argument,
// one JSON line per file. D2 names a LOAD alignment below 0x4000 (16 KiB) in a binary
// that fails to load as a page-size signature. Runs inside a container with Node.
import { openSync, readSync, closeSync } from "node:fs";

for (const path of process.argv.slice(2)) {
  const out = { path };
  try {
    const fd = openSync(path, "r");
    const head = Buffer.alloc(64);
    readSync(fd, head, 0, 64, 0);
    if (head.readUInt32BE(0) !== 0x7f454c46 || head[4] !== 2 || head[5] !== 1) throw new Error("not ELF64 little-endian");
    out.machine = head.readUInt16LE(18) === 183 ? "aarch64" : head.readUInt16LE(18);
    const phoff = Number(head.readBigUInt64LE(32));
    const phentsize = head.readUInt16LE(54);
    const phnum = head.readUInt16LE(56);
    const ph = Buffer.alloc(phentsize * phnum);
    readSync(fd, ph, 0, ph.length, phoff);
    closeSync(fd);
    const loads = [];
    for (let i = 0; i < phnum; i++) {
      const o = i * phentsize;
      if (ph.readUInt32LE(o) === 1) loads.push(Number(ph.readBigUInt64LE(o + 48)));
    }
    out.load_segments = loads.length;
    out.min_load_align_hex = "0x" + Math.min(...loads).toString(16);
    out.page_16k_compatible = Math.min(...loads) >= 0x4000;
  } catch (e) {
    out.error = e.message;
  }
  console.log(JSON.stringify(out));
}
