#!/usr/bin/env node
// Build evidence/M0/audit.json from the raw probe transcripts.
//
// Every value under `section4`, `identity`, `architecture` and `network` is
// parsed from a raw transcript cited in its `sources`. Numbers go through num(),
// which throws on anything unparseable, so a missing raw line stops the build
// instead of becoming a null "observation". Only three kinds of input are not
// raw probe output: the plans (proposals), the curated source review
// (evidence/M0/source-review.json) and the RDAP registry lookup
// (evidence/M0/network-exposure.json); each is cited where used.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ROOT, sha256, sha256File, repoState, sections, kv, meminfo, dfBytes, dfInodes, listeners, resourceFit, spaceFit,
} from "./lib.mjs";

const RAW = "evidence/M0/raw/pi-audit.txt";              // P1
const RAW2 = "evidence/M0/raw/pi-audit-extra.txt";       // P2
const RAW_ECHO = "evidence/M0/raw/pi-audit-extra-ipecho.txt";
const RAW3 = "evidence/M0/raw/pi-audit-paths.txt";       // P3
const RAW4 = "evidence/M0/raw/pi-audit-layout.txt";      // P4
const RAW6 = "evidence/M0/raw/pi-audit-kernel-log.txt";  // P6
const a = sections(RAW), x = sections(RAW2), p = sections(RAW3), lay = sections(RAW4);
const echo = sections(RAW_ECHO).ip_echo.join(" ");
const src = (file, sec) => `${file}#${sec}`;
const obs = (sources, value) => ({ status: "observed", sources, value });

function num(v, what) {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (v == null || String(v).trim() === "" || !Number.isFinite(n)) throw new Error(`unparseable number for ${what}: ${JSON.stringify(v)}`);
  return n;
}
function must(v, what) {
  if (v == null || v === "") throw new Error(`missing raw value for ${what}`);
  return v;
}
const after = (lines, marker) => { const i = lines.indexOf(marker); if (i < 0) throw new Error(`marker '${marker}' not found`); return lines[i + 1]; };
const between = (lines, from, to) => {
  const i = lines.indexOf(from), j = to ? lines.indexOf(to) : lines.length;
  if (i < 0 || j < 0) throw new Error(`markers ${from}/${to} not found`);
  return lines.slice(i + 1, j).filter(Boolean);
};
const colon = (lines, key) => { const re = new RegExp(`^${key.replace(/[()]/g, "\\$&")}\\s*:`); const l = lines.find((s) => re.test(s)); return must(l, key).replace(re, "").trim(); };
const pairs = (line) => Object.fromEntries([...line.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

// Provenance: the script version that produced each transcript.
function scriptAt(path, rev) {
  const body = execFileSync("git", ["-C", ROOT, "show", `${rev}:${path}`]);
  return { script: path, script_commit: execFileSync("git", ["-C", ROOT, "rev-parse", "--short", rev], { encoding: "utf8" }).trim(), script_sha256: sha256(body) };
}
function scriptHead(path) {
  // Label with the last commit that changed the script; the sha256 is the identity.
  const last = execFileSync("git", ["-C", ROOT, "log", "-1", "--format=%H", "--", path], { encoding: "utf8" }).trim();
  const s = scriptAt(path, last);
  if (s.script_sha256 !== sha256File(path)) throw new Error(`${path} differs from HEAD; commit it before building so provenance names the version that ran`);
  return s;
}
const out = (path) => ({ output: path, output_sha256: sha256File(path) });

// ---- parsed values -----------------------------------------------------------
const ident = kv(a.identity), arch = kv(a.architecture), hashes = kv(a.identity_hashes);
const macs = kv(a.identity_hashes.filter((l) => l.startsWith("mac_sha256 ")).map((l) => l.replace(/^mac_sha256 /, "")));
const os = kv(a.os.map((l) => l.replace(/"/g, "")));
const mem = meminfo(a.meminfo);
const cg = kv(a.cgroup);
const procsys = kv(x.proc_sys);
const df = dfBytes(a.df_bytes), di = dfInodes(a.df_inodes);
const ls = listeners(a.listening);
const cmdline = must(a.cmdline[0], "cmdline").trim();
const tool = kv(p.sbin_tools);
const cpu = kv(a.cpu.map((l) => l.replace(/^\/sys\/devices\/system\/cpu\/cpu0\/cpufreq\/(\w+): /, "$1=")));
const thermal = a.thermal_power;
const vc = (name) => must((thermal.find((l) => l.startsWith(`vcgencmd ${name} =>`)) || "").split("=> ")[1]?.trim(), `vcgencmd ${name}`);
const hwmonByName = Object.fromEntries(thermal.filter((l) => /^hwmon\d+ /.test(l)).map((l) => {
  const f = Object.fromEntries(l.trim().split(/\s+/).slice(1).map((q) => q.split("=")));
  return [f.name, f];
}));
const cooling = Object.fromEntries(must(thermal.find((l) => l.startsWith("cooling_device0 ")), "cooling_device0").trim().split(/\s+/).slice(1).map((q) => q.split("=")));
const pmic = Object.fromEntries(thermal.map((l) => l.trim().match(/^(\S+)\s+(?:volt|current)\(\d+\)=([\d.]+)/)).filter(Boolean).map((m) => [m[1], Number(m[2])]));
const ext4 = Object.fromEntries(a.ext4_superblock.filter((l) => l.includes(":")).map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const blk = a.lsblk.filter((l) => l.startsWith("NAME=")).map(pairs);
const blkOf = (name) => must(blk.find((b) => b.NAME === name), `lsblk ${name}`);
const [rootMnt, bootMnt] = a.storage_root.map((l) => l.trim().split(/\s+/));
const rootDev = rootMnt[1].replace("/dev/", "");
const rootBlk = blkOf(rootDev), bootBlk = blkOf(bootMnt[1].replace("/dev/", ""));
if (rootBlk.UUID !== rootMnt[4] || rootBlk.PARTUUID !== rootMnt[5]) throw new Error("root UUID/PARTUUID disagree between findmnt and lsblk");
const diskName = rootDev.replace(/p\d+$/, "");
// block_devices_sys: "<disk> size_512=..." followed by indented key=value lines for that disk.
const diskIdx = a.block_devices_sys.findIndex((l) => l.startsWith(diskName + " "));
if (diskIdx < 0) throw new Error(`block_devices_sys has no ${diskName}`);
const sdSys = {};
for (const l of a.block_devices_sys.slice(diskIdx + 1)) { if (!/^\s+\w+=/.test(l)) break; const [k, v] = l.trim().split("="); sdSys[k] = v; }
const running = a.services_all.filter((l) => / active running$/.test(l)).map((l) => l.split(" ")[0]);
const controllers = must(cg.controllers, "controllers").split(/\s+/).filter(Boolean);
const rt = kv(a.container_runtime.filter((l) => /^\w+=/.test(l) && !l.includes(" ")));
const rtAll = kv(a.container_runtime.flatMap((l) => (/^[\w]+=/.test(l) ? l.split(" ") : [])));
const candidate = (pkg) => { const i = a.container_runtime.indexOf(`${pkg}:`); return i < 0 ? null : a.container_runtime[i + 2].replace(/^\s*Candidate:\s*/, ""); };
const fw = a.firewall;
const fwMods = fw.slice(0, fw.findIndex((l) => l.includes("="))).filter((l) => l !== "no netfilter table modules loaded");
const svc = (lines, unit) => { const m = lines.find((l) => l.startsWith(unit + " ")); return m ? kv(m.split(" ").slice(1)) : null; };
const kernelImagesLine = must(after(x.boot_config, "--- kernel images present"), "kernel images").trim();
const swaps = a.swap_zram.filter((l) => /^\S+\s+(partition|file)\s/.test(l)).map((l) => { const f = l.trim().split(/\s+/); return { device: f[0], type: f[1], size_kib: num(f[2], "swap size"), used_kib: num(f[3], "swap used"), priority: num(f[4], "swap prio") }; });
const zramRow = must(p.zramctl.find((l) => l.startsWith("/dev/zram")), "zramctl row").trim().split(/\s+/);
const loopRow = must(p.losetup.find((l) => l.startsWith("/dev/loop")), "losetup row").trim().split(/\s+/);
const zwb = kv(x.zram_writeback);
const route = must(a.network.find((l) => / proto kernel scope link /.test(l)), "link route");
const cidr = route.split(" ")[0];
const ipToInt = (s) => s.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const inCidr = (ip, c) => { const [b, m] = c.split("/"); const size = 2 ** (32 - Number(m)); return Math.floor(ipToInt(ip) / size) === Math.floor(ipToInt(b) / size); };
const rfc1918 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].some((c) => inCidr(cidr.split("/")[0], c));
const brAddr = Object.fromEntries(between(a.network, "---", "--- routes").map((l) => { const f = l.trim().split(/\s+/); return [f[0], { state: f[1], addresses: f.slice(2) }]; }));
const nameservers = a.network.filter((l) => l.startsWith("nameserver")).map((l) => l.split(/\s+/)[1]);
const exposure = a.existing_service_exposure.map((l) => l.trim());
const inbound = kv(x.inbound_evidence.flatMap((l) => l.replace(/^sshd_journal_sources /, "").split(" ")));
const logBlock = a.kernel_log_storage_power;
const throttled = vc("get_throttled");
const throttledBits = num(parseInt(throttled.split("=")[1], 16), "get_throttled");
const fan = must(hwmonByName.pwmfan, "hwmon name=pwmfan");
const fanPwm = num(fan.pwm1, "pwm1"), fanRpm = num(fan.fan1_input, "fan1_input");
const layPaths = Object.fromEntries(lay.planned_paths.filter((l) => l.includes("=")).map((l) => l.split("=")));
const layFs = Object.fromEntries(lay.filesystem_of_planned_parents.filter((l) => l.includes(" uuid=")).map((l) => l.split(" uuid=")));
const rdap = must(JSON.parse(readFileSync(resolve(ROOT, "evidence/M0/network-exposure.json"), "utf8")).evidence.find((e) => /RDAP/.test(e.fact)), "rdap fact");
const snapUtc = (f) => must(sections(f).meta[0], `${f} meta`);
const wlanAddr = must(brAddr.wlan0?.addresses?.find((q) => /^\d+\.\d+\.\d+\.\d+\//.test(q)), "wlan0 IPv4");

const fit = resourceFit(mem);
const space = spaceFit(df["/"]);
const sourceReview = JSON.parse(readFileSync(resolve(ROOT, "evidence/M0/source-review.json"), "utf8"));

// ---- plans (proposals, checked by verify.mjs) -----------------------------
const ports = {
  host_published: [
    { service: "access-gateway", bind: "127.0.0.1", port: 3380, proto: "tcp", milestone: "M1", chosen_by: "project",
      note: "Only host publication of the project; loopback-bound. Tailscale Serve forwards to it from M3." },
    { service: "tailscaled (WireGuard)", bind: "0.0.0.0", port: 41641, proto: "udp", milestone: "M3", chosen_by: "tailscale default",
      note: "Tailscale's own default; host package, not a container publication. Falls back to another port if occupied." },
  ],
  tailnet_only: [
    { service: "tailscale serve", port: 443, proto: "tcp", target: "http://127.0.0.1:3380", milestone: "M3", alternative_port: 8443,
      note: "pihole-FTL listens on 0.0.0.0:443 and [::]:443. Whether Serve on the tailnet address coexists with that wildcard listener is verified in M3; 8443 is the fallback, which changes no existing service." },
  ],
  container_internal_not_published: [
    { service: "firecrawl-core api", port: 3002 }, { service: "firecrawl-core nuq workers", port: 3006, note: "3006+i per NuQ worker, inside the container" },
    { service: "nuq-postgres", port: 5432 }, { service: "redis", port: 6379 }, { service: "rabbitmq", port: 5672 },
    { service: "searxng", port: 8080 }, { service: "browser-worker", port: 3000 }, { service: "retrieval-service", port: 3100 },
    { service: "mcp-gateway", port: 3200 }, { service: "access-gateway (container side)", port: 3300 },
  ],
  docker_networks: [
    { name: "fcpi_access", subnet: "10.231.0.0/24" },
    { name: "fcpi_core", subnet: "10.231.1.0/24", internal: true },
    { name: "fcpi_browser", subnet: "10.231.2.0/24" },
  ],
  ephemeral_port_range: must(procsys["net.ipv4.ip_local_port_range"], "ip_local_port_range"),
};

const audit = {
  schema: "fcpi.m0.audit/v1",
  generated_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  ...repoState(),
  repository_sha_note: "The commit checked out when this file was generated. The commit that stores this file is a later one on main.",
  upstream: { repository: "https://github.com/firecrawl/firecrawl", tag: "v2.11.162", commit: "7666c1f9ae8720a6bba271e0f60b6a217f8a5210" },
  target: { ssh: "danny@pi.local", resolved_address: wlanAddr.split("/")[0] },
  probes: [
    { id: "P0-before", ...scriptHead("scripts/m0/pi-snapshot.sh"), ...out("evidence/M0/snapshot-before.txt"), utc: snapUtc("evidence/M0/snapshot-before.txt"),
      note: "Opens the M0 re-check window after the B1 reboot. Taken a second time, once the first attempt's ss had loaded tcp_diag in the new boot, so the window starts from a settled module list (evidence/M0/b1/reboot-diff.txt)." },
    { id: "P1-audit", ...scriptHead("scripts/m0/pi-audit.sh"), ...out(RAW), utc: a.probe_time[0],
      note: "Re-run in the M0 re-check after the B1 reboot. Superseded runs are in git: the first at tag m0-first-run, the post-review run at commit 6018582." },
    { id: "P2-audit-extra", ...scriptHead("scripts/m0/pi-audit-extra.sh"), ...out(RAW2), utc: x.probe_time[0],
      note: "Re-run in the M0 re-check with FCPI_SKIP_IP_ECHO=1; no IP-echo request was sent." },
    { id: "P2e-ip-echo", ...scriptAt("scripts/m0/pi-audit-extra.sh", "m0-first-run"), ...out(RAW_ECHO), utc: must(kv(sections(RAW_ECHO).provenance).capture_utc, "echo capture"),
      note: "The single permitted IP-echo GET. That script version printed the raw answer; the line was replaced with its SHA-256 on the workstation before any commit (post-capture redaction, stated in the file)." },
    { id: "P3-audit-paths", ...scriptHead("scripts/m0/pi-audit-paths.sh"), ...out(RAW3), utc: p.probe_time[0],
      note: "Tool presence with an explicit PATH; P1 now sets PATH itself, so P3 and P1 agree." },
    { id: "P4-audit-layout", ...scriptHead("scripts/m0/pi-audit-layout.sh"), ...out(RAW4), utc: lay.probe_time[0] },
    { id: "P6-kernel-log", ...scriptHead("scripts/m0/pi-audit-kernel-log.sh"), ...out(RAW6), utc: sections(RAW6).probe_time[0],
      note: "Retained kernel log; attributes the re-check's only kernel-log line (the /proc/cgroups notice, printed once per boot at P1's first read of that file)." },
    { id: "P5-after", ...scriptHead("scripts/m0/pi-snapshot.sh"), ...out("evidence/M0/snapshot-after.txt"), utc: snapUtc("evidence/M0/snapshot-after.txt"),
      note: "Last Pi probe of the session; compared with P0 by scripts/m0/snapshot-diff.sh." },
  ],
  identity: {
    model: must(ident.model, "model"),
    revision_code: colon(a.identity, "Revision"),
    hostname: must(ident.hostname, "hostname"),
    ssh_user: must(ident.user, "user"),
    groups: must((ident.id.match(/groups=(.*)$/) || [])[1], "groups"),
    docker_group_member: /\(docker\)/.test(ident.id),
    sudo_passwordless: ident.sudo_passwordless === "yes",
    board_serial_sha256: must(hashes.board_serial_sha256, "serial hash"),
    machine_id_sha256: must(hashes.machine_id_sha256, "machine-id hash"),
    mac_sha256: macs,
  },
  architecture: {
    uname_m: must(arch.uname_m, "uname_m"), dpkg_architecture: must(arch.dpkg_arch, "dpkg_arch"), long_bit: num(arch.long_bit, "long_bit"),
    page_size_bytes: num(arch.page_size, "page_size"), kernel_release: must(arch.uname_r, "uname_r"),
    foreign_architectures: (arch.dpkg_foreign || "").split(/\s+/).filter(Boolean),
    kernel_images_present: kernelImagesLine.split(/\s+/).filter(Boolean),
    binfmt_entries: must(arch.binfmt_entries, "binfmt_entries"),
  },
  section4: {
    distribution_version: obs([src(RAW, "os")], { pretty_name: must(os.PRETTY_NAME, "PRETTY_NAME"), version_id: os.VERSION_ID, codename: os.VERSION_CODENAME, debian_version: kv(a.os).debian_version, rpi_reference: must(a.os.find((l) => l.startsWith("rpi_issue: Raspberry")), "rpi_issue").replace("rpi_issue: ", "") }),
    uname_m: obs([src(RAW, "architecture")], arch.uname_m),
    kernel: obs([src(RAW, "architecture"), src(RAW, "kernel_config"), src(RAW2, "boot_config")], { release: arch.uname_r, page_size_bytes: num(arch.page_size, "page"), config_16k_pages: a.kernel_config.includes("CONFIG_ARM64_16K_PAGES=y"), user_ns: a.kernel_config.includes("CONFIG_USER_NS=y"), seccomp_filter: a.kernel_config.includes("CONFIG_SECCOMP_FILTER=y"), overlayfs: must(a.kernel_config.find((l) => l.startsWith("CONFIG_OVERLAY_FS")), "overlayfs"), kernel_images_present: kernelImagesLine.split(/\s+/).filter(Boolean) }),
    cpu_ram: obs([src(RAW, "cpu"), src(RAW, "meminfo"), src(RAW, "thermal_power")], { cpus: num(cpu.nproc, "nproc"), model: colon(a.cpu, "Model name"), max_mhz: num(colon(a.cpu, "CPU max MHz"), "max MHz"), governor: must(cpu.scaling_governor, "governor"), meminfo_kib: { MemTotal: mem.MemTotal, MemAvailable: mem.MemAvailable, MemFree: mem.MemFree, Buffers: mem.Buffers, Cached: mem.Cached, Shmem: mem.Shmem, AnonPages: mem.AnonPages, SwapTotal: mem.SwapTotal, CmaTotal: mem.CmaTotal }, firmware_total_mem_mib: num(vc("get_config total_mem").split("=")[1], "total_mem") }),
    cgroup_support: obs([src(RAW, "cgroup"), src(RAW, "cmdline"), src(RAW2, "boot_config"), src(RAW, "pressure")], { hierarchy: cg.fstype, controllers, memory_controller_available: controllers.includes("memory"), kernel_cmdline_has_cgroup_disable_memory: /\bcgroup_disable=memory\b/.test(cmdline), kernel_cmdline_cgroup_enable_memory_after_disable: cmdline.lastIndexOf("cgroup_enable=memory") > cmdline.lastIndexOf("cgroup_disable=memory"), cmdline_txt_has_cgroup_disable_memory: /cgroup_disable=memory/.test(x.boot_config.join(" ")), config_memcg: a.kernel_config.includes("CONFIG_MEMCG=y"), psi_available: !a.pressure.every((l) => /UNAVAILABLE/.test(l)) }),
    swap_zram: obs([src(RAW, "swap_zram"), src(RAW3, "zramctl"), src(RAW3, "losetup"), src(RAW2, "zram_writeback"), src(RAW2, "proc_sys")], { swaps, zram_algorithm: zramRow[1], zram_disksize: zramRow[2], zram_writeback_backing_dev: must(zwb.backing_dev, "backing_dev"), zram_writeback_backing_file: loopRow[1], zram_writeback_bd_stat: must(zwb.bd_stat, "bd_stat").trim().split(/\s+/).map((n) => num(n, "bd_stat")), zram_writeback_timer: { OnBootSec: must(zwb.OnBootSec, "OnBootSec"), OnUnitActiveSec: must(zwb.OnUnitActiveSec, "OnUnitActiveSec") }, swappiness: num(procsys["vm.swappiness"], "swappiness") }),
    mounts: obs([src(RAW, "storage_root"), src(RAW, "fstab"), "evidence/M0/snapshot-before.txt#findmnt"], { root: { target: rootMnt[0], source: rootMnt[1], fstype: rootMnt[2], options: rootMnt[3] }, boot_firmware: { target: bootMnt[0], source: bootMnt[1], fstype: bootMnt[2] }, tmp_tmpfs_bytes: num(df["/tmp"]?.size, "/tmp"), dev_shm_tmpfs_bytes: num(df["/dev/shm"]?.size, "/dev/shm"), fstab: a.fstab.filter(Boolean) }),
    block_devices: obs([src(RAW, "lsblk"), src(RAW, "block_devices_sys")], { devices: blk.map((b) => ({ name: b.NAME, type: b.TYPE, size_bytes: num(b.SIZE, `size ${b.NAME}`), rota: b.ROTA === "1", rm: b.RM === "1", tran: b.TRAN || null, fstype: b.FSTYPE || null })), boot_medium: sdSys.type === "SD" ? `microSD (${diskName}, type=SD)` : must(null, "SD type for boot medium"), sd_card: sdSys, nvme_present: (kv(a.block_devices_sys).nvme_present || "").trim() !== "", usb_storage_devices: num(kv(a.block_devices_sys).usb_storage?.split(" ")[0], "usb_storage") }),
    filesystem_types: obs([src(RAW, "lsblk"), src(RAW, "ext4_superblock")], { root: { fstype: rootBlk.FSTYPE, uuid: rootBlk.UUID, partuuid: rootBlk.PARTUUID, label: rootBlk.LABEL, state: must(ext4["Filesystem state"], "fs state"), errors_behavior: ext4["Errors behavior"], fs_error_count_recorded: "FS Error count" in ext4, lifetime_writes: must(ext4["Lifetime writes"], "lifetime writes"), created: ext4["Filesystem created"], mount_count: num(ext4["Mount count"], "mount count") }, boot_firmware: { fstype: bootBlk.FSTYPE, uuid: bootBlk.UUID, partuuid: bootBlk.PARTUUID } }),
    docker_root_data_dirs: obs([src(RAW, "container_runtime"), src(RAW4, "planned_paths")], { docker_installed: rt.docker !== "absent", var_lib_docker: must(layPaths["/var/lib/docker"], "/var/lib/docker"), etc_docker_daemon_json: must(rtAll.etc_docker_daemon_json, "daemon.json") }),
    available_disk_inodes: obs([src(RAW, "df_bytes"), src(RAW, "df_inodes")], { root: { size_bytes: df["/"].size, used_bytes: df["/"].used, avail_bytes: df["/"].avail, inodes: di["/"].inodes, inodes_used: di["/"].used, inodes_free: di["/"].free }, boot_firmware_avail_bytes: df["/boot/firmware"].avail }),
    docker_compose_versions: obs([src(RAW, "container_runtime")], { docker: must(rt.docker, "docker"), compose_plugin: rtAll.compose_plugin || "absent", podman: must(rt.podman, "podman"), services: Object.fromEntries(["docker.service", "docker.socket", "containerd.service"].map((u) => [u, svc(a.container_runtime, u)])), apt_candidates: { "docker.io": candidate("docker.io"), "docker-ce": candidate("docker-ce"), podman: candidate("podman") }, docker_ce_repository: "evidence/M0/runtime-candidates.json" }),
    running_containers_services: obs([src(RAW, "services_all"), src(RAW, "service_descriptions"), "evidence/M0/snapshot-before.txt#docker_ps"], { containers: rt.docker === "absent" ? "none: no container runtime installed" : must(null, "containers"), running_services: running, failed_units: between(a.services_all, "--- failed", "--- timers"), owner_services: a.service_descriptions.filter(Boolean) }),
    listening_ports: obs([src(RAW, "listening"), src(RAW, "listener_units")], ls),
    hostname: obs([src(RAW, "identity"), src(RAW, "services_all")], { hostname: ident.hostname, avahi_daemon_running: running.includes("avahi-daemon.service") }),
    dns: obs([src(RAW, "network"), src(RAW, "listening"), src(RAW, "existing_service_exposure")], { resolv_conf_nameservers: nameservers, port53_listeners: [...new Set(ls.filter((l) => l.port === 53).map((l) => `${l.proto} ${l.address} ${l.process}`))], pihole_config: exposure.filter((l) => /^(interface|listeningMode)/.test(l)), local_resolver_listeners: [...new Set(ls.filter((l) => l.port === 5053).map((l) => `${l.proto} ${l.address} ${l.process}`))], host_resolver_uses_local_dns: nameservers.some((n) => n === "127.0.0.1" || wlanAddr.startsWith(n + "/")) }),
    firewall_backend_rules: obs([src(RAW, "firewall"), src(RAW3, "packages"), "evidence/M0/snapshot-before.txt#firewall"], { netfilter_modules_loaded: fwMods, nft_binary: tool.nft, nftables_package: must(p.packages.find((l) => l.startsWith("nftables ")), "nftables pkg").trim(), iptables_binary: tool.iptables, ufw: tool.ufw, firewalld: tool["firewall-cmd"], nftables_service: svc(fw, "nftables.service"), etc_nftables_conf: must(kv(fw).etc_nftables_conf, "etc_nftables_conf"), active_ruleset: fwMods.length === 0 ? "none: no nf_tables or ip_tables module is loaded" : "see snapshot firewall hash", fail2ban: { banaction: must(between(fw, "--- fail2ban action config", null).find((l) => /^banaction\s*=/.test(l)), "banaction").split("=")[1].trim(), jails: must(fw.find((l) => /Jail list:/.test(l)), "jails").split(":")[1].trim().split(/,\s*/) } }),
    tailscale_state: obs([src(RAW, "tailscale")], { binaries: kv(a.tailscale[0].split(" ")), service: svc(a.tailscale, "tailscaled.service") }),
    reverse_proxies: obs([src(RAW, "reverse_proxies"), src(RAW, "listening")], { binaries: kv(a.reverse_proxies.filter((l) => /^\w+=/.test(l))), web_listeners: [...new Set(ls.filter((l) => l.port === 80 || l.port === 443).map((l) => `${l.address}:${l.port} ${l.process}`))] }),
    thermal_sensors: obs([src(RAW, "thermal_power")], { vcgencmd_temp: vc("measure_temp"), thermal_zone0_mC: num(must(thermal.find((l) => l.startsWith("thermal_zone0")), "zone0").split("temp_mC=")[1], "zone0"), rp1_adc_temp_mC: num(must(hwmonByName.rp1_adc, "rp1_adc").temp1_input, "rp1_adc"), cooling_device: { type: cooling.type, cur_state: num(cooling.cur, "cur"), max_state: num(cooling.max, "max") }, fan_pwm: fanPwm, fan_tach_rpm: fanRpm, fan_interpretation: fanPwm > 0 && fanRpm === 0 ? "fan commanded (pwm>0) with 0 rpm: a fan without a tachometer and an absent fan look identical" : fanPwm === 0 ? "fan not commanded at this temperature; presence cannot be read from this sample" : "fan spinning" }),
    power_throttling: obs([src(RAW, "thermal_power")], { get_throttled: throttled, throttled_bits: throttledBits, throttled_decoded: throttledBits === 0 ? "no under-voltage, frequency capping, throttling or soft temperature limit, now or since boot" : "non-zero: see raw", ext5v_volts: num(pmic.EXT5V_V, "EXT5V_V"), usb_max_current_enable: vc("get_config usb_max_current_enable"), core_volts: vc("measure_volts core"), bootloader: must(vc("bootloader_version").split(" version ")[1]?.split(" ")[0], "bootloader") }),
    current_workload_usage: obs([src(RAW, "meminfo"), src(RAW, "processes_top_rss"), src(RAW, "cpu"), src(RAW, "unit_memory"), src(RAW, "kernel_log_storage_power")], { loadavg: must(cpu.loadavg, "loadavg"), uptime_s: num(cpu.uptime_s, "uptime"), existing_usage_mib: fit.existing_usage_mib, top_rss_kib: a.processes_top_rss.slice(1, 16).map((l) => { const f = l.trim().split(/\s+/); return { comm: f[6], user: f[2], rss_kib: num(f[3], "rss") }; }), per_unit_cgroup_memory_available: !a.unit_memory.every((l) => /current=NA/.test(l)), oom_kills_in_retained_journal: num(after(logBlock, "--- oom kills in journal (all boots)"), "oom"), journal_window: { boots_recorded: num(kv(logBlock).boots_recorded, "boots"), first_entry_utc: must(kv(logBlock).journal_first_entry_utc, "journal first").replace(/\+00:0$/, "Z"), first_entry_note: "the probe cut the timestamp one character short (+00:0); the offset is UTC", note: "The persistent journal is size-limited: it retains roughly the last two hours, not the whole boot." } }),
  },
  unavailable: [
    ...(a.unit_memory.every((l) => /current=NA/.test(l)) ? [{ field: "per-unit memory usage and peaks", reason: "memory cgroup controller disabled (cgroup_disable=memory); memory.current/memory.peak absent", substitute: "host MemTotal-MemAvailable plus per-process RSS" }] : []),
    { field: "pressure stall information", reason: "/proc/pressure absent on this kernel boot" },
    { field: "kernel and service logs older than the retained journal window", reason: "the persistent journal is size-limited and holds about two hours; the kernel ring buffer holds boot messages only" },
    { field: "microSD wear/health (SMART)", reason: "SD cards expose no SMART; smartctl/nvme absent and not installed during M0", substitute: "ext4 state clean, no FS error record, Lifetime writes baseline, no mmc/ext4 errors in the retained kernel log" },
    { field: "fan presence (by probe)", reason: "a tachometer reading of 0 rpm is identical for a tach-less fan and an absent fan (first P1 run: pwm 75, 0 rpm; see git tag m0-first-run)", substitute: "the owner states a fan is fitted (register B2, 2026-09-25); thermal checks use temperature and get_throttled, not rpm" },
    { field: "sustained-load thermal behaviour", reason: "measuring it needs a load test, which is not a read-only probe; M2/M8 measure it" },
    { field: "inbound reachability from the Internet", reason: "requires an external probe, which M0 forbids; inferred from NAT evidence instead (see network)" },
    { field: "docker info / compose version", reason: "Docker is not installed" },
  ],
  missing_utilities: Object.entries(tool).filter(([, v]) => v === "absent").map(([k]) => k),
  missing_utilities_source: src(RAW3, "sbin_tools"),
  network: {
    interfaces: brAddr,
    default_route: must(a.network.find((l) => l.startsWith("default")), "default route").trim(),
    link_route: route.trim(),
    global_ipv6: between(a.network, "--- global_ipv6", "--- hostname_I").length > 0,
    lan_block: { cidr, rfc1918, rdap: rdap.fact, rdap_source: "evidence/M0/network-exposure.json" },
    egress_ip_sha256: echo.match(/EGRESS_IP_SHA256:([0-9a-f]{64})/)?.[1],
    egress_ip_source: RAW_ECHO + "#ip_echo",
    egress_ip_differs_from_interface: /differs from (interface|[0-9.]+): yes/.test(echo),
    inbound_evidence: { ...inbound, source: src(RAW2, "inbound_evidence") },
    fail2ban_sshd: x.inbound_evidence.filter((l) => /Total|Currently/.test(l)).map((l) => l.replace(/^[|`\s-]+/, "").trim()),
  },
  derived: { resource_fit: fit, free_space: space },
  plans: {
    ports,
    storage: {
      data_filesystem_uuid: rootMnt[4],
      data_filesystem_partuuid: rootMnt[5],
      data_directory: "/srv/firecrawl-pi/data",
      medium: `microSD (${diskName}), the only storage device present`,
      planned_paths_present: layPaths,
      planned_parents_filesystem_uuid: layFs,
      planned_paths_source: src(RAW4, "planned_paths"),
    },
  },
  source_review: sourceReview,
  sha256: { source_review: sha256File("evidence/M0/source-review.json"), network_exposure: sha256File("evidence/M0/network-exposure.json") },
};

writeFileSync(resolve(ROOT, "evidence/M0/audit.json"), JSON.stringify(audit, null, 2) + "\n");
console.log("wrote evidence/M0/audit.json");
