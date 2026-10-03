#!/usr/bin/env bash
# Exercise the real privileged scripts in a disposable namespace. Fixed external
# authorities are replaced by recording stubs; no production command is run.
set -euo pipefail
[ "$(id -u)" = 0 ] || exit 2
R=/opt/firecrawl-pi
T=$(mktemp -d /var/lib/firecrawl-pi/m9-fixtures.XXXXXX)
trap '[[ $T = /var/lib/firecrawl-pi/m9-fixtures.* ]] && rm -rf -- "$T"' EXIT
mkdir -p "$T/repo/scripts/ops" "$T/repo/scripts/m9" "$T/state/incidents/control"/{requests,processed,grants,reports,dismissed} "$T/state/incidents"/{work,blocked} "$T/state/alerts" "$T/bin" "$T/etc/secrets/alerts" "$T/run" "$T/home/.claude" "$T/home/.local/bin"
cp "$R"/scripts/m9/incident-{prepare,control,agent,hook,paths,apply}.sh "$T/repo/scripts/m9/"
cp "$R/scripts/ops/notify-ntfy.sh" "$T/repo/scripts/ops/"
cp "$R/scripts/m9/incident-notice-actions.sh" "$T/repo/scripts/m9/"
# Only location literals are replaced. Logic under test is unchanged.
find "$T/repo" -type f -name '*.sh' -exec sed -i -e "s|/opt/firecrawl-pi|$T/repo|g" -e "s|/var/lib/firecrawl-pi|$T/state|g" -e "s|/etc/firecrawl-pi|$T/etc|g" -e "s|/home/danny|$T/home|g" {} +
cat >"$T/repo/scripts/ops/lib.sh" <<SHLIB
export PATH=$T/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=$T/repo STATE=$T/state RUND=$T/run
need_root() { [ "\$(id -u)" = 0 ]; }
die() { echo "fixture: \$*" >&2; exit 2; }
source_commit() { cat "\$REPO/.fcpi-source-commit"; }
now_s() { date +%s; }
write_atomic() { local t; t=\$(mktemp "\$1.XXXXXX"); cat >"\$t"; chmod "\$2" "\$t"; mv "\$t" "\$1"; }
put_obj() { printf '%s\\n' "\$3" | write_atomic "\$1" "\$2"; }
notice() { echo "\$*" >>$T/notices; }
cid() { echo fixture; }
hold_set() { :; }
hold_clear() { :; }
SHLIB
cat >"$T/bin/systemctl" <<SHSTUB
#!/bin/bash
case \$1 in list-units) [ ! -e $T/active ] || cat $T/active;; is-active) [ -e $T/active ];; *) echo "\$*" >>$T/systemd;; esac
SHSTUB
cat >"$T/bin/systemd-run" <<SHSTUB
#!/bin/bash
echo "\$*" >>$T/systemd
SHSTUB
cat >"$T/bin/docker" <<SHSTUB
#!/bin/bash
[ ! -e $T/docker-down ] || exit 1
case \$1 in inspect) echo sha256:fixture;; run) cat $T/proof;; *) echo "\$*" >>$T/docker;; esac
SHSTUB
chmod +x "$T/bin/"*
cat >"$T/bin/runuser" <<'SHSTUB'
#!/bin/bash
exit 2
SHSTUB
chmod +x "$T/bin/runuser"
export GIT_CONFIG_GLOBAL=/home/danny/.gitconfig
base=$(cat "$R/.fcpi-source-commit"); echo "$base" >"$T/repo/.fcpi-source-commit"
git clone --quiet --bare /var/lib/firecrawl-pi/incidents/source.git "$T/state/incidents/source.git"
export PATH="$T/bin:$PATH"
pass=0
ok() { pass=$((pass+1)); echo "PASS $1"; }
reject() { if "$@" >"$T/out" 2>&1; then cat "$T/out"; echo 'unexpected acceptance' >&2; exit 1; fi; }
mkdir -p "$T/repo/deploy"
echo fixture >"$T/home/.local/bin/claude"
h=$(sha256sum "$T/home/.local/bin/claude"|cut -c1-64)
jq -n --arg h "$h" '{host_packages:{claude_code:{binary_sha256:$h}}}' >"$T/repo/deploy/versions.lock.json"
p="$T/repo/scripts/m9/incident-prepare.sh"
# Missing OAuth and mismatched binary cannot leave a permanently stuck worktree.
reject bash "$p" 11111111
grep -q "subscription refresh failed" "$T/out"
[ ! -e "$T/state/incidents/work/11111111" ]; ok 'missing OAuth checked before worktree'
mkdir -p "$T/repo/deploy"
printf '{"claudeAiOauth":{"accessToken":"synthetic-fixture-only","subscriptionType":"max","expiresAt":%s}}\n' "$(( $(date +%s%3N)+1000000 ))" >"$T/home/.claude/.credentials.json"
echo fixture >"$T/home/.local/bin/claude"
echo '{"host_packages":{"claude_code":{"binary_sha256":"wrong"}}}' >"$T/repo/deploy/versions.lock.json"
reject bash "$p" 11111111
[ ! -e "$T/state/incidents/work/11111111" ]; ok 'mismatched binary checked before worktree'
h=$(sha256sum "$T/home/.local/bin/claude"|cut -c1-64)
jq -n --arg h "$h" '{host_packages:{claude_code:{binary_sha256:$h}}}' >"$T/repo/deploy/versions.lock.json"
# UTC ledger caps include launches/resumes despite any worktree mtime.
for _ in 1 2 3 4; do jq -cn --arg day "$(date -u +%F)" '{day:$day,incident_id:"22222222"}' >>"$T/state/incidents/launches.jsonl"; done
reject env TZ=America/New_York bash "$p" 11111111
[ ! -e "$T/state/incidents/work/11111111" ]; ok 'four UTC launches block fifth'
rm "$T/state/incidents/launches.jsonl"
# Large active-unit output must not disappear through grep -q / pipefail.
yes 'fcpi-incident-abcdef01.service' | head -10000 >"$T/active" || true
reject bash "$p" 11111111
[ ! -e "$T/state/incidents/work/11111111" ]; ok 'active agent blocks another launch'
rm "$T/active"
# Stale signed root records cannot reach tests/build/deploy.
W=$T/state/incidents/work/33333333
mkdir -p "$W/tree" "$W/run/auth"
echo "${base/????????????????????????????????????????/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}" >"$W/base-sha"
echo '{"state":"EXECUTION_STARTED","incident_id":"33333333","base_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' >"$T/state/incidents/control/processed/$(printf '1%.0s' {1..32}).json"
reject bash "$T/repo/scripts/m9/incident-apply.sh" 33333333 "$(printf '1%.0s' {1..32})"
[ ! -e "$T/docker" ]; ok 'stale apply cannot execute tests or deployment'
# Inactive empty/failed resume is explicit, auth is erased, no old result harvest.
echo "$base" >"$W/base-sha"; date +%s >"$W/launched-at"
echo token >"$W/run/auth/access-token"
echo '{"old":true}' >"$W/run/result.previous.json"
echo 'FCPI_INCIDENT_ENABLED=true' >"$T/etc/incidents.env"
echo '{}' >"$T/state/alerts/state.json"
bash "$T/repo/scripts/m9/incident-control.sh" tick
[ -s "$W/failed.json" ] && [ ! -e "$W/run/auth/access-token" ] && [ ! -e "$W/harvested.json" ]; ok 'empty failed resume is terminal and removes auth'
# Notification delivery still occurs when the action signer cannot find Docker/origin.
cat >"$T/bin/curl" <<SHSTUB
#!/bin/bash
cat >$T/published.json
SHSTUB
chmod +x "$T/bin/curl"
echo synthetic-not-a-production-topic >"$T/etc/secrets/alerts/ntfy_topic"
touch "$T/docker-down"
# Notifier's fixed PATH intentionally excludes arbitrary environment. Replace only
# that path for the recording curl authority in this disposable copy.
sed -i "s|PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|PATH=$T/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin|" "$T/repo/scripts/ops/notify-ntfy.sh"
printf '{"kind":"opened","incident":"core_unhealthy","incident_id":"44444444"}' | bash "$T/repo/scripts/ops/notify-ntfy.sh"
jq -e '.actions==[] and (.tags|index("incident_opened")) and (.message|contains("44444444"))' "$T/published.json" >/dev/null; ok 'outage notice survives missing action infrastructure'
# Exact shared proposal boundary includes no ignored file or existing gating test.
git --git-dir="$T/state/incidents/source.git" worktree add --quiet --detach "$T/candidate" "$base"
. "$T/repo/scripts/m9/incident-paths.sh"
incident_writable "$T/candidate" services/retrieval/src/quality.mjs; ok 'named bounded source file permitted'
for rel in services/retrieval/src/ssrf.mjs services/retrieval/src/quality/node_modules/x.mjs services/access/test/incidents.test.mjs services/access/src/auth.mjs; do
 if incident_writable "$T/candidate" "$rel"; then echo "bad boundary $rel" >&2; exit 1; fi
done
ok 'policy, ignored nested bytes and existing tests denied'
incident_writable "$T/candidate" services/retrieval/test/new-incident.test.mjs; ok 'new direct unit test permitted'
echo "RESULT pass=$pass fail=0 source=$base"
