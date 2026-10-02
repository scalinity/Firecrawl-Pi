// Pre-push scan of everything origin/main does not hold: every blob reachable from HEAD and not from the base, and
// every commit message in the range, with scripts/m8/verify.mjs's X05 rules, allow-list, positive controls, M0's
// hashed identifiers and the Pi's live secrets by SHA-256 (computed on the Pi). Prints findings as path:line rule only.
//   node history-scan.mjs <repo> <base> <head>
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const [repo, base, head] = process.argv.slice(2);
// The rules are X05's own: the redaction section of scripts/m8/verify.mjs, made a module at run time, so they never drift.
const W = join(tmpdir(), `fcpi-prepush-${process.pid}`), B = join(W, "blobs");
mkdirSync(B, { recursive: true });
const V = readFileSync(join(repo, "scripts/m8/verify.mjs"), "utf8");
const lib = pathToFileURL(join(repo, "scripts/m0/lib.mjs")).href;
writeFileSync(join(W, "rules.mjs"), `import { readFileSync } from "node:fs"; import { sha256 } from ${JSON.stringify(lib)}; const read = (p) => readFileSync(p, "utf8");\n`
  + V.slice(V.indexOf("// ---- redaction"), V.indexOf("// ---- snapshot attribution")) + "\nexport { RULES, ALLOW, HASH_RULES, scan, M0_CONTROL, M1_CONTROL, M3_CONTROL, M8_CONTROL };\n");
const { RULES, ALLOW, HASH_RULES, scan, M0_CONTROL, M1_CONTROL, M3_CONTROL, M8_CONTROL } = await import(pathToFileURL(join(W, "rules.mjs")).href);
const { sha256 } = await import(lib);
const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "buffer", maxBuffer: 1 << 30 });

// Positive controls: every rule must fire on its control file, as X05 requires.
const ctl = (p) => join(repo, p);
const c = [...scan([ctl(M0_CONTROL)], { m0: { egress: sha256("192.0.2.77"), serial: sha256("0123456789abcdef"), machineId: sha256("0123456789abcdef0123456789abcdef"), macs: new Set([sha256("02:00:00:00:00:01")]) } }, RULES, new Set()),
  ...scan([ctl(M1_CONTROL)], { secrets: new Set([sha256("0f".repeat(32)), sha256("ABCDEFGHIJKLMNOP".repeat(4))]) }, RULES, new Set()),
  ...scan([ctl(M8_CONTROL)], { secrets: new Set([sha256("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2")]) }, RULES, new Set()),
  ...scan([ctl(M3_CONTROL)], {}, RULES, new Set())];
const fired = new Set(c.map((h) => h.split(" ").pop()));
const silent = [...RULES.map(([n]) => n), ...HASH_RULES].filter((r) => !fired.has(r));
if (silent.length) { console.log(`CONTROLS FAILED: ${silent.join(",")}`); process.exit(2); }

// Live secrets, hashed on the Pi (X05's list).
const T = Object.fromEntries(readFileSync(join(repo, "scripts/m1/pi-target.conf"), "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
const src = readFileSync(join(repo, "scripts/m8/verify.mjs"), "utf8");
const cmd = src.slice(src.indexOf("const hashes = ssh(`") + "const hashes = ssh(`".length, src.indexOf("`).split(\"\\n\").filter((x) => /^[0-9a-f]{64}$/.test(x));"));
const shellCmd = cmd.replace(/\\\\/g, "\\").replace(/\\\n/g, "\n");
const hashes = execFileSync("ssh", ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", T.PI_SSH_TARGET, shellCmd], { encoding: "utf8" }).split("\n").filter((x) => /^[0-9a-f]{64}$/.test(x));
const audit = JSON.parse(readFileSync(join(repo, "evidence/M0/audit.json"), "utf8"));
const m0 = { egress: audit.network.egress_ip_sha256, serial: audit.identity.board_serial_sha256, machineId: audit.identity.machine_id_sha256, macs: new Set([...Object.values(audit.identity.mac_sha256), sha256("00:00:00:00:00:00")]) };

// Every new blob, with the paths it appears at.
const objs = git("rev-list", "--objects", `${base}..${head}`).toString().split("\n").filter(Boolean).map((l) => { const i = l.indexOf(" "); return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1)]; });
const check = execFileSync("git", ["-C", repo, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: objs.map(([s]) => s).join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean);
const info = new Map(check.map((l) => { const [s, t, n] = l.split(" "); return [s, { t, n: +n }]; }));
const blobs = new Map(); for (const [s, p] of objs) if (info.get(s)?.t === "blob") { if (!blobs.has(s)) blobs.set(s, new Set()); if (p) blobs.get(s).add(p); }
const files = [], binaries = [], large = [], where = new Map();
for (const [s, paths] of blobs) {
  const buf = git("cat-file", "blob", s), name = [...paths][0] ?? s;
  if (buf.length > 1024 * 1024) large.push(`${name} ${(buf.length / 1048576).toFixed(1)} MiB`);
  if (buf.includes(0) || /\.(pdf|png|gz|jpg|jpeg|webp|tar)$/i.test(name)) { binaries.push(`${name} ${buf.length} B`); continue; }
  const f = join(B, s); writeFileSync(f, buf); files.push(f); where.set(f, [...paths].join(" | "));
}
// Commit messages.
const msgs = join(B, "commit-messages.txt");
writeFileSync(msgs, git("log", "--format=%H%n%B%n-----", `${base}..${head}`)); files.push(msgs); where.set(msgs, "commit messages");

const hits = scan(files, { m0, secrets: new Set(hashes) }).map((h) => { const [at, rule] = h.split(" "); const f = at.slice(0, at.lastIndexOf(":")); return `${where.get(f)}:${at.slice(at.lastIndexOf(":") + 1)} ${rule}`; });
// The Pi's identifiers: the LAN address, its /24 and the SSH target, in any new blob or message.
const lan = T.PI_LAN_ADDRESS, net = lan.replace(/\.\d+$/, ".0");
const idHits = files.filter((f) => { const x = readFileSync(f, "utf8"); return x.includes(lan) || x.includes(`${net}/`) || x.includes(T.PI_SSH_TARGET); }).map((f) => where.get(f));
const hide = (s) => s.split(lan).join("<pi-lan-address>").split(T.PI_SSH_TARGET).join("<pi-ssh-target>").split(process.env.HOME).join("<home>");
console.log(hide(JSON.stringify({ commits: +git("rev-list", "--count", `${base}..${head}`).toString().trim(), blobs_scanned: files.length - 1, binaries: binaries.length, live_secret_hashes: hashes.length,
  controls: "every rule fired", findings: hits, identifier_files: idHits, large_blobs: large, binary_blobs: binaries }, null, 2)));
rmSync(W, { recursive: true, force: true });
