// D2's first M2 step, run by scripts/m2/pi-browser-proof.sh inside a throwaway container of the
// pinned Playwright image: no network, read-only root, uid 3320, no capabilities. Node built-ins
// plus the playwright-core release mounted at /pw.
//   node browser-proof.mjs control   launch with the sandbox on; expected to fail under Docker's
//                                    builtin seccomp profile (the positive control for the profile)
//   node browser-proof.mjs proof     launch with the sandbox on, render the JS fixture served on
//                                    loopback, record each process's namespaces and seccomp
//                                    filters, close, and record the process table afterwards
// Prints "### section" blocks.
import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";

const mode = process.argv[2];
const { chromium } = (await import("/pw/package/index.js")).default;
const out = (sec, lines) => console.log(`### ${sec}\n${[].concat(lines).join("\n")}`);

// Every process visible in the container's PID namespace. /proc/<pid>/status stays readable for
// Chromium's non-dumpable sandboxed children, whose /proc/<pid>/ns links do not.
function processes() {
  return readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map((pid) => {
    try {
      const st = readFileSync(`/proc/${pid}/status`, "utf8");
      const g = (k) => (st.match(new RegExp(`^${k}:\\s*(.*)$`, "m")) ?? [])[1] ?? "";
      // Chromium rewrites its argv into one space-joined string, so flags are matched in the
      // whole command line, not per argument.
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      const exe = (cmd.split(" ")[0] ?? "").split("/").pop();
      const type = (cmd.match(/ --type=(\S+)/) ?? [])[1] ?? (/^chrome/.test(exe) ? "browser" : "");
      // CapEff is relative to the process's own user namespace: a sandbox zygote holds
      // CAP_SYS_ADMIN only inside the namespace it created, never on the host.
      return JSON.stringify({
        pid: Number(pid), exe, type, uid: g("Uid").split(/\s+/)[0],
        nspid_depth: g("NSpid").split(/\s+/).filter(Boolean).length, seccomp: g("Seccomp"), seccomp_filters: Number(g("Seccomp_filters")),
        no_new_privs: g("NoNewPrivs"), cap_eff: g("CapEff"), no_sandbox_flag: / --no-sandbox( |$)/.test(cmd), disable_setuid_sandbox: / --disable-setuid-sandbox( |$)/.test(cmd),
      });
    } catch (e) { return JSON.stringify({ pid: Number(pid), error: e.code }); }
  });
}

const fixture = createServer((req, res) => {
  try {
    const body = readFileSync(`/fixture/${new URL(req.url, "http://x").pathname.replace(/[^a-z0-9.-]/g, "")}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => fixture.listen(8099, "127.0.0.1", r));

out("meta", [`utc=${new Date().toISOString()}`, `mode=${mode}`, `node=${process.version}`, `uid=${process.getuid()} gid=${process.getgid()}`,
  `playwright_core=${JSON.parse(readFileSync("/pw/package/package.json", "utf8")).version}`, `executable=${chromium.executablePath()}`]);

let browser;
try {
  const t0 = Date.now();
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 30000 });
  out("launch", [`launched=yes ms=${Date.now() - t0}`, `browser_version=${browser.version()}`]);
} catch (e) {
  out("launch", [`launched=no`, `error=${JSON.stringify(String(e.message).split("\n").filter((l) => /sandbox|Check failed|FATAL|closed/i.test(l)).slice(0, 6))}`]);
  out("end", "end");
  fixture.close();
  process.exit(0);
}

const page = await browser.newPage();
const t1 = Date.now();
await page.goto("http://127.0.0.1:8099/js.html", { waitUntil: "load", timeout: 20000 });
const sentinel = await page.textContent("strong", { timeout: 10000 });
out("render", [`url=http://127.0.0.1:8099/js.html`, `ms=${Date.now() - t1}`, `h1=${await page.textContent("h1")}`, `sentinel=${sentinel}`,
  `noscript_rendered=${(await page.content()).includes("This page needs JavaScript")}`]);
out("processes_open", processes());
const tc = Date.now();
await browser.close();
// Give the kernel a moment to reap the tree before looking again.
await new Promise((r) => setTimeout(r, 1500));
out("close", [`closed=yes ms=${Date.now() - tc}`]);
out("processes_after_close", processes());
fixture.close();
out("end", "end");
