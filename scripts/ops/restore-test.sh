#!/usr/bin/env bash
# fcpi restore-test (FIRECRAWL_PI_SPEC.md §26), as root ON the Pi, by fcpi-restore-test.timer monthly or by hand. It
# restores a backup into an isolated copy and proves it, then removes the copy. It never touches project fcpi.
#   1. the newest fcpi-data snapshot (or --snapshot <id>) and the fcpi-secrets snapshot of the same run are restored
#      under /srv/firecrawl-pi/restore-test (on the data filesystem, removed at the end), and every staged file is
#      checked against the backup's MANIFEST.sha256;
#   2. the copy runs as Compose project fcpi-restore, made from the restored tree's own compose file by one jq
#      transformation (the images, configuration and version lock of the run that was backed up): every network
#      internal, renamed fcpi_r_* (bridges fcpi-r-*, which NetworkManager leaves alone) on 10.232.0.0/16; no published
#      port; no egress network at all, so nothing in the copy can reach a provider, a webhook receiver or the Internet;
#      webhook delivery suppressed and paid dispatch off besides; the browser, SearXNG and the M2-M7 fixtures left out;
#      every container labelled fcpi.transient=restore-test;
#   3. a throwaway container of the restored gateway image, on the copy's access network, makes the requests: each
#      canary result as its own principal (its documents' hash must equal the hash recorded at backup) and as another
#      principal (404); each in-flight job's receipt (still tracked); each canary artifact (its bytes' hash; 404 for
#      another principal); a fixture scrape through REST; MCP tools/list and a scrape tool call; the host side checks
#      the containers' environment, that every network of the copy is internal, and that no webhook event was
#      delivered while it ran;
#   4. the copy is taken down (its containers and networks; binds only) and its directory removed.
# The result is /var/lib/firecrawl-pi/backup/last-restore-test.json (PASS or FAIL with each check); the tick opens
# restore_test_failed on FAIL.
#   fcpi restore-test [--snapshot <id>] [--keep]   --keep leaves the copy running (the upgrade and rollback rehearsal
#   fcpi restore-test --check                      works on it); --check runs step 3 again against the running copy and
#   fcpi restore-test --teardown                   prints its checks; --teardown is step 4.
set -uo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
need_root
exec 8>"$RUND/backup.lock"; flock -n 8 || die "a backup or another restore test is running"
SNAP=latest KEEP=false MODE=full
while [ $# -gt 0 ]; do case $1 in --snapshot) SNAP=$2; shift 2 ;; --keep) KEEP=true; shift ;; --check) MODE=check; KEEP=true; shift ;; --teardown) MODE=teardown; shift ;; *) die "unknown option $1" ;; esac; done
B=$STATE/backup; mkdir -p "$B"
CONF=/etc/firecrawl-pi/backup.env
[ -r "$CONF" ] || die "/etc/firecrawl-pi/backup.env is absent: no backup repository is configured"
# shellcheck disable=SC1090
. "$CONF"
export RESTIC_REPOSITORY=$FCPI_RESTIC_REPOSITORY RESTIC_PASSWORD_FILE=$FCPI_RESTIC_PASSWORD_FILE RESTIC_CACHE_DIR=$STATE/restic-cache
if [ -n "${FCPI_RESTIC_ENV_FILE-}" ]; then set -a; . "$FCPI_RESTIC_ENV_FILE"; set +a; fi
. /etc/firecrawl-pi/config.env
R=/srv/firecrawl-pi/restore-test P=fcpi-restore
T0=$(now_s) CHECKS='{}'
check() { CHECKS=$(jq -c --arg k "$1" --argjson ok "$2" --arg d "$3" '.[$k] = {ok: $ok, detail: $d}' <<<"$CHECKS"); }
teardown() {
  docker rm -f "$P-check" >/dev/null 2>&1
  [ "$KEEP" = true ] && return 0
  [ -f "$R/compose.json" ] && docker compose -p "$P" -f "$R/compose.json" down --remove-orphans --timeout 30 >/dev/null 2>&1
  if [ "$(readlink -f "$R")" = /srv/firecrawl-pi/restore-test ]; then rm -rf "$R"; fi
}
if [ "$MODE" = teardown ]; then teardown; echo "teardown: $(docker ps -aq --filter "label=com.docker.compose.project=$P" | wc -l) containers left, $([ -e "$R" ] && echo present || echo removed)"; exit 0; fi
finish() { # finish <PASS|FAIL> [error]
  local line
  line=$(jq -cn --arg utc "$(utc)" --arg r "$1" --arg e "${2-}" --arg snap "${SNAP_DATA:-}" --arg run "${RUN_ID:-}" --argjson c "$CHECKS" --argjson s "$(( $(now_s) - T0 ))" \
    '{utc:$utc,result:$r,snapshot:$snap,backup_run:$run,seconds:$s,checks:$c} + (if $e == "" then {} else {error:$e} end)')
  printf '%s\n' "$line" | write_atomic "$B/last-restore-test.json" 0600; append_line "$B/restore-history.jsonl" "$line"
  echo "$line"
}
trap teardown EXIT
ST=$R/fs/srv/firecrawl-pi/backup-staging/current
if [ "$MODE" = full ]; then
[ "$(findmnt -no UUID --target /srv/firecrawl-pi)" = "$PI_DATA_MOUNT_ID" ] || { finish FAIL "/srv/firecrawl-pi is not on the data filesystem"; exit 1; }
[ -e "$R" ] && { teardown; [ -e "$R" ] && { finish FAIL "$R exists and could not be cleared"; exit 1; }; }
docker ps -aq --filter "label=com.docker.compose.project=$P" | grep . >/dev/null && { finish FAIL "a $P project already exists"; exit 1; }

# ---- 1. restore ----------------------------------------------------------------------------------------------------
SNAP_DATA=$(restic snapshots --json --tag fcpi-data --host fcpi-pi ${SNAP/latest/--latest 1} 2>/dev/null | jq -r --arg s "$SNAP" \
  'if $s == "latest" then (max_by(.time) | .short_id) else (map(select(.id | startswith($s))) | .[0].short_id) end // empty')
[ -n "$SNAP_DATA" ] || { finish FAIL "no fcpi-data snapshot $SNAP"; exit 1; }
t_data=$(restic snapshots --json "$SNAP_DATA" | jq -r '.[0].time')
# The secrets snapshot the same run took: the first after the data snapshot, within an hour.
SNAP_SEC=$(restic snapshots --json --tag fcpi-secrets --host fcpi-pi | jq -r --arg t "$t_data" \
  '[.[] | select(.time >= $t and ((.time[0:19] + "Z" | fromdateiso8601) - ($t[0:19] + "Z" | fromdateiso8601)) < 3600)] | min_by(.time) | .short_id // empty')
[ -n "$SNAP_SEC" ] || { finish FAIL "no fcpi-secrets snapshot for $SNAP_DATA"; exit 1; }
mkdir -m 0700 "$R" "$R/secrets"
restic restore "$SNAP_DATA" --target "$R/fs" >"$R/restic-restore.log" 2>&1 || { finish FAIL "restic restore failed"; exit 1; }
restic dump "$SNAP_SEC" fcpi-secrets.tar 2>/dev/null | tar -C "$R/secrets" -xf - || { finish FAIL "the secrets snapshot could not be restored"; exit 1; }
META=$(cat "$ST/backup-meta.json" 2>/dev/null) || { finish FAIL "the snapshot holds no backup-meta.json"; exit 1; }
RUN_ID=$(jq -r .run <<<"$META")
bad=$(cd "$ST" && sha256sum -c --quiet MANIFEST.sha256 2>&1 | wc -l); n=$(wc -l <"$ST/MANIFEST.sha256")
check manifest "$([ "$bad" = 0 ] && [ "$n" -gt 5 ] && echo true || echo false)" "$n files, $bad mismatched"
lock_ok=false; [ "$(sha256sum "$R/fs$REPO/deploy/versions.lock.json" | cut -c1-64)" = "$(jq -r .versions_lock_sha256 <<<"$META")" ] && lock_ok=true
check config_matches_backup "$lock_ok" "restored versions lock against backup-meta; commit $(jq -r .source_commit <<<"$META")"
# The data directory the copy runs on: the staged data services' copy, and the result store backed up live beside it.
mv "$ST/data" "$R/data" && mv "$R/fs/srv/firecrawl-pi/data/artifacts" "$R/data/artifacts" || { finish FAIL "the restored data could not be put in place"; exit 1; }
# The copy's own admission file, open: the services read any file older than three minutes as open, so it needs no tick.
mkdir -m 0755 "$R/admission"
printf '{"utc":"%s","dispatch":"open","browser":"open","reasons":[]}\n' "$(utc)" >"$R/admission/admission.json"

# ---- 2. the isolated copy ------------------------------------------------------------------------------------------
KEEP_SVC='["nuq-postgres","redis","rabbitmq","firecrawl-core","access-gateway","mcp-gateway","retrieval-service","fixture"]'
docker compose -f "$R/fs$REPO/deploy/compose.yaml" config --format json 2>"$R/render.err" | jq --arg R "$R" --argjson keep "$KEEP_SVC" '
  def fix: if type == "string" then
      gsub("/srv/firecrawl-pi/data/"; $R + "/data/") | gsub("/opt/firecrawl-pi/"; $R + "/fs/opt/firecrawl-pi/")
    | gsub("/etc/firecrawl-pi/secrets"; $R + "/secrets/secrets") | gsub("/etc/firecrawl-pi/"; $R + "/fs/etc/firecrawl-pi/")
    | gsub("/run/firecrawl-pi/admission"; $R + "/admission") | gsub("10\\.231\\."; "10.232.")
    elif type == "object" then map_values(fix) elif type == "array" then map(fix) else . end;
  fix | .name = "fcpi-restore"
  | .services |= with_entries(select(.key as $k | $keep | index($k)))
  | .services |= map_values(del(.ports) | .labels = ((.labels // {}) + {"fcpi.transient": "restore-test"})
      | (if .networks then .networks |= del(.egress) else . end)
      | (if .depends_on then .depends_on |= with_entries(select(.key as $k | $keep | index($k))) else . end))
  | .services["retrieval-service"].environment += {PI_WEBHOOK_DELIVERY: "suppressed", PI_PAID_DISPATCH_ENABLED: "false"}
  | .services["firecrawl-core"].environment += {DISABLE_WEBHOOK_DELIVERY: "true"}
  | .networks |= (del(.egress) | map_values(.name |= sub("^fcpi_"; "fcpi_r_") | .internal = true | .labels = {"fcpi.transient": "restore-test"}
      | .driver_opts["com.docker.network.bridge.name"] |= sub("^fcpi-"; "fcpi-r-") | .driver_opts["com.docker.network.bridge.gateway_mode_ipv4"] = "isolated"))' \
  >"$R/compose.json" || { finish FAIL "the restored compose file could not be rendered"; exit 1; }
t_up=$(now_s)
docker compose -p "$P" -f "$R/compose.json" up -d --wait --wait-timeout 600 >"$R/up.log" 2>&1; up=$?
check copy_started "$([ $up = 0 ] && echo true || echo false)" "compose up exit $up after $(( $(now_s) - t_up )) s"
[ $up = 0 ] || { finish FAIL "the isolated copy did not become healthy"; exit 1; }
nets=$(docker network ls -q --filter "label=com.docker.compose.project=$P" | xargs -r docker network inspect -f '{{.Name}} {{.Internal}}')
check networks_internal "$( [ -n "$nets" ] && ! grep -q ' false$' <<<"$nets" && echo true || echo false)" "$(tr '\n' ',' <<<"$nets")"
renv=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(docker ps -q --filter "label=com.docker.compose.project=$P" --filter label=com.docker.compose.service=retrieval-service)")
check side_effects_off "$(grep -qx PI_WEBHOOK_DELIVERY=suppressed <<<"$renv" && grep -qx PI_PAID_DISPATCH_ENABLED=false <<<"$renv" && echo true || echo false)" "webhook delivery suppressed, paid dispatch off, no egress network"
fi
# ---- 3. the requests (also: fcpi restore-test --check, against the running copy) ------------------------------------
META=$(cat "$ST/backup-meta.json" 2>/dev/null) || die "no restored copy at $R"
RUN_ID=$(jq -r .run <<<"$META")
rpg() { timeout 20 docker exec -i "$(docker ps -q --filter "label=com.docker.compose.project=$P" --filter label=com.docker.compose.service=nuq-postgres)" \
  psql -X -q -At -F '|' -U postgres -d postgres -c "$1" 2>/dev/null; }
hooks0=$(rpg "SELECT count(*) FILTER (WHERE state = 'DELIVERED') || '|' || coalesce(sum(attempts), 0) FROM fcpi_platform.webhook_event")

REG=$R/secrets/secrets/gateway/clients TOK=$R/secrets/secrets/clients
tokens=$(for f in "$TOK"/*.token; do [ -f "$f" ] && jq -cn --arg l "$(basename "$f" .token)" --arg t "$(cat "$f")" '{($l): $t}'; done | jq -sc 'add // {}')
principal_of() { awk -v l="$1" '$1 == l {print $2}' "$REG"; }
label_for() { awk -v p="$1" '$2 == p {print $1}' "$REG" | while read -r l; do [ -f "$TOK/$l.token" ] && { echo "$l"; break; }; done; }
other_than() { awk -v p="$1" '$2 != p && $1 !~ /^#/ && NF >= 4 {print $1}' "$REG" | while read -r l; do [ -f "$TOK/$l.token" ] && { echo "$l"; break; }; done; }
reqs='[]'
add() { reqs=$(jq -c --argjson r "$1" '. + [$r]' <<<"$reqs"); }
while read -r c; do
  [ -n "$c" ] || continue
  j=$(jq -r .job <<<"$c") l=$(jq -r .label <<<"$c") p=$(jq -r .path <<<"$c"); o=$(other_than "$(principal_of "$l")")
  add "$(jq -cn --arg id "result:$j" --arg p "$p" --arg t "$l" '{id:$id,method:"GET",path:$p,token:$t}')"
  [ -n "$o" ] && add "$(jq -cn --arg id "result-other:$j" --arg p "$p" --arg t "$o" '{id:$id,method:"GET",path:$p,token:$t}')"
done < <(jq -c '.canaries.results[]' <<<"$META")
while read -r c; do
  [ -n "$c" ] || continue
  add "$(jq -cn --arg id "inflight:$(jq -r .job <<<"$c")" --arg p "/platform/v1/jobs/$(jq -r .job <<<"$c")" --arg t "$(jq -r .label <<<"$c")" '{id:$id,method:"GET",path:$p,token:$t}')"
done < <(jq -c '.canaries.inflight[]' <<<"$META")
while read -r c; do
  [ -n "$c" ] || continue
  a=$(jq -r .id <<<"$c") pr=$(jq -r .principal <<<"$c"); l=$(label_for "$pr") o=$(other_than "$pr")
  [ -n "$l" ] && add "$(jq -cn --arg id "artifact:$a" --arg p "/platform/v1/artifacts/$a" --arg t "$l" '{id:$id,method:"GET",path:$p,token:$t,binary:true}')"
  [ -n "$o" ] && add "$(jq -cn --arg id "artifact-other:$a" --arg p "/platform/v1/artifacts/$a" --arg t "$o" '{id:$id,method:"GET",path:$p,token:$t,binary:true}')"
done < <(jq -c '.canaries.artifacts[]' <<<"$META")
add '{"id":"scrape","method":"POST","path":"/v2/scrape","token":"ops","body":{"url":"http://m1.fixture.fcpi.test:8080/static.html","formats":["markdown"]}}'
meta_mcp=$(jq -cn --arg v "$MODERN" '{"io.modelcontextprotocol/protocolVersion":$v,"io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{name:"fcpi-restore-test",version:"1"}}')
add "$(jq -cn --arg v "$MODERN" --argjson m "$meta_mcp" '{id:"mcp-list",method:"POST",path:"/mcp",token:"ops",headers:{"mcp-protocol-version":$v,"mcp-method":"tools/list"},body:{jsonrpc:"2.0",id:1,method:"tools/list",params:{_meta:$m}}}')"
add "$(jq -cn --arg v "$MODERN" --argjson m "$meta_mcp" '{id:"mcp-scrape",method:"POST",path:"/mcp",token:"ops",headers:{"mcp-protocol-version":$v,"mcp-method":"tools/call","mcp-name":"firecrawl_scrape"},
  body:{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"firecrawl_scrape",arguments:{url:"http://m1.fixture.fcpi.test:8080/static.html",formats:["markdown"]},_meta:$m}}}')"
gwimg=$(jq -r '.services["access-gateway"].image' "$R/compose.json")
plan=$(jq -cn --argjson t "$tokens" --argjson r "$reqs" '{base:"http://access-gateway:3300",host:"127.0.0.1:3380",tokens:$t,requests:$r}')
res=$(printf '%s' "$plan" | docker run -i --rm --name "$P-check" --network fcpi_r_access --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user 3380:3380 --label fcpi.transient=restore-test -v "$REPO/scripts/ops/restore-check.mjs:/check/restore-check.mjs:ro" --memory 128m --entrypoint node "$gwimg" /check/restore-check.mjs 2>&1)
one() { jq -c --arg id "$1" 'select(.id == $id)' <<<"$res" 2>/dev/null | head -1; }
all_ok=true n_res=0
while read -r c; do
  [ -n "$c" ] || continue
  j=$(jq -r .job <<<"$c") want=$(jq -r .data_sha256 <<<"$c")
  got=$(one "result:$j" | jq -cS '.body.data' | sha256sum | cut -c1-64); st=$(one "result:$j" | jq -r .status)
  ok=false; [ "$st" = 200 ] && [ "$got" = "$want" ] && ok=true; [ $ok = true ] || all_ok=false; n_res=$((n_res + 1))
  check "result_hash:$j" $ok "status $st, data sha256 ${got:0:12} against ${want:0:12}"
  os=$(one "result-other:$j" | jq -r '.status // empty'); [ -n "$os" ] && check "result_acl:$j" "$([ "$os" = 404 ] && echo true || echo false)" "another principal got $os"
done < <(jq -c '.canaries.results[]' <<<"$META")
check result_hashes "$([ $all_ok = true ] && [ $n_res -ge 1 ] && echo true || echo false)" "$n_res canary results"
while read -r c; do
  [ -n "$c" ] || continue
  j=$(jq -r .job <<<"$c"); r=$(one "inflight:$j")
  check "inflight_tracked:$j" "$([ "$(jq -r .status <<<"$r")" = 200 ] && echo true || echo false)" "receipt state $(jq -r '.body.job.state // "?"' <<<"$r") (was $(jq -r .state <<<"$c"))"
done < <(jq -c '.canaries.inflight[]' <<<"$META")
while read -r c; do
  [ -n "$c" ] || continue
  a=$(jq -r .id <<<"$c") want=$(jq -r .sha256 <<<"$c"); r=$(one "artifact:$a")
  check "artifact_hash:$a" "$([ "$(jq -r .status <<<"$r")" = 200 ] && [ "$(jq -r .body.sha256 <<<"$r")" = "$want" ] && echo true || echo false)" "status $(jq -r .status <<<"$r")"
  os=$(one "artifact-other:$a" | jq -r '.status // empty'); [ -n "$os" ] && check "artifact_acl:$a" "$([ "$os" = 404 ] && echo true || echo false)" "another principal got $os"
done < <(jq -c '.canaries.artifacts[]' <<<"$META")
r=$(one scrape); check rest_fixture_scrape "$([ "$(jq -r .status <<<"$r")" = 200 ] && jq -e '.body.data.markdown | contains("fcpi-m1-static-7f3a")' <<<"$r" >/dev/null 2>&1 && echo true || echo false)" "status $(jq -r .status <<<"$r")"
r=$(one mcp-list); check mcp_tools_list "$(jq -e '.status == 200 and (.body.result.tools | length) > 0' <<<"$r" >/dev/null 2>&1 && echo true || echo false)" "status $(jq -r .status <<<"$r")"
r=$(one mcp-scrape); check mcp_scrape "$(jq -e '.status == 200 and (.body.result.isError != true) and (.body.result | tostring | contains("fcpi-m1-static-7f3a"))' <<<"$r" >/dev/null 2>&1 && echo true || echo false)" "status $(jq -r .status <<<"$r")"
hooks1=$(rpg "SELECT count(*) FILTER (WHERE state = 'DELIVERED') || '|' || coalesce(sum(attempts), 0) FROM fcpi_platform.webhook_event")
check no_webhook_delivered "$([ -n "$hooks0" ] && [ "$hooks0" = "$hooks1" ] && echo true || echo false)" "delivered|attempts before $hooks0, after $hooks1"
if [ "$MODE" = check ]; then jq -c . <<<"$CHECKS"; jq -e 'all(.[]; .ok)' <<<"$CHECKS" >/dev/null; exit; fi
if jq -e 'all(.[]; .ok)' <<<"$CHECKS" >/dev/null; then finish PASS; else finish FAIL "a check failed"; exit 1; fi
