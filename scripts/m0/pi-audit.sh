#!/usr/bin/env bash
# M0 read-only host audit (spec §4). Runs ON the Pi through `ssh ... bash -s`.
# Writes nothing on the Pi: all output goes to stdout and is stored on the Mac.
#
# Never run from here: package installs/updates, systemctl start/restart/enable,
# any docker command (docker.service is checked first), firewall listing that
# could load a netfilter module, fsck/mkfs/parted/hdparm, rpi-eeprom-update
# (it uses mktemp), writes to /boot/firmware.
#
# Redaction happens here, before anything leaves the Pi: the board serial,
# /etc/machine-id and every MAC address are replaced by SHA-256 hashes; process
# listings use the command name only (never argv); no environment, credential,
# Wi-Fi or docker Env/Config data is read.
set -u
export LC_ALL=C
sec() { printf '### %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
missing=()
need() { have "$1" || missing+=("$1"); }
rd() { # print a small file if readable, else say why
  if [ -r "$1" ]; then printf '%s: %s\n' "$1" "$(tr -d '\0' <"$1")"; else printf '%s: UNAVAILABLE\n' "$1"; fi
}

probes() {
  sec probe_time
  date -u +%Y-%m-%dT%H:%M:%SZ

  sec proc_modules_load_order
  # /proc/modules lists the most recently loaded module first.
  awk '{print NR, $1}' /proc/modules | head -12
  for m in inet_diag tcp_diag udp_diag raw_diag unix_diag; do
    f=$(find "/lib/modules/$(uname -r)" -name "$m.ko*" 2>/dev/null | head -1)
    b=$(grep -c "/$m.ko" "/lib/modules/$(uname -r)/modules.builtin" 2>/dev/null)
    printf 'module %s loaded=%s module_file=%s builtin=%s\n' "$m" \
      "$(awk -v m="$m" '$1==m{print "yes"}' /proc/modules | grep -q yes && echo yes || echo no)" \
      "${f:-none}" "${b:-0}"
  done

  sec identity
  printf 'model=%s\n' "$(tr -d '\0' </proc/device-tree/model 2>/dev/null)"
  grep -E '^(Model|Revision|Hardware)\s*:' /proc/cpuinfo | sort -u
  printf 'hostname=%s\n' "$(hostname)"
  printf 'etc_hostname=%s\n' "$(cat /etc/hostname 2>/dev/null)"
  printf 'user=%s\n' "$(id -un)"
  printf 'id=%s\n' "$(id)"
  if sudo -n true 2>/dev/null; then echo "sudo_passwordless=yes"; else echo "sudo_passwordless=no"; fi
  printf 'linger=%s\n' "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"

  sec architecture
  printf 'uname_m=%s\n' "$(uname -m)"
  printf 'uname_a=%s\n' "$(uname -a)"
  printf 'uname_r=%s\n' "$(uname -r)"
  printf 'dpkg_arch=%s\n' "$(dpkg --print-architecture 2>/dev/null)"
  printf 'dpkg_foreign=%s\n' "$(dpkg --print-foreign-architectures 2>/dev/null | tr '\n' ' ')"
  printf 'long_bit=%s\n' "$(getconf LONG_BIT)"
  printf 'page_size=%s\n' "$(getconf PAGESIZE)"
  printf 'binfmt_entries=%s\n' "$(ls /proc/sys/fs/binfmt_misc 2>/dev/null | tr '\n' ' ')"

  sec os
  cat /etc/os-release
  printf 'debian_version=%s\n' "$(cat /etc/debian_version 2>/dev/null)"
  [ -r /etc/rpi-issue ] && sed 's/^/rpi_issue: /' /etc/rpi-issue
  # timedatectl/hostnamectl are avoided: they D-Bus-activate timedated/hostnamed.
  printf 'timezone=%s\n' "$(cat /etc/timezone 2>/dev/null || readlink /etc/localtime)"
  printf 'timesync_synchronized_flag=%s\n' "$( [ -e /run/systemd/timesync/synchronized ] && echo present || echo absent)"

  sec kernel_config
  if [ -r /proc/config.gz ]; then src=/proc/config.gz; cat_=zcat
  elif [ -r "/boot/config-$(uname -r)" ]; then src="/boot/config-$(uname -r)"; cat_=cat
  else src=; fi
  if [ -n "$src" ]; then
    echo "source=$src"
    $cat_ "$src" | grep -E '^(CONFIG_MEMCG|CONFIG_MEMCG_SWAP|CONFIG_CGROUPS|CONFIG_CGROUP_(PIDS|CPUACCT|SCHED|FREEZER|DEVICE|BPF)|CONFIG_CPUSETS|CONFIG_BLK_CGROUP|CONFIG_CFS_BANDWIDTH|CONFIG_USER_NS|CONFIG_PID_NS|CONFIG_NET_NS|CONFIG_SECCOMP|CONFIG_SECCOMP_FILTER|CONFIG_OVERLAY_FS|CONFIG_BRIDGE|CONFIG_VETH|CONFIG_NF_TABLES|CONFIG_IP_NF_IPTABLES|CONFIG_NETFILTER_XT_MATCH_ADDRTYPE|CONFIG_NF_NAT|CONFIG_ARM64_(4K|16K|64K)_PAGES|CONFIG_ARM64_VA_BITS|CONFIG_PSI)='
  else
    echo "UNAVAILABLE no /proc/config.gz or /boot/config-<release>"
  fi

  sec cpu
  printf 'nproc=%s\n' "$(nproc)"
  lscpu 2>/dev/null | grep -E '^(Architecture|CPU\(s\)|Model name|Vendor ID|Thread|Core|Socket|CPU max MHz|CPU min MHz|Flags)'
  for f in scaling_governor scaling_cur_freq scaling_max_freq cpuinfo_max_freq; do rd /sys/devices/system/cpu/cpu0/cpufreq/$f; done
  printf 'loadavg=%s\n' "$(cat /proc/loadavg)"
  printf 'uptime_s=%s\n' "$(cut -d' ' -f1 /proc/uptime)"

  sec meminfo
  cat /proc/meminfo

  sec free
  free -b

  sec vm_sysctl
  for k in vm.swappiness vm.overcommit_memory vm.min_free_kbytes vm.dirty_ratio vm.dirty_background_ratio \
           kernel.unprivileged_userns_clone user.max_user_namespaces kernel.apparmor_restrict_unprivileged_userns \
           net.ipv4.ip_forward net.ipv4.ip_local_port_range net.ipv6.conf.all.disable_ipv6 net.ipv6.conf.all.forwarding; do
    printf '%s=%s\n' "$k" "$(sysctl -n "$k" 2>/dev/null || echo UNAVAILABLE)"
  done

  sec pressure
  for r in cpu memory io; do [ -r /proc/pressure/$r ] && sed "s/^/$r /" /proc/pressure/$r || echo "$r UNAVAILABLE"; done

  sec cgroup
  printf 'fstype=%s\n' "$(stat -fc %T /sys/fs/cgroup)"
  printf 'controllers=%s\n' "$(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null)"
  printf 'subtree_control=%s\n' "$(cat /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null)"
  printf 'system_slice_subtree_control=%s\n' "$(cat /sys/fs/cgroup/system.slice/cgroup.subtree_control 2>/dev/null)"
  echo "--- /proc/cgroups"
  cat /proc/cgroups

  sec cmdline
  cat /proc/cmdline; echo

  sec unit_memory
  # memory.current per cgroup (bytes); absent when the memory controller is off.
  for d in /sys/fs/cgroup/*.slice /sys/fs/cgroup/*.scope /sys/fs/cgroup/system.slice/*.service /sys/fs/cgroup/system.slice/*.scope /sys/fs/cgroup/user.slice/*.slice; do
    [ -d "$d" ] || continue
    cur=$(cat "$d/memory.current" 2>/dev/null || echo NA)
    peak=$(cat "$d/memory.peak" 2>/dev/null || echo NA)
    anon=$(awk '$1=="anon"{print $2}' "$d/memory.stat" 2>/dev/null); file=$(awk '$1=="file"{print $2}' "$d/memory.stat" 2>/dev/null)
    printf '%s current=%s peak=%s anon=%s file=%s\n' "${d#/sys/fs/cgroup/}" "$cur" "$peak" "${anon:-NA}" "${file:-NA}"
  done

  sec processes_top_rss
  ps -eo pid,ppid,user,rss,vsz,pcpu,comm --sort=-rss | head -30

  sec services_all
  systemctl list-units --type=service --all --no-legend --plain --no-pager | awk '{print $1, $2, $3, $4}'
  echo "--- failed"
  systemctl --failed --no-legend --plain --no-pager
  echo "--- timers"
  systemctl list-timers --all --no-legend --no-pager | awk '{print $(NF-1), $NF}'

  sec service_descriptions
  for u in airdb.service airlogger.service airmonitor.service net-watchdog.service net-watchdog.timer mosquitto.service pihole-FTL.service dnscrypt-proxy.service fail2ban.service; do
    printf '%s | %s | active=%s enabled=%s\n' "$u" "$(systemctl show -p Description --value "$u" 2>/dev/null)" \
      "$(systemctl is-active "$u" 2>/dev/null)" "$(systemctl is-enabled "$u" 2>/dev/null)"
  done

  sec listener_units
  # Map each listening PID to its systemd unit via /proc/<pid>/cgroup (no argv read).
  sudo -n ss -Hlntup | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -un | while read -r p; do
    printf 'pid=%s comm=%s cgroup=%s\n' "$p" "$(cat /proc/$p/comm 2>/dev/null)" "$(sudo -n cat /proc/$p/cgroup 2>/dev/null | tr '\n' ' ')"
  done

  sec storage_root
  findmnt -n -o TARGET,SOURCE,FSTYPE,OPTIONS,UUID,PARTUUID /
  findmnt -n -o TARGET,SOURCE,FSTYPE,OPTIONS,UUID /boot/firmware

  sec lsblk
  lsblk -b -o NAME,KNAME,TYPE,SIZE,ROTA,RM,TRAN,MODEL,FSTYPE,FSVER,LABEL,UUID,PARTUUID,MOUNTPOINTS

  sec block_devices_sys
  for b in /sys/block/*; do
    n=${b##*/}; case $n in loop*|ram*) continue;; esac
    printf '%s size_512=%s rotational=%s removable=%s\n' "$n" "$(cat $b/size)" "$(cat $b/queue/rotational 2>/dev/null)" "$(cat $b/removable 2>/dev/null)"
    for f in type name manfid oemid date; do [ -r "$b/device/$f" ] && printf '  %s=%s\n' "$f" "$(cat $b/device/$f)"; done
  done
  echo "nvme_present=$(ls /sys/class/nvme 2>/dev/null | tr '\n' ' ')"
  echo "usb_storage=$(ls /sys/bus/usb/drivers/usb-storage 2>/dev/null | grep -c ':' ) uas=$(ls /sys/bus/usb/drivers/uas 2>/dev/null | grep -c ':')"

  sec df_bytes
  df -B1 -T -x devtmpfs -x squashfs

  sec df_inodes
  df -i -x devtmpfs -x squashfs

  sec ext4_superblock
  src=$(findmnt -n -o SOURCE /)
  sudo -n dumpe2fs -h "$src" 2>/dev/null | grep -E '^(Filesystem volume name|Filesystem UUID|Filesystem state|Errors behavior|Filesystem features|Block count|Block size|Inode count|Free blocks|Free inodes|Reserved block count|Filesystem created|Last mount time|Last write time|Mount count|Maximum mount count|Last checked|Check interval|Lifetime writes|FS Error count|First error time|Last error time)'

  sec fstab
  sed -E 's/(password|pass|credentials|username|user)=[^,[:space:]]*/\1=REDACTED/g' /etc/fstab

  sec kernel_log_storage_power
  echo "boots_recorded=$(sudo -n journalctl --list-boots --no-pager 2>/dev/null | wc -l)"
  sudo -n journalctl --list-boots --no-pager 2>/dev/null | tail -5 | awk '{print $1, $3, $4, $5, $6, $7, $8}'
  echo "--- current boot kernel warnings (storage/fs/power/thermal/oom)"
  sudo -n journalctl -k -b 0 --no-pager -o short-iso 2>/dev/null | grep -iE 'mmc|ext4|i/o error|blk_update|voltage|undervolt|thermal|throttl|oom|out of memory|hung task' | tail -40
  echo "--- previous boot kernel warnings"
  sudo -n journalctl -k -b -1 --no-pager -o short-iso 2>/dev/null | grep -iE 'mmc|ext4|i/o error|blk_update|voltage|undervolt|thermal|throttl|oom|out of memory|hung task' | tail -20
  echo "--- oom kills in journal (all boots)"
  sudo -n journalctl -k --no-pager 2>/dev/null | grep -ciE 'out of memory|oom-kill|oom_reaper'

  sec swap_zram
  cat /proc/swaps
  have zramctl && zramctl 2>/dev/null
  for f in /etc/default/zramswap /etc/rpi/swap.conf /etc/dphys-swapfile; do [ -r "$f" ] && { echo "--- $f"; grep -vE '^\s*(#|$)' "$f"; }; done
  systemctl list-unit-files --no-legend --no-pager 2>/dev/null | grep -iE 'zram|swap' | awk '{print $1, $2}'

  sec container_runtime
  for b in docker dockerd containerd runc podman nerdctl ctr; do printf '%s=%s\n' "$b" "$(command -v $b || echo absent)"; done
  for u in docker.service docker.socket containerd.service podman.socket; do
    printf '%s active=%s enabled=%s\n' "$u" "$(systemctl is-active $u 2>/dev/null)" "$(systemctl is-enabled $u 2>/dev/null)"
  done
  dpkg-query -W -f='${Package} ${Version} ${db:Status-Abbrev}\n' 'docker*' 'containerd*' 'moby*' 'podman' 'runc' 'crun' 2>/dev/null
  echo "var_lib_docker=$( [ -d /var/lib/docker ] && echo present || echo absent) var_lib_containerd=$( [ -d /var/lib/containerd ] && echo present || echo absent)"
  echo "etc_docker_daemon_json=$( [ -e /etc/docker/daemon.json ] && echo present || echo absent)"
  echo "compose_plugin=$(ls /usr/libexec/docker/cli-plugins/docker-compose /usr/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose 2>/dev/null | tr '\n' ' ')"
  echo "apt_sources=$(ls /etc/apt/sources.list.d/ 2>/dev/null | tr '\n' ' ')"
  grep -rhoE 'https?://[^ ]+' /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | sort -u
  apt-cache policy docker.io docker-ce containerd.io podman 2>/dev/null | grep -E '^[a-z]|Candidate|Installed'

  sec network
  ip -br link
  echo "---"
  ip -br addr
  echo "--- routes"
  ip route
  ip -6 route
  echo "--- global_ipv6"
  ip -6 addr show scope global
  echo "--- hostname_I"
  hostname -I
  echo "--- resolv.conf"
  grep -vE '^\s*#' /etc/resolv.conf
  echo "--- nmcli devices"
  have nmcli && nmcli -t -f DEVICE,TYPE,STATE device 2>/dev/null
  echo "--- nm ipv6 addr-gen / method (no connection names)"
  have nmcli && nmcli -t -f ipv6.method,ipv6.addr-gen-mode,ipv4.method connection show --active 2>/dev/null | sort -u

  sec listening
  sudo -n ss -Hlntup

  sec firewall
  lsmod | awk '{print $1}' | grep -xE 'nf_tables|ip_tables|ip6_tables|x_tables|nf_conntrack|iptable_filter|nft_compat|br_netfilter' || echo "no netfilter table modules loaded"
  for b in nft iptables iptables-legacy iptables-nft ufw firewall-cmd; do printf '%s=%s\n' "$b" "$(command -v $b || echo absent)"; done
  printf 'iptables_alternative=%s\n' "$(readlink -f /etc/alternatives/iptables 2>/dev/null || echo none)"
  for u in nftables.service ufw.service firewalld.service netfilter-persistent.service; do
    printf '%s active=%s enabled=%s\n' "$u" "$(systemctl is-active $u 2>/dev/null)" "$(systemctl is-enabled $u 2>/dev/null)"
  done
  [ -r /etc/ufw/ufw.conf ] && grep -E '^ENABLED' /etc/ufw/ufw.conf
  echo "etc_nftables_conf=$( [ -e /etc/nftables.conf ] && echo present || echo absent)"
  echo "--- fail2ban action config"
  sudo -n grep -rhE '^\s*(banaction|banaction_allports|backend|enabled|\[)' /etc/fail2ban/jail.local /etc/fail2ban/jail.d/ 2>/dev/null
  sudo -n fail2ban-client status 2>/dev/null

  sec tailscale
  printf 'tailscale=%s tailscaled=%s\n' "$(command -v tailscale || echo absent)" "$(command -v tailscaled || echo absent)"
  printf 'tailscaled.service active=%s enabled=%s\n' "$(systemctl is-active tailscaled.service 2>/dev/null)" "$(systemctl is-enabled tailscaled.service 2>/dev/null)"
  dpkg-query -W -f='${Package} ${Version}\n' tailscale 2>/dev/null

  sec reverse_proxies
  dpkg-query -W -f='${Package} ${Version} ${db:Status-Abbrev}\n' nginx nginx-core caddy apache2 haproxy lighttpd traefik 2>/dev/null
  for b in nginx caddy apache2 haproxy lighttpd traefik cloudflared; do printf '%s=%s\n' "$b" "$(command -v $b || echo absent)"; done

  sec existing_service_exposure
  # Listener scope of existing services, needed for the network plan.
  sudo -n grep -E '^\s*(listeningMode|port|interface)\s*=' /etc/pihole/pihole.toml 2>/dev/null | head -10
  sudo -n grep -rhE '^\s*(listener|allow_anonymous|password_file|bind_address|protocol)' /etc/mosquitto/mosquitto.conf /etc/mosquitto/conf.d/ 2>/dev/null | sed -E 's/(password_file\s+).*/\1<path present>/'
  printf 'sshd_password_auth=%s\n' "$(sudo -n sshd -T 2>/dev/null | grep -E '^(passwordauthentication|permitrootlogin|pubkeyauthentication)' | tr '\n' ' ')"

  sec thermal_power
  if have vcgencmd; then
    for c in measure_temp get_throttled "measure_volts core" "measure_clock arm" "get_config usb_max_current_enable" "get_config total_mem" version bootloader_version; do
      printf 'vcgencmd %s => %s\n' "$c" "$(vcgencmd $c 2>&1 | tr '\n' ' ')"
    done
    echo "--- pmic_read_adc"
    vcgencmd pmic_read_adc 2>&1
    echo "--- bootloader_config (PSU/power keys)"
    vcgencmd bootloader_config 2>&1 | grep -E '^(PSU_MAX_CURRENT|POWER_OFF_ON_HALT|BOOT_ORDER|WAKE_ON_GPIO|\[)'
  else
    echo "vcgencmd=absent"
  fi
  for z in /sys/class/thermal/thermal_zone*; do [ -d "$z" ] && printf '%s type=%s temp_mC=%s\n' "${z##*/}" "$(cat $z/type)" "$(cat $z/temp)"; done
  for c in /sys/class/thermal/cooling_device*; do [ -d "$c" ] && printf '%s type=%s cur=%s max=%s\n' "${c##*/}" "$(cat $c/type)" "$(cat $c/cur_state)" "$(cat $c/max_state)"; done
  for h in /sys/class/hwmon/hwmon*; do
    printf '%s name=%s' "${h##*/}" "$(cat $h/name)"
    for f in fan1_input pwm1 pwm1_enable in0_lcrit_alarm temp1_input; do [ -r "$h/$f" ] && printf ' %s=%s' "$f" "$(cat $h/$f)"; done
    echo
  done
  echo "cooling_fan_platform=$( [ -d /sys/devices/platform/cooling_fan ] && echo present || echo absent)"

  sec apparmor
  printf 'apparmor_enabled=%s\n' "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || echo UNAVAILABLE)"
  printf 'lsm=%s\n' "$(cat /sys/kernel/security/lsm 2>/dev/null)"

  sec updates
  dpkg-query -W -f='${Package} ${Version}\n' unattended-upgrades 2>/dev/null || echo "unattended-upgrades not installed"

  sec tools
  for t in curl wget jq git node npm zramctl vcgencmd lsblk findmnt ss nft iptables docker tailscale smartctl nvme sensors dumpe2fs sqlite3; do need "$t"; done
  printf 'missing_utilities=%s\n' "${missing[*]:-none}"
}

out=$(probes 2>&1)

# Redact identifiers before output leaves the Pi.
h() { printf '%s' "$1" | sha256sum | cut -c1-64; }
serial=$(tr -d '\0' </proc/device-tree/serial-number 2>/dev/null)
cpuserial=$(awk -F': ' '/^Serial/{print $2}' /proc/cpuinfo)
mid=$(cat /etc/machine-id 2>/dev/null)
if [ -n "$serial" ]; then out=${out//$serial/SERIAL_SHA256:$(h "$serial")}; fi
if [ -n "$cpuserial" ] && [ "$cpuserial" != "$serial" ]; then out=${out//$cpuserial/SERIAL_SHA256:$(h "$serial")}; fi
if [ -n "$mid" ]; then out=${out//$mid/MACHINE_ID_SHA256:$(h "$mid")}; fi
for mac in $(printf '%s\n' "$out" | grep -oiE '([0-9a-f]{2}[:-]){5}[0-9a-f]{2}' | sort -u); do
  out=${out//$mac/MAC_SHA256:$(h "$(printf '%s' "$mac" | tr 'A-F-' 'a-f:')")}
done
printf '%s\n' "$out"
printf '### identity_hashes\n'
printf 'board_serial_sha256=%s\n' "$( [ -n "$serial" ] && h "$serial" || echo UNAVAILABLE)"
printf 'machine_id_sha256=%s\n' "$( [ -n "$mid" ] && h "$mid" || echo UNAVAILABLE)"
for i in /sys/class/net/*; do
  n=${i##*/}; [ "$n" = lo ] && continue
  a=$(cat "$i/address" 2>/dev/null)
  printf 'mac_sha256 %s=%s\n' "$n" "$( [ -n "$a" ] && h "$a" || echo UNAVAILABLE)"
done
echo "end"
