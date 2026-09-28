#!/usr/bin/env bash
# The durable boot record (M7 review finding F13; FIRECRAWL_PI_SPEC.md §24.2), run by fcpi-boot-record.service once at
# every boot as root, ON the Pi. The journal is capped at 32 MiB and on this host rotates a reboot's cause out within
# hours, so the record is made at boot, while the journal still holds the boot that ended:
#   1. scripts/m7/pi-reboot-record.sh from the previous boot to this one (the ended boot's last entry, its orderly-
#      shutdown markers, the owner's Wi-Fi watchdog's recovery steps, the Wi-Fi loss before them, local actions after
#      it, undervoltage), in the format M7's verifier ties reboots with;
#   2. then, once the stack answers, the readiness section: seconds from kernel start to fcpi-stack.service active,
#      and to the first moment the gateway's core and ledger, a fixture scrape and a modern MCP tools/list all succeed
#      (spec §24.2: within five minutes, with no SSH action), or not_ready after 15 minutes.
# Each record is a new file, /var/lib/firecrawl-pi/boots/<boot UTC>-<boot hash 12>.txt, created with noclobber and
# never rewritten; records are kept a year.
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
D=$STATE/boots
mkdir -p "$D"
up=$(cut -d. -f1 /proc/uptime)
boot_utc=$(date -u -d "@$(( $(now_s) - up ))" +%Y%m%dT%H%M%SZ)
F=$D/$boot_utc-$(boot_hash | cut -c1-12).txt
if ls "$D"/*-"$(boot_hash | cut -c1-12)".txt >/dev/null 2>&1; then echo "fcpi-boot-record: this boot is already recorded"; exit 0; fi
tmp=$(mktemp "$D/.record.XXXXXX")
trap 'rm -f "$tmp"' EXIT
# The previous boot's ID as the journal lists it (32 hex), hashed the way the snapshots hash /proc's (dashed, newline).
prev=$(journalctl --list-boots --no-pager 2>/dev/null | awk 'NR > 1 {print $1, $2}' | awk '$1 == -1 {print $2}')
if [ -n "$prev" ]; then
  prev_hash=$(printf '%s\n' "$(printf '%s' "$prev" | sed -E 's/^(.{8})(.{4})(.{4})(.{4})(.{12})$/\1-\2-\3-\4-\5/')" | sha256sum | cut -c1-64)
else prev_hash=$(boot_hash); fi
bash "$REPO/scripts/m7/pi-reboot-record.sh" "$prev_hash" | sed '$d' >"$tmp"   # without its closing "end"
set -C; cat "$tmp" >"$F" || exit 1; set +C
chmod 0644 "$F"

# Readiness. The operator token and the gateway exist only once the stack is up; every check is retried until then.
# Both waits are bounded by the clock, not by a count of tries (each try can spend over a minute in the gateway's
# timeouts): readiness until 15 minutes after kernel start, and everything by T_END, inside the unit's 1200 s start
# timeout with room to write, so the readiness line and "end" are written even on a boot whose stack never starts.
T_END=$(( $(now_s) + 1000 ))   # a last try (at most 80 s of timeouts) still ends inside the 1200 s
before_end() { [ "$(now_s)" -lt "$T_END" ]; }
{
  echo "### readiness"
  stack_mono=""; ready=""; st=""
  while :; do
    st=$(systemctl show -p ActiveState --value fcpi-stack.service)
    if [ -z "$stack_mono" ] && [ "$st" = active ]; then
      stack_mono=$(systemctl show -p ActiveEnterTimestampMonotonic --value fcpi-stack.service)
    fi
    GW_TIMEOUT=10 gw GET /platform/v1/status
    if [ "$GW_STATUS" = 200 ] && jq -e '.core.live == true and .ledger.ok == true' <<<"$GW_BODY" >/dev/null 2>&1; then
      GW_TIMEOUT=10 mcp tools/list '{}'; m=$GW_STATUS
      GW_TIMEOUT=60 gw POST /v2/scrape '{"url":"http://m1.fixture.fcpi.test:8080/static.html","formats":["markdown"]}'
      if [ "$m" = 200 ] && [ "$GW_STATUS" = 200 ] && grep -q fcpi-m1-static-7f3a <<<"$GW_BODY"; then ready=$(cut -d. -f1 /proc/uptime); break; fi
    fi
    [ "$(cut -d. -f1 /proc/uptime)" -lt 900 ] && before_end || break
    sleep 5
  done
  # The restart policies revive the containers before fcpi-stack.service's own start (which waits for every container, the
  # slow fixtures included) finishes: its time is waited for too, until T_END, and not at all once the unit has failed.
  while [ -z "$stack_mono" ] && before_end; do
    st=$(systemctl show -p ActiveState --value fcpi-stack.service)
    [ "$st" = active ] && { stack_mono=$(systemctl show -p ActiveEnterTimestampMonotonic --value fcpi-stack.service); break; }
    [ "$st" = failed ] && break
    sleep 5
  done
  echo "stack_active_after_boot_s=${stack_mono:+$((stack_mono / 1000000))} ready_after_boot_s=${ready:-not_ready} recorded_utc=$(utc) stack_state=${st:-unknown}"
  echo end
} >>"$F"
find "$D" -maxdepth 1 -name '*.txt' -mtime +365 -delete
