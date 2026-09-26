#!/usr/bin/env bash
# D2's first M2 step (evidence/M0/review/DECISIONS.md): prove Chromium natively on this host's
# 16 KiB-page kernel before any patch, retrieval or build work depends on it. Run on the Pi by
# scripts/m2/browser-proof.sh (which uploads the verified playwright-core tarball first):
#   ssh … 'bash -s -- <image@digest>' < scripts/m2/pi-browser-proof.sh
# Every container is throwaway: label fcpi.transient, --rm, no network, read-only root, uid 3320,
# no capabilities, no-new-privileges, the browser's §22 caps and 256 MiB of shared memory.
#   control  Docker's builtin seccomp profile: the sandbox must fail (why the profile exists)
#   proof    deploy/browser/seccomp.json: launch with the sandbox on, render, close, look again
# Then: ELF machine and LOAD alignment of every Chromium binary and shared library, the SHA-256
# of every file the image installed for Chromium (compared with the archives by the verifier),
# and what is left afterwards. Changes nothing but the throwaway containers and its temp dir.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
IMG=${1:?usage: pi-browser-proof.sh <image@digest>}
DEST=/opt/firecrawl-pi
WORK=/tmp/fcpi-m2-browser-proof
[ -f "$WORK/playwright-core.tgz" ] || { echo "missing $WORK/playwright-core.tgz (scripts/m2/browser-proof.sh uploads it)" >&2; exit 1; }
sec() { printf '### %s\n' "$1"; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "source_commit=$(cat $DEST/.fcpi-source-commit)"
echo "image=$IMG"
echo "kernel=$(uname -r) machine=$(uname -m) page_size=$(getconf PAGESIZE)"
echo "max_user_namespaces=$(cat /proc/sys/user/max_user_namespaces) lsm=$(cat /sys/kernel/security/lsm 2>/dev/null || echo none)"
echo "playwright_core_tgz_sha256=$(sha256sum "$WORK/playwright-core.tgz" | cut -c1-64)"
echo "seccomp_profile_sha256=$(sha256sum $DEST/deploy/browser/seccomp.json | cut -c1-64)"

sec image
sudo -n docker image inspect "$IMG" --format 'id={{.Id}} os={{.Os}} arch={{.Architecture}} size={{.Size}}'

# The tarball is unpacked where the containers can read it; nothing in it runs on the host.
PW=$(mktemp -d "$WORK/pw.XXXX")
tar -xzf "$WORK/playwright-core.tgz" -C "$PW"
chmod -R a+rX "$WORK"
RUN=(sudo -n docker run --rm --init --network none --read-only --tmpfs /tmp:size=256m,mode=1777 --shm-size 256m
  --memory 1536m --memory-swap 1536m --cpus 1.5 --pids-limit 512 --user 3320:3320 -e HOME=/tmp
  --cap-drop ALL --security-opt no-new-privileges --label fcpi.transient=m2-browser-proof
  -v "$PW:/pw:ro" -v "$DEST/tests/fixtures/m2/site:/fixture:ro" -v "$DEST/scripts/m2/browser-proof.mjs:/proof/browser-proof.mjs:ro")

sec control_builtin_seccomp
set +e; "${RUN[@]}" "$IMG" node /proof/browser-proof.mjs control 2>&1 | sed 's/^### /#### /'; rc=${PIPESTATUS[0]}; set -e
echo "exit=$rc"

sec proof_project_seccomp
set +e; "${RUN[@]}" --security-opt "seccomp=$DEST/deploy/browser/seccomp.json" "$IMG" node /proof/browser-proof.mjs proof 2>&1 | sed 's/^### /#### /'; rc=${PIPESTATUS[0]}; set -e
echo "exit=$rc"

sec elf_alignment
# Every ELF under the two Chromium trees: the binaries and each shared library they load.
"${RUN[@]}" -v "$DEST/scripts/m1/elf-align.mjs:/proof/elf-align.mjs:ro" "$IMG" sh -c \
  'find /ms-playwright/chromium-1243 /ms-playwright/chromium_headless_shell-1243 -type f \( -name "*.so*" -o -name chrome -o -name chrome-headless-shell -o -name chrome_crashpad_handler -o -name chrome_sandbox \) | sort | xargs node /proof/elf-align.mjs'

sec installed_files_sha256
"${RUN[@]}" "$IMG" sh -c 'cd /ms-playwright && find chromium-1243 chromium_headless_shell-1243 -type f | LC_ALL=C sort | xargs sha256sum'

sec after
echo "leftover_transient_containers=$(sudo -n docker ps -a --filter label=fcpi.transient --format '{{.ID}}' | wc -l)"
echo "uid_3320_processes=$(ps -eo uid= | awk '$1==3320' | wc -l)"
echo "chrome_processes_on_host=$(pgrep -c -f 'chrome-headless-shell|chrome-linux-arm64/chrome' || true)"
rm -rf "$WORK"
echo "work_dir_removed=$([ -e "$WORK" ] && echo no || echo yes)"
sec end
echo end
