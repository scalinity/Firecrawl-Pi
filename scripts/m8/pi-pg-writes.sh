#!/usr/bin/env bash
# PostgreSQL's writes on the card (M1 review finding R15, deferred to M8), ON the Pi, as root: one JSON line of
# cumulative counters for the A/B comparison of the write settings: pg_stat_wal (WAL bytes, writes, syncs),
# pg_stat_checkpointer and pg_stat_bgwriter (buffers written by each), the database container's cgroup write bytes to
# the card (io.stat), the card's own sectors written, and the settings in force.
#   ssh … 'sudo -n bash /opt/firecrawl-pi/scripts/m8/pi-pg-writes.sh <label>'
set -uo pipefail
. /opt/firecrawl-pi/scripts/ops/lib.sh
need_root
label=${1:?label}
c=$(cid nuq-postgres); read -r id parent < <(docker inspect -f '{{.Id}} {{.HostConfig.CgroupParent}}' "$c")
dev=$(lsblk -no PKNAME "$(findmnt -no SOURCE --target /srv/firecrawl-pi/data)" | head -1); mm=$(cat "/sys/block/$dev/dev")
wb=$(awk -v d="$mm" '$1 == d {for (i = 2; i <= NF; i++) if ($i ~ /^wbytes=/) {sub("wbytes=", "", $i); print $i}}' "/sys/fs/cgroup/${parent:-system.slice}/docker-$id.scope/io.stat")
q=$(pg "SELECT json_build_object('wal_bytes', w.wal_bytes::bigint, 'wal_write', w.wal_write, 'wal_sync', w.wal_sync,
  'ckpt_buffers', c.buffers_written, 'ckpt_timed', c.num_timed, 'ckpt_requested', c.num_requested, 'bgwriter_clean', b.buffers_clean,
  'settings', (SELECT json_object_agg(name, setting) FROM pg_settings WHERE name IN ('bgwriter_delay','bgwriter_lru_maxpages','bgwriter_lru_multiplier','bgwriter_flush_after',
    'wal_writer_delay','wal_writer_flush_after','wal_buffers','effective_io_concurrency','maintenance_io_concurrency','commit_delay','commit_siblings','checkpoint_timeout','max_wal_size','min_wal_size')))
  FROM pg_stat_wal w, pg_stat_checkpointer c, pg_stat_bgwriter b")
jq -cn --arg l "$label" --arg utc "$(utc)" --argjson pg "${q:-null}" --argjson wb "${wb:-0}" --argjson cs "$(awk -v d="$dev" '$3 == d {print $10}' /proc/diskstats)" \
  '{label:$l, utc:$utc, postgres_cgroup_wbytes:$wb, card_written_sectors:$cs, pg:$pg}'
