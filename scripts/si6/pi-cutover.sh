#!/usr/bin/env bash
# The search intelligence cutover on the Pi, and its rollbacks (docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md §26, SI6), in the
# order spec §27's upgrade procedure gives: a hold first (new work waits at the gateway, and the tick does not judge the
# recreated services as incidents), a bounded drain, then, once no job is in flight and no metered call holds a live
# reservation, every pin checked to resolve, the retrieval schema applied (additive and idempotent, scripts/m2/pi-retrieval-db.sh),
# the services recreated with the deployed commit's pins, and the release recorded (fcpi release, which fcpi rollback --plan
# anchors on). A reservation older than the longest call the deployed policies allow (the residential hold, the crawl, batch
# and extract deadlines) belongs to no live call: it is listed, never waited for. --rollback proceeds after the drain whatever
# is still in flight, recording it, so a failed release cannot block its own rollback. The services default to the four the
# release changes. Run after scripts/m1/deploy.sh has deployed the commit whose pins name the images to run:
#   ssh … 'bash -s' < scripts/si6/pi-cutover.sh                            (ROLLOUT.md runs it detached on the Pi)
#   ssh … 'bash -s -- --rollback [service …]' < scripts/si6/pi-cutover.sh
# Refuses (exit 2) while work is in flight or when a pin does not resolve; fails (exit 1) when the recreate does. Every command
# has its own stdin, since bash -s reads this script from stdin; the caller checks the end marker, not only the exit status.
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/firecrawl-pi
mode=cutover
if [ "${1:-}" = --rollback ]; then mode=rollback; shift; fi
services=("$@")
[ ${#services[@]} -gt 0 ] || services=(firecrawl-core retrieval-service access-gateway mcp-gateway)
for s in "${services[@]}"; do [[ $s =~ ^(firecrawl-core|retrieval-service|access-gateway|mcp-gateway)$ ]] || { echo "unknown service $s" >&2; exit 2; }; done
sec() { printf '### %s\n' "$1"; }
C=(sudo -n docker compose -p fcpi -f "$REPO/deploy/compose.yaml")
PG=$(sudo -n docker ps -q --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=nuq-postgres </dev/null)
[ -n "$PG" ] || { echo "nuq-postgres is not running" >&2; exit 1; }
q() { sudo -n docker exec -i "$PG" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X -At; }

sec meta
echo "utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) deployed_commit=$(cat $REPO/.fcpi-source-commit) mode=$mode services=${services[*]}"

sec hold
sudo -n "$REPO/scripts/fcpi" hold cutover 1800 >/dev/null </dev/null
trap 'sudo -n "$REPO/scripts/fcpi" hold cutover --clear >/dev/null </dev/null || true' EXIT
echo "hold=cutover seconds=1800"

sec quiet
ceiling=$(jq -n --slurpfile e "$REPO/deploy/policies/egress.json" --slurpfile c "$REPO/deploy/policies/capabilities.json" \
  '[$e[0].residential.holdMaxMinutes, $c[0].limits.proxy.holdMinutes, $c[0].limits.crawl.deadlineMinutes, $c[0].limits.batch.deadlineMinutes, $c[0].limits.extract.deadlineMinutes] | map(select(type == "number")) | max' </dev/null)
[[ $ceiling =~ ^[0-9]+$ ]] || { echo "end_marker=refused reason=no_call_ceiling"; exit 2; }
echo "call_ceiling_minutes=$ceiling"
# Up to five minutes for admitted work to finish under the hold.
for i in $(seq 30); do
  jobs=$(echo "SELECT count(*) FROM fcpi_platform.job WHERE state IN ('RECEIVED', 'SUBMITTING', 'SUBMISSION_UNCERTAIN', 'QUEUED', 'RUNNING');" | q)
  held=$(echo "SELECT count(*) FROM fcpi_retrieval.budget_reservation WHERE state = 'RESERVED' AND created_at > now() - interval '$ceiling minutes';" | q)
  if [ "$jobs" = 0 ] && [ "$held" = 0 ]; then break; fi
  [ "$i" = 30 ] || sleep 10
done
echo "in_flight_jobs=$jobs live_reserved_rows=$held drain_rounds=$i"
echo "SELECT kind, count(*), min(created_at) FROM fcpi_retrieval.budget_reservation WHERE state = 'RESERVED' GROUP BY kind ORDER BY kind;" | q | sed 's/^/reserved_by_kind=/'
if [ "$jobs" != 0 ] || [ "$held" != 0 ]; then
  if [ "$mode" = cutover ]; then echo "end_marker=refused reason=work_in_flight"; exit 2; fi
  echo "rollback_proceeds in_flight_jobs=$jobs live_reserved_rows=$held"
fi

sec pins
for s in "${services[@]}"; do
  # The service's own image: `config --images <service>` also lists the images of everything it depends on (five lines for the core), which is
  # no reference at all to `docker image inspect`.
  ref=$("${C[@]}" config --format json </dev/null | jq -r --arg s "$s" '.services[$s].image // empty')
  [ -n "$ref" ] && [ "$(printf '%s' "$ref" | grep -c "")" = 1 ] || { echo "end_marker=refused reason=no_single_image service=$s"; exit 2; }
  if ! sudo -n docker image inspect -f "$s pin=$ref resolves" "$ref" </dev/null; then echo "end_marker=refused reason=pin_unresolved service=$s"; exit 2; fi
done

sec schema
bash "$REPO/scripts/m2/pi-retrieval-db.sh" </dev/null | sed 's/^### /### retrieval_db_/'

sec recreate
set +e
"${C[@]}" up -d --no-deps --wait --wait-timeout 900 --force-recreate "${services[@]}" </dev/null 2>&1
rc=$?
set -e
echo "compose_exit=$rc"

sec state
for s in "${services[@]}"; do
  id=$(sudo -n docker ps -aq --filter label=com.docker.compose.project=fcpi --filter label=com.docker.compose.service=$s </dev/null | head -1)
  if [ -n "$id" ]; then sudo -n docker inspect "$id" --format "$s image={{.Image}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" </dev/null
  else echo "$s state=absent"; fi
done
echo "search_profile=$(jq -r '.searching.profile // "legacy"' "$REPO/deploy/policies/budget.json" </dev/null)"
[ "$rc" = 0 ] || { echo "end_marker=failed reason=compose_exit_$rc"; exit 1; }

sec release
sudo -n "$REPO/scripts/fcpi" release </dev/null
echo "end_marker=reached utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
