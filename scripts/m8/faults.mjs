#!/usr/bin/env node
// M8's failure-injection driver (docs/FIRECRAWL_PI_MILESTONES.md, M8 "Automated Verification"; spec §24.2). It runs on
// the workstation and sequences scripts/m8/pi-fault.sh's cases on the Pi over SSH, each after the stack is ready again,
// then the normal reboot, which it triggers and waits out from here: the Pi's own boot record (scripts/ops/boot-record.sh)
// times the readiness, with no SSH action on the Pi in between. The selection found at the start (fixture engine, model
// and parser for the cases that use them) is restored at the end. Output: the cases' sections verbatim, then "### reboot".
//   node scripts/m8/faults.mjs [case …] > evidence/M8/raw/faults.txt      (all cases, in order, when none is named)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const T = Object.fromEntries(readFileSync(join(ROOT, "scripts/m1/pi-target.conf"), "utf8").split("\n").filter((l) => /^PI_\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace("$HOME", process.env.HOME)]));
const SSH = ["-i", T.PI_SSH_KEY, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8"];
const hide = (s) => [[T.PI_SSH_KEY, "<pi-ssh-key>"], [T.PI_SSH_TARGET, "<pi-ssh-target>"], [T.PI_SSH_TARGET.split("@").at(-1), "<pi-ssh-host>"], [T.PI_LAN_ADDRESS, "<pi-lan-address>"], [process.env.HOME, "<home>"]].reduce((x, [a, b]) => (a ? x.split(a).join(b) : x), s);
const pi = (cmd, timeoutMs = 3600000) => execFileSync("ssh", [...SSH, T.PI_SSH_TARGET, cmd], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (section, o) => process.stdout.write(`### ${section}\n${hide(JSON.stringify({ utc: new Date().toISOString(), ...o }))}\n`);
const ORDER = ["swap_reload", "foreign_container", "log_bounds", "doctor", "thermal_pressure", "disk_pressure", "memory_pressure", "searxng_down", "providers_down",
  "proxy_down", "egress_down", "browser_crash", "mcp_crash", "api_child_crash", "worker_child_crash", "redis_down", "rabbitmq_down", "postgres_down", "supervisor",
  "docker_restart", "missing_mount", "reboot"];
const cases = process.argv.slice(2).length ? process.argv.slice(2) : ORDER;
const READY = `sudo -n bash /opt/firecrawl-pi/scripts/ops/status.sh --json | jq -e '.healthy and .mcp.ready' >/dev/null`;
async function waitReady(ms = 900000) {
  const end = Date.now() + ms;
  for (;;) { try { pi(READY, 60000); return true; } catch { /* not yet */ } if (Date.now() > end) return false; await sleep(10000); }
}

say("meta", { deployed_commit: pi("cat /opt/firecrawl-pi/.fcpi-source-commit").trim(), boot: pi("sha256sum </proc/sys/kernel/random/boot_id | cut -c1-64").trim(),
  selection_before: JSON.parse(pi("bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show")), cases });
const before = JSON.parse(pi("bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show"));
pi("bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh fixture fcpi-fixture-model fcpi-fixture-parser none none");
for (const c of cases) {
  if (!(await waitReady())) say("not_ready", { before_case: c });
  if (c === "reboot") { await reboot(); continue; }
  try { process.stdout.write(hide(pi(`sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-fault.sh ${c}`))); }
  catch (e) { process.stdout.write(hide(String(e.stdout ?? ""))); say("case_error", { case: c, status: e.status ?? null, stderr: hide(String(e.stderr ?? "")).slice(0, 2000) }); }
}
await waitReady();
const b = before;
pi(`bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh ${b.search} ${b.extractionModel} ${b.parser} ${b.proxy ?? "none"} ${b.enhanced ?? "none"}`);
say("end", { selection_after: JSON.parse(pi("bash /opt/firecrawl-pi/scripts/m5/pi-selection.sh show")) });

// The normal reboot: an orderly `systemctl reboot`, then nothing but waiting until SSH answers and the Pi's own boot
// record holds its readiness line. The record is read, never written, from here.
async function reboot() {
  const bootBefore = pi("sha256sum </proc/sys/kernel/random/boot_id | cut -c1-64").trim();
  const t0 = Date.now();
  try { pi("sudo -n systemctl reboot", 30000); } catch { /* the connection drops as the host goes down */ }
  let bootAfter = bootBefore;
  const end = Date.now() + 1800000;
  while (Date.now() < end) {
    await sleep(15000);
    try { bootAfter = pi("sha256sum </proc/sys/kernel/random/boot_id | cut -c1-64", 20000).trim(); if (bootAfter !== bootBefore) break; } catch { /* still down */ }
  }
  const sshBackS = Math.round((Date.now() - t0) / 1000);
  let record = null;
  for (let i = 0; i < 120 && bootAfter !== bootBefore; i++) {
    try {
      const f = pi(`ls -1 /var/lib/firecrawl-pi/boots/*-${bootAfter.slice(0, 12)}.txt 2>/dev/null | head -1`).trim();
      if (f) { const text = pi(`cat ${f}`); if (/^stack_active_after_boot_s=.* ready_after_boot_s=/m.test(text)) { record = { file: f.split("/").pop(), text }; break; } }
    } catch { /* not yet */ }
    await sleep(10000);
  }
  // The reboot this driver made, kept as its own durable record beside the boot records (never overwritten), so the snapshot
  // attribution can tie it whatever later runs replace faults.txt.
  const EVD = process.env.FCPI_M8_EVIDENCE ?? "evidence/M8/", stamp = new Date(t0).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  mkdirSync(join(EVD.startsWith("/") ? EVD : join(ROOT, EVD), "reboots"), { recursive: true });
  writeFileSync(join(EVD.startsWith("/") ? EVD : join(ROOT, EVD), "reboots", `driven-${stamp}.txt`), `### driven\n${JSON.stringify({ utc: new Date(t0).toISOString(),
    source: "scripts/m8/faults.mjs reboot (an orderly sudo systemctl reboot the driver made)", boot_before: bootBefore, boot_after: bootAfter, ssh_back_after_s: sshBackS, record_file: record?.file ?? null })}\n`, { flag: "wx" });
  say("reboot", { boot_before: bootBefore, boot_after: bootAfter, ssh_back_after_s: sshBackS, record_file: record?.file ?? null, record: record ? hide(record.text) : null,
    status_after: (() => { try { return JSON.parse(pi("sudo -n bash /opt/firecrawl-pi/scripts/ops/status.sh --json")); } catch { return null; } })() });
}
