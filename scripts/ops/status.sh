#!/usr/bin/env bash
# fcpi status [--json] (FIRECRAWL_PI_SPEC.md §25, AC17), as root ON the Pi. Each dependency is reported on its own, so
# an injected failure shows as that one component, not as one opaque verdict:
#   - every fcpi container's state, health, restarts, memory against its cap and whether swap is still denied to it;
#     the core's API and NuQ worker separately (its health check reports each), the worker's heartbeat time;
#   - the capabilities' readiness: REST (the gateway's view of the core and the ledger, asked now), MCP (a modern
#     tools/list, now), scrape, search, extraction, documents, browser, residential and enhanced (the providers'
#     credential, breaker and selection, from the retrieval service through the gateway);
#   - the queue (queued, the oldest queued item's age, active, open jobs), the host (memory, swap, temperature,
#     throttle flags, disk, inodes), the admission state, open incidents, containers outside project fcpi, the last
#     functional probe, the last backup's age and the last restore test, the deployed commit and the version lock.
# Exit 0 when the core's API and worker, the ledger and REST are ready; 1 otherwise.
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
json=false; [ "${1:-}" = --json ] && json=true
sample=$(obj "$RUND/last-sample.json")
adm=$(obj "$ADMISSION")
inc=$(obj "$STATE/alerts/state.json")
probe=$(obj "$STATE/probe-last.json")
lb=$(obj "$STATE/backup/last.json")
la=$(obj "$STATE/backup/last-attempt.json")
lr=$(obj "$STATE/backup/last-restore-test.json")
# Live reads: the gateway's platform status and a modern MCP request.
GW_TIMEOUT=10 gw GET /platform/v1/status; ps=$GW_STATUS pb=$GW_BODY pms=$GW_MS
[ "$ps" = 200 ] && jq -e . <<<"$pb" >/dev/null 2>&1 || pb='{}'
GW_TIMEOUT=10 mcp tools/list '{}'; ms=$GW_STATUS mb=$GW_BODY mms=$GW_MS
mcp_tools=$(jq -r '.result.tools | length' <<<"$mb" 2>/dev/null || echo 0)
# The containers now (not the last sample's): a stopped service shows at once.
live=$(docker inspect $(docker ps -aq --filter label=com.docker.compose.project=fcpi) 2>/dev/null | jq -c 'map({key: .Config.Labels["com.docker.compose.service"],
  value: {state: .State.Status, health: (.State.Health.Status // "none"), restarts: .RestartCount,
          check: ((.State.Health.Log // []) | last | .Output // "" | gsub("\\s+$"; "")), check_at: ((.State.Health.Log // []) | last | .End // null)}}) | from_entries')
[ -n "$live" ] || live='{}'
foreign=$(docker ps -a --format '{{.Names}} {{.Label "com.docker.compose.project"}} {{.Label "fcpi.transient"}}' | awk '$2 != "fcpi" && $3 == "" {print $1}' | jq -Rsc 'split("\n") | map(select(. != ""))')
lock=$(sha256sum "$REPO/deploy/versions.lock.json" 2>/dev/null | cut -c1-64)
out=$(jq -n --arg utc "$(utc)" --arg commit "$(source_commit)" --arg lock "$lock" --argjson s "$sample" --argjson adm "$adm" --argjson inc "$inc" \
  --argjson probe "$probe" --argjson lb "$lb" --argjson la "$la" --argjson lr "$lr" --arg ps "$ps" --argjson pb "$pb" --argjson pms "$pms" \
  --arg ms "$ms" --argjson mt "${mcp_tools:-0}" --argjson mms "$mms" --argjson live "$live" --argjson foreign "$foreign" --argjson now "$(now_s)" '
  def age(t): if t == null then null else ($now - (t | sub("\\.[0-9]+"; "") | sub("(?<z>[+-][0-9:]+|Z)$"; "Z") | fromdateiso8601)) end;
  def mib: if . == null then null else (. / 1048576 | floor) end;
  ($s.containers // [] | map(select(.project == "fcpi")) | map({key: .service, value: .}) | from_entries) as $cg
  | ($live["firecrawl-core"].check // "") as $cc
  | ($pb.providers // {}) as $prov
  | { utc: $utc, commit: $commit, versions_lock_sha256: $lock,
      services: ($live | to_entries | map({key: .key, value: (.value + {mem_mib: ($cg[.key].mem_current | mib), peak_mib: ($cg[.key].mem_peak | mib),
        limit_mib: ($cg[.key].mem_limit | mib), swap_denied: $cg[.key].swap_limited, oom_kills: ($cg[.key].oom_kill // null)} | del(.check))}) | from_entries),
      core: { api: ($cc | test("api=ok")), worker: ($cc | test("worker=ok")), heartbeat_at: $live["firecrawl-core"].check_at, check: $cc },
      rest: { ready: ($ps == "200" and $pb.core.live == true and $pb.ledger.ok == true), status: ($ps | tonumber), ms: $pms,
              core_live: $pb.core.live, ledger_ok: $pb.ledger.ok, jobs: ($pb.jobs // null), archive: ($pb.archive // null) },
      mcp: { ready: ($ms == "200" and $mt > 0), status: ($ms | tonumber), ms: $mms, tools: $mt, protocol: "2026-07-28" },
      capabilities: {
        scrape: ($live["firecrawl-core"].health == "healthy" and $live["retrieval-service"].health == "healthy"),
        browser: ($live["browser-worker"].health == "healthy" and ($adm.browser // "open") == "open"),
        search: ($live["searxng"].health == "healthy"),
        providers: $prov },
      queue: ($s.queue // null),
      host: { sample_age_s: age($s.utc), mem: $s.mem, temp_c: $s.temp_c, injected_temp: $s.injected_temp, throttled: $s.throttled, disk: $s.disk,
              host_oom_kill: $s.host_oom_kill },
      admission: ($adm + {age_s: age($adm.utc)}),
      incidents: ($inc | to_entries | map(select(.value.open)) | map({key: .key, value: {since: (.value.first | todate), detail: .value.detail}}) | from_entries),
      foreign_containers: $foreign,
      probe: $probe,
      backup: { last_success: ($lb.utc // null), age_h: (if $lb.utc then (age($lb.utc) / 3600 * 10 | floor) / 10 else null end), offdevice: ($lb.offdevice // null),
                last_attempt: ($la | {utc, result, error}), last_restore_test: ($lr | {utc, result, error}) } }
  | .healthy = (.core.api and .core.worker and .rest.ready)')
if [ $json = true ]; then jq . <<<"$out"
else jq -r '
  def yn: if . == true then "ok" elif . == false then "NOT READY" else "?" end;
  "fcpi \(.utc)  commit \(.commit[0:12])  lock \(.versions_lock_sha256[0:12])",
  "core      api \(.core.api | yn)  worker \(.core.worker | yn)  heartbeat \(.core.heartbeat_at // "-")",
  "rest      \(.rest.ready | yn) (HTTP \(.rest.status), \(.rest.ms) ms)  ledger \(.rest.ledger_ok | yn)",
  "mcp       \(.mcp.ready | yn) (HTTP \(.mcp.status), \(.mcp.tools) tools, \(.mcp.protocol))",
  "queue     \(if .queue.ok then "queued \(.queue.queued), oldest \(.queue.oldest_queued_s) s, active \(.queue.active), open jobs \(.queue.open_jobs)" else "UNREADABLE" end)",
  "host      available \(.host.mem.available_mib) MiB, swap used \(.host.mem.swap_used_mib) MiB, \(.host.temp_c) C, throttled \(.host.throttled), disk free \(.host.disk.free_pct) %  (sample \(.host.sample_age_s) s old)",
  "admission dispatch \(.admission.dispatch), browser \(.admission.browser) \(.admission.reasons // [] | join(","))",
  "backup    last \(.backup.last_success // "never") (\(.backup.age_h // "-") h, off-device \(.backup.offdevice // "-")); last attempt \(.backup.last_attempt.result // "-"); restore test \(.backup.last_restore_test.result // "-")",
  "probe     \(.probe.utc // "-") \(if .probe.ok then "ok" else "FAILING (\(.probe.consecutive_failures // "?"))" end)",
  "incidents \(.incidents | keys | join(", ") | if . == "" then "none" else . end)",
  (if (.foreign_containers | length) > 0 then "FOREIGN   \(.foreign_containers | join(", ")) (Docker serves this project alone: M1 R12)" else empty end),
  "services",
  (.services | to_entries[] | "  \(.key | .[0:18] | . + (" " * (18 - length)))  \(.value.state) \(.value.health)  restarts \(.value.restarts)  \(.value.mem_mib // "-")/\(.value.limit_mib // "-") MiB  swap \(if .value.swap_denied == true then "denied" elif .value.swap_denied == false then "ALLOWED" else "-" end)")
  ' <<<"$out"; fi
[ "$(jq -r .healthy <<<"$out")" = true ]
