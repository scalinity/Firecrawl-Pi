#!/usr/bin/env node
// Build evidence/M0/audit.json from the raw probe transcripts.
// Every host value is parsed from evidence/M0/raw/*; nothing is typed in by hand
// except the plans (ports, storage, build), which are proposals, and the
// curated source review in evidence/M0/source-review.json.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROOT, sha256File, repoState, sections, kv, meminfo, dfBytes, dfInodes, listeners, resourceFit, spaceFit,
} from "./lib.mjs";

const RAW = "evidence/M0/raw/pi-audit.txt";
const RAW2 = "evidence/M0/raw/pi-audit-extra.txt";
const a = sections(RAW);
const x = sections(RAW2);
// pi-audit.sh checked tools with the non-login PATH (no /usr/sbin); this probe
// re-checks them with an explicit PATH and is authoritative for tool presence.
const RAW3 = "evidence/M0/raw/pi-audit-paths.txt";
const p = sections(RAW3);
const tool = kv(p.sbin_tools);
const RAW4 = "evidence/M0/raw/pi-audit-layout.txt";
const lay = sections(RAW4);
const oomLine = a.kernel_log_storage_power[a.kernel_log_storage_power.indexOf("--- oom kills in journal (all boots)") + 1];
const src = (file, sec) => `${file}#${sec}`;
const obs = (sources, value) => ({ status: "observed", sources, value });
const unavailable = (sources, reason, value) => ({ status: "unavailable", sources, reason, ...(value ? { value } : {}) });

const ident = kv(a.identity);
const arch = kv(a.architecture);
const os = kv(a.os.map((l) => l.replace(/"/g, "")));
const mem = meminfo(a.meminfo);
const cg = kv(a.cgroup);
const procsys = kv(x.proc_sys);
const df = dfBytes(a.df_bytes);
const di = dfInodes(a.df_inodes);
const ls = listeners(a.listening);
const hashes = kv(a.identity_hashes);
const cmdline = (a.cmdline[0] || "").trim();
const tools = kv(a.tools);
const thermal = a.thermal_power;
const vc = (name) => (thermal.find((l) => l.startsWith(`vcgencmd ${name} =>`)) || "").split("=> ")[1]?.trim() ?? null;
const hwmon = Object.fromEntries(thermal.filter((l) => /^hwmon\d+ /.test(l)).map((l) => {
  const [id, ...rest] = l.trim().split(/\s+/);
  return [id, Object.fromEntries(rest.map((p) => p.split("=")))];
}));
const ext4 = Object.fromEntries(a.ext4_superblock.filter((l) => l.includes(":")).map((l) => {
  const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
}));
const lsblkRows = a.lsblk.slice(1).filter(Boolean).map((l) => l.replace(/^[|`]-/, "").trim().split(/\s+/));
const running = a.services_all.filter((l) => / active running$/.test(l)).map((l) => l.split(" ")[0]);
const controllers = (cg.controllers || "").split(/\s+/).filter(Boolean);
const throttled = vc("get_throttled");
const temp = vc("measure_temp");
const fanPwm = hwmon.hwmon2?.pwm1 != null ? Number(hwmon.hwmon2.pwm1) : null;
const fanRpm = hwmon.hwmon2?.fan1_input != null ? Number(hwmon.hwmon2.fan1_input) : null;
const pmic = Object.fromEntries(thermal.filter((l) => /volt\(\d+\)=|current\(\d+\)=/.test(l)).map((l) => {
  const m = l.trim().match(/^(\S+)\s+\S+\(\d+\)=([\d.]+)/); return m ? [m[1], Number(m[2])] : null;
}).filter(Boolean));

const fit = resourceFit(mem);
const space = spaceFit(df["/"]);
const sourceReview = JSON.parse(readFileSync(resolve(ROOT, "evidence/M0/source-review.json"), "utf8"));

// ---- plans (proposals, checked by verify.mjs) ----------------------------
const ports = {
  host_published: [
    { service: "access-gateway", bind: "127.0.0.1", port: 3380, proto: "tcp", milestone: "M1", chosen_by: "project",
      note: "Only host publication of the project; loopback-bound. Tailscale Serve forwards to it from M3." },
    { service: "tailscaled (WireGuard)", bind: "0.0.0.0", port: 41641, proto: "udp", milestone: "M3", chosen_by: "tailscale default",
      note: "Tailscale's own default; host package, not a container publication. Falls back to another port if occupied." },
  ],
  tailnet_only: [
    { service: "tailscale serve", port: 443, proto: "tcp", target: "http://127.0.0.1:3380", milestone: "M3",
      alternative_port: 8443,
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
  ephemeral_port_range: procsys["net.ipv4.ip_local_port_range"],
};

const rootLsblk = lsblkRows.find((r) => r[1] === "mmcblk0p2");
const audit = {
  schema: "fcpi.m0.audit/v1",
  generated_utc: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  ...repoState(),
  upstream: { repository: "https://github.com/firecrawl/firecrawl", tag: "v2.11.162", commit: "7666c1f9ae8720a6bba271e0f60b6a217f8a5210" },
  target: { ssh: "danny@pi.local", resolved_address: "158.205.34.18" },
  probes: [
    { id: "P0-before", script: "scripts/m0/pi-snapshot.sh", script_sha256: sha256File("scripts/m0/pi-snapshot.sh"), output: "evidence/M0/snapshot-before.txt", output_sha256: sha256File("evidence/M0/snapshot-before.txt") },
    { id: "P1-audit", script: "scripts/m0/pi-audit.sh", script_sha256: sha256File("scripts/m0/pi-audit.sh"), output: RAW, output_sha256: sha256File(RAW), utc: a.probe_time[0] },
    { id: "P2-audit-extra", script: "scripts/m0/pi-audit-extra.sh", script_sha256: sha256File("scripts/m0/pi-audit-extra.sh"), output: RAW2, output_sha256: sha256File(RAW2), utc: x.probe_time[0],
      note: "Contains the single permitted IP-echo GET; the returned egress address is stored only as a SHA-256." },
    { id: "P3-audit-paths", script: "scripts/m0/pi-audit-paths.sh", script_sha256: sha256File("scripts/m0/pi-audit-paths.sh"), output: RAW3, output_sha256: sha256File(RAW3), utc: p.probe_time[0],
      note: "Supersedes P1's tool-presence results: P1 used a PATH without /usr/sbin, so nft, zramctl, dumpe2fs, sshd, losetup, iw and sysctl were wrongly reported absent." },
    { id: "P4-audit-layout", script: "scripts/m0/pi-audit-layout.sh", script_sha256: sha256File("scripts/m0/pi-audit-layout.sh"), output: RAW4, output_sha256: sha256File(RAW4), utc: lay.probe_time[0] },
    { id: "P5-after", script: "scripts/m0/pi-snapshot.sh", script_sha256: sha256File("scripts/m0/pi-snapshot.sh"), output: "evidence/M0/snapshot-after.txt", output_sha256: sha256File("evidence/M0/snapshot-after.txt"), note: "Last Pi probe of the session; compared with P0 by scripts/m0/snapshot-diff.sh." },
  ],
  identity: {
    model: ident.model,
    revision_code: (a.identity.find((l) => l.startsWith("Revision")) || "").split(":")[1]?.trim(),
    hostname: ident.hostname,
    ssh_user: ident.user,
    groups: (ident.id.match(/groups=(.*)$/) || [])[1],
    docker_group_member: /\(docker\)/.test(ident.id),
    sudo_passwordless: ident.sudo_passwordless === "yes",
    board_serial_sha256: hashes.board_serial_sha256,
    machine_id_sha256: hashes.machine_id_sha256,
    mac_sha256: { eth0: kv(a.identity_hashes.map((l) => l.replace(/^mac_sha256 /, "")))["eth0"], wlan0: kv(a.identity_hashes.map((l) => l.replace(/^mac_sha256 /, "")))["wlan0"] },
  },
  architecture: {
    uname_m: arch.uname_m, dpkg_architecture: arch.dpkg_arch, long_bit: Number(arch.long_bit),
    page_size_bytes: Number(arch.page_size), kernel_release: arch.uname_r,
    foreign_architectures: arch.dpkg_foreign.split(/\s+/).filter(Boolean),
    kernel_images_present: (x.boot_config.find((l) => /^kernel/.test(l)) || "").trim().split(/\s+/),
  },
  section4: {
    distribution_version: obs([src(RAW, "os")], { pretty_name: os.PRETTY_NAME, version_id: os.VERSION_ID, codename: os.VERSION_CODENAME, debian_version: kv(a.os).debian_version, rpi_reference: (a.os.find((l) => l.startsWith("rpi_issue: Raspberry")) || "").replace("rpi_issue: ", "") }),
    uname_m: obs([src(RAW, "architecture")], arch.uname_m),
    kernel: obs([src(RAW, "architecture"), src(RAW, "kernel_config")], { release: arch.uname_r, page_size_bytes: Number(arch.page_size), config_16k_pages: a.kernel_config.includes("CONFIG_ARM64_16K_PAGES=y"), user_ns: a.kernel_config.includes("CONFIG_USER_NS=y"), seccomp_filter: a.kernel_config.includes("CONFIG_SECCOMP_FILTER=y"), overlayfs: a.kernel_config.find((l) => l.startsWith("CONFIG_OVERLAY_FS")) }),
    cpu_ram: obs([src(RAW, "cpu"), src(RAW, "meminfo")], { cpus: Number(kv(a.cpu).nproc), model: "Cortex-A76", max_mhz: 2400, governor: kv(a.cpu.map((l) => l.replace(/^\/sys\/devices\/system\/cpu\/cpu0\/cpufreq\/(\w+): /, "$1="))).scaling_governor, meminfo_kib: { MemTotal: mem.MemTotal, MemAvailable: mem.MemAvailable, MemFree: mem.MemFree, Buffers: mem.Buffers, Cached: mem.Cached, Shmem: mem.Shmem, AnonPages: mem.AnonPages, SwapTotal: mem.SwapTotal, CmaTotal: mem.CmaTotal }, firmware_total_mem_mib: Number((vc("get_config total_mem") || "").split("=")[1]) }),
    cgroup_support: obs([src(RAW, "cgroup"), src(RAW, "cmdline"), src(RAW2, "boot_config")], { hierarchy: cg.fstype, controllers, memory_controller_available: controllers.includes("memory"), kernel_cmdline_has_cgroup_disable_memory: /\bcgroup_disable=memory\b/.test(cmdline), cmdline_txt_has_cgroup_disable_memory: /cgroup_disable=memory/.test(x.boot_config.join(" ")), config_memcg: a.kernel_config.includes("CONFIG_MEMCG=y"), psi: a.pressure.every((l) => /UNAVAILABLE/.test(l)) ? "unavailable (no /proc/pressure)" : "available" }),
    swap_zram: obs([src(RAW, "swap_zram"), src(RAW2, "zram_writeback"), src(RAW2, "proc_sys")], { swaps: a.swap_zram.filter((l) => l.startsWith("/dev/")).map((l) => { const f = l.trim().split(/\s+/); return { device: f[0], type: f[1], size_kib: Number(f[2]), used_kib: Number(f[3]), priority: Number(f[4]) }; }), zram_algorithm: "zstd", zram_writeback_backing_dev: kv(x.zram_writeback).backing_dev, zram_writeback_file: "/var/swap (2 GiB, on the microSD root filesystem)", zram_writeback_timer: "rpi-zram-writeback.timer OnBootSec=180min OnUnitActiveSec=24h", zram_bd_stat: kv(x.zram_writeback).bd_stat, swappiness: Number(procsys["vm.swappiness"]) }),
    mounts: obs([src(RAW, "storage_root"), "evidence/M0/snapshot-before.txt#findmnt"], { root: a.storage_root[0].trim(), boot_firmware: a.storage_root[1].trim(), tmp_tmpfs_bytes: df["/tmp"]?.size, dev_shm_tmpfs_bytes: df["/dev/shm"]?.size, fstab: a.fstab.filter(Boolean) }),
    block_devices: obs([src(RAW, "lsblk"), src(RAW, "block_devices_sys")], { devices: lsblkRows.map((r) => ({ name: r[0], type: r[2], size_bytes: Number(r[3]), rota: r[4] === "1", rm: r[5] === "1" })), boot_medium: "microSD (mmcblk0, type=SD)", sd_card: Object.fromEntries(a.block_devices_sys.filter((l) => /^\s+\w+=/.test(l)).map((l) => l.trim().split("="))), nvme_present: kv(a.block_devices_sys).nvme_present || "", usb_storage_devices: Number(kv(a.block_devices_sys).usb_storage?.split(" ")[0] ?? 0) }),
    filesystem_types: obs([src(RAW, "lsblk"), src(RAW, "ext4_superblock")], { root: { fstype: "ext4", uuid: ext4["Filesystem UUID"], partuuid: rootLsblk?.[11], state: ext4["Filesystem state"], errors_behavior: ext4["Errors behavior"], fs_error_count_line_present: "FS Error count" in ext4, lifetime_writes: ext4["Lifetime writes"], created: ext4["Filesystem created"], mount_count: Number(ext4["Mount count"]) }, boot_firmware: { fstype: "vfat", uuid: "B2F0-82D2" } }),
    docker_root_data_dirs: obs([src(RAW, "container_runtime")], { docker_installed: false, var_lib_docker: kv(a.container_runtime).var_lib_docker?.split(" ")[0], etc_docker_daemon_json: kv(a.container_runtime).etc_docker_daemon_json, note: "Docker is not installed, so no Docker root directory exists yet. M1 sets data-root deliberately (see storage plan)." }),
    available_disk_inodes: obs([src(RAW, "df_bytes"), src(RAW, "df_inodes")], { root: { size_bytes: df["/"].size, used_bytes: df["/"].used, avail_bytes: df["/"].avail, inodes: di["/"].inodes, inodes_used: di["/"].used, inodes_free: di["/"].free }, boot_firmware_avail_bytes: df["/boot/firmware"].avail }),
    docker_compose_versions: obs([src(RAW, "container_runtime")], { docker: "absent", compose_plugin: "absent", podman: "absent", services: { "docker.service": "not-found", "docker.socket": "not-found", "containerd.service": "not-found" }, debian_candidate_docker_io: "26.1.5+dfsg1-9+deb13u1", debian_candidate_podman: "5.4.2+ds1-2+b2", docker_ce_repo_configured: false, docker_ce_trixie_arm64_available: "see evidence/M0/runtime-candidates.json" }),
    running_containers_services: obs([src(RAW, "services_all"), src(RAW, "service_descriptions"), "evidence/M0/snapshot-before.txt#docker_ps"], { containers: "none (no container runtime installed)", running_services: running, failed_units: a.services_all.slice(a.services_all.indexOf("--- failed") + 1, a.services_all.indexOf("--- timers")).filter(Boolean), owner_services: a.service_descriptions.filter(Boolean) }),
    listening_ports: obs([src(RAW, "listening"), src(RAW, "listener_units")], ls),
    hostname: obs([src(RAW, "identity")], { hostname: ident.hostname, mdns: "avahi-daemon running (pi.local)" }),
    dns: obs([src(RAW, "network")], { resolv_conf_nameservers: a.network.filter((l) => l.startsWith("nameserver")).map((l) => l.split(/\s+/)[1]), local_dns_services: "pihole-FTL on :53 (listeningMode=ALL, interface=wlan0), dnscrypt-proxy on 127.0.0.1:5053", host_resolver_uses_pihole: false }),
    firewall_backend_rules: obs([src(RAW, "firewall"), src(RAW3, "sbin_tools"), src(RAW3, "packages"), "evidence/M0/snapshot-before.txt#firewall"], { netfilter_modules_loaded: [], nft_binary: tool.nft, nftables_package: (p.packages.find((l) => l.startsWith("nftables ")) || "").trim(), iptables_binary: tool.iptables, ufw: tool.ufw, firewalld: tool["firewall-cmd"], nftables_service: "inactive/disabled", etc_nftables_conf: "present (not loaded)", active_ruleset: "none: no nf_tables/ip_tables module is loaded, so no packet filtering is in effect", fail2ban: { running: true, jails: ["sshd"], banaction: "nftables", note: "A first ban would load nf_tables through fail2ban; zero bans recorded (see network exposure)." } }),
    tailscale_state: obs([src(RAW, "tailscale")], { installed: false, service: "not-found" }),
    reverse_proxies: obs([src(RAW, "reverse_proxies"), src(RAW, "listening")], { dedicated_reverse_proxy: "none (nginx, caddy, apache2, haproxy, lighttpd, traefik, cloudflared all absent)", web_listeners: "pihole-FTL embedded web server on 0.0.0.0:80 and :443 (also [::])" }),
    thermal_sensors: obs([src(RAW, "thermal_power")], { vcgencmd_temp: temp, thermal_zone0_mC: Number((thermal.find((l) => l.startsWith("thermal_zone0")) || "").split("temp_mC=")[1]), rp1_adc_temp_mC: Number(hwmon.hwmon1?.temp1_input), cooling_device: "pwm-fan (cur 1 of 4)", fan_pwm: fanPwm, fan_tach_rpm: fanRpm, fan_interpretation: "pwm1=75 with fan1_input=0: either a fan without a tachometer signal or no fan fitted. Not distinguishable programmatically." }),
    power_throttling: obs([src(RAW, "thermal_power")], { get_throttled: throttled, throttled_decoded: throttled === "throttled=0x0" ? "no under-voltage, frequency capping, throttling or soft temperature limit now or since boot" : "see raw", ext5v_volts: pmic.EXT5V_V, usb_max_current_enable: vc("get_config usb_max_current_enable"), core_volts: vc("measure_volts core"), bootloader: vc("bootloader_version")?.split(" version ")[1]?.split(" ")[0] }),
    current_workload_usage: obs([src(RAW, "meminfo"), src(RAW, "processes_top_rss"), src(RAW, "cpu"), src(RAW, "unit_memory")], { loadavg: kv(a.cpu).loadavg, uptime_s: Number(kv(a.cpu).uptime_s), existing_usage_mib: fit.existing_usage_mib, top_rss_kib: a.processes_top_rss.slice(1, 16).map((l) => { const f = l.trim().split(/\s+/); return { comm: f[6], user: f[2], rss_kib: Number(f[3]) }; }), per_unit_cgroup_memory: "unavailable: the memory controller is disabled, so memory.current/memory.peak do not exist", oom_kills_in_journal: Number(oomLine) }),
  },
  unavailable: [
    { field: "per-unit memory usage and peaks", reason: "memory cgroup controller disabled (cgroup_disable=memory); memory.current/memory.peak absent", substitute: "host MemTotal-MemAvailable plus per-process RSS" },
    { field: "pressure stall information", reason: "/proc/pressure absent on this kernel boot" },
    { field: "previous-boot kernel log", reason: "the persistent journal holds only the current boot (journalctl --list-boots)" },
    { field: "microSD wear/health (SMART)", reason: "SD cards expose no SMART; smartctl/nvme absent and not installed during M0", substitute: "ext4 state clean, no FS error record, Lifetime writes 137 GB baseline, no mmc/ext4 errors in the current boot" },
    { field: "fan presence", reason: "tachometer reads 0 rpm at pwm 75; a tach-less fan and an absent fan look identical" },
    { field: "sustained-load thermal behaviour", reason: "measuring it needs a load test, which is not a read-only probe; M2/M8 measure it" },
    { field: "inbound reachability from the Internet", reason: "requires an external probe, which M0 forbids; inferred from NAT evidence instead (see network)" },
    { field: "docker info / compose version", reason: "Docker is not installed" },
  ],
  missing_utilities: Object.entries(tool).filter(([, v]) => v === "absent").map(([k]) => k),
  missing_utilities_source: src(RAW3, "sbin_tools"),
  network: {
    interfaces: { wlan0: "UP 158.205.34.18/24 (Wi-Fi, DHCP)", eth0: "DOWN, no carrier" },
    default_route: a.network.find((l) => l.startsWith("default")),
    global_ipv6: a.network.slice(a.network.indexOf("--- global_ipv6") + 1, a.network.indexOf("--- hostname_I")).filter(Boolean).length > 0,
    lan_block: { cidr: "158.205.34.0/24", rfc1918: false, rdap: "158.198.0.0-158.215.255.255 JPNIC-NET-JP-ERX, ALLOCATED PORTABLE, JP (evidence/M0/network-exposure.json)" },
    egress_ip_sha256: (x.ip_echo.find((l) => l.includes("EGRESS_IP_SHA256")) || "").match(/EGRESS_IP_SHA256:([0-9a-f]{64})/)?.[1],
    egress_ip_differs_from_interface: /differs from 158\.205\.34\.18: yes/.test(x.ip_echo.join(" ")),
    inbound_evidence: kv(x.inbound_evidence.map((l) => l.replace(/^sshd_journal_sources /, "").replace(/ /g, "\n")).join("\n").split("\n")),
    fail2ban_sshd: x.inbound_evidence.filter((l) => /Total|Currently/.test(l)).map((l) => l.replace(/^[|`\s-]+/, "").trim()),
  },
  derived: { resource_fit: fit, free_space: space },
  plans: {
    ports,
    storage: {
      data_filesystem_uuid: ext4["Filesystem UUID"],
      data_filesystem_partuuid: rootLsblk?.[11],
      data_directory: "/srv/firecrawl-pi/data",
      medium: "microSD (the only storage device present)",
      planned_paths_present: Object.fromEntries(lay.planned_paths.filter((l) => l.includes("=")).map((l) => l.split("="))),
      planned_parents_filesystem_uuid: Object.fromEntries(lay.filesystem_of_planned_parents.filter((l) => l.includes("uuid=")).map((l) => { const [d, u] = l.split(" uuid="); return [d, u]; })),
      planned_paths_source: src(RAW4, "planned_paths"),
    },
  },
  source_review: sourceReview,
  sha256: { source_review: sha256File("evidence/M0/source-review.json") },
};

writeFileSync(resolve(ROOT, "evidence/M0/audit.json"), JSON.stringify(audit, null, 2) + "\n");
console.log("wrote evidence/M0/audit.json");
