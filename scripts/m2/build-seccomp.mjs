#!/usr/bin/env node
// Writes deploy/browser/seccomp.json: Docker Engine 29.8.1's own default seccomp profile (the
// engine the Pi runs; evidence/M2/sources/moby-docker-v29.8.1-seccomp-default.json) plus one rule.
//   node scripts/m2/build-seccomp.mjs          (write)
//   node scripts/m2/build-seccomp.mjs --check  (exit 1 unless the committed file is this output)
// The rule allows chroot, clone and unshare whatever the container's capabilities are. Chromium's
// namespace sandbox needs all three: it clones its zygote and renderers into new user, PID and
// network namespaces and chroots them into an empty directory. Docker's default allows those
// only to a container holding CAP_SYS_ADMIN (clone and unshare with namespace flags) or
// CAP_SYS_CHROOT (chroot), and the browser worker holds no capability. Allowing the syscalls
// does not grant the capabilities: the kernel still requires CAP_SYS_CHROOT or CAP_SYS_ADMIN
// in the caller's user namespace, which a process has only inside a user namespace it created.
// On the Pi, removing any one of the three made Chromium report "sandboxing failed"
// (evidence/M2/raw/browser-proof.txt); Playwright's own profile adds setns as well, which
// Chromium does not need.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../m0/lib.mjs";

const SOURCE = "evidence/M2/sources/moby-docker-v29.8.1-seccomp-default.json";
const OUT = "deploy/browser/seccomp.json";
export const RULE = { names: ["chroot", "clone", "unshare"], action: "SCMP_ACT_ALLOW", comment: "fcpi: Chromium's namespace sandbox (scripts/m2/build-seccomp.mjs)" };

const profile = JSON.parse(readFileSync(resolve(ROOT, SOURCE), "utf8"));
profile.syscalls.push(RULE);
const text = JSON.stringify(profile, null, "\t") + "\n";
if (process.argv.includes("--check")) {
  const same = readFileSync(resolve(ROOT, OUT), "utf8") === text;
  console.log(same ? `${OUT} equals ${SOURCE} plus the fcpi rule` : `${OUT} differs from the build output`);
  process.exitCode = same ? 0 : 1;
} else {
  writeFileSync(resolve(ROOT, OUT), text);
  console.log(`wrote ${OUT}`);
}
