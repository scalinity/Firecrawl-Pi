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
find "$T/repo" -type f -name '*.sh' -exec sed -i -e "s|/var/lib/firecrawl-pi|$T/state|g" -e "s|/etc/firecrawl-pi|$T/etc|g" -e "s|/home/danny|$T/home|g" -e "s|/opt/firecrawl-pi|$T/repo|g" {} +
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
grep -q "subscription refresh failed" "$T/out" || { cat "$T/out"; exit 1; }
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

# A standalone candidate exposes its own Git metadata to the unprivileged agent;
# the root-only source mirror is never needed by the writable-path hook.
W=$T/state/incidents/work/55555555
chmod 0711 "$T"
mkdir -p "$W/run" "$T/repo/scripts/m1" "$T/repo/deploy/host"
git clone --quiet --no-hardlinks "$T/state/incidents/source.git" "$W/tree"
git -C "$W/tree" switch --quiet --detach "$base"
git -C "$W/tree" switch --quiet -c codex/incident-55555555
chown -R danny:danny "$W/tree"
runuser_real=$(command -v /usr/sbin/runuser)
"$runuser_real" -u danny -- git -C "$W/tree" rev-parse --verify HEAD >/dev/null
ok 'standalone candidate metadata readable without root mirror access'
chown -R root:root "$W/tree"
printf '\n// Synthetic incident regression.\n' >>"$W/tree/services/retrieval/src/quality.mjs"
git -C "$W/tree" diff --binary >"$W/patch.diff"
GIT_INDEX_FILE="$W/test.index" git -C "$W/tree" read-tree "$base"
GIT_INDEX_FILE="$W/test.index" git -C "$W/tree" add services/retrieval/src/quality.mjs
tree=$(GIT_INDEX_FILE="$W/test.index" git -C "$W/tree" write-tree)
git -C "$W/tree" archive "$tree" >"$W/candidate.tar"
mkdir "$W/tested-source"; tar -xf "$W/candidate.tar" -C "$W/tested-source"
printf '%s\n' "$base" >"$W/base-sha"; echo 'fixture tests passed' >"$W/tests.txt"
p=$(sha256sum "$W/patch.diff"|cut -c1-64) t=$(sha256sum "$W/tests.txt"|cut -c1-64) a=$(sha256sum "$W/candidate.tar"|cut -c1-64)
jq -n --arg tree "$tree" --arg a "$a" '{test_exit:0,changed_files:1,tested_tree:$tree,archive_sha:$a}' >"$W/harvested.json"
nonce=$(printf '5%.0s' {1..32})
jq -n --arg base "$base" --arg p "$p" --arg t "$t" '{state:"EXECUTION_STARTED",incident_id:"55555555",action:"apply_fix",base_sha:$base,patch_sha:$p,tests_sha:$t}' >"$T/state/incidents/control/processed/$nonce.json"
# Fixed root authorities are recording stubs in this disposable namespace.
for script in incident-tests.sh; do printf '#!/bin/bash\nexit 0\n' >"$T/repo/scripts/m9/$script"; done
for script in backup.sh restore-test.sh; do printf '#!/bin/bash\nexit 0\n' >"$T/repo/scripts/ops/$script"; done
printf '#!/bin/bash\nexit 0\n' >"$T/repo/deploy/host/fcpi-data-check.sh"
cat >"$T/repo/scripts/m1/deploy.sh" <<DEPLOY
#!/bin/bash
sha=\$(git -C "\$2" rev-parse HEAD)
echo "\$sha" >>$T/releases
echo "\$sha" >$T/repo/.fcpi-source-commit
# A partially applied candidate must return to the paired previous release.
[ "\$sha" = "$base" ]
DEPLOY
cat >"$T/repo/scripts/ops/verify.sh" <<VERIFY
#!/bin/bash
[ "\$(cat $T/repo/.fcpi-source-commit)" = "$base" ]
VERIFY
cat >"$T/bin/docker" <<DOCKER
#!/bin/bash
case \$1 in
 inspect) echo sha256:fixture;;
 image) [ "\$2" != inspect ] || echo sha256:fixture;;
 run) echo fixture >>$W/tree/deploy/compose.yaml;;
 *) echo "\$*" >>$T/docker;;
esac
DOCKER
printf '#!/bin/bash\nexit 0\n' >"$T/bin/sleep"
chmod +x "$T/bin/docker" "$T/bin/sleep"
reject bash "$T/repo/scripts/m9/incident-apply.sh" 55555555 "$nonce"
jq -e '.state=="ROLLED_BACK" and .exit_code!=0' "$T/state/incidents/control/processed/$nonce.json" >/dev/null || { cat "$T/out"; cat "$T/state/incidents/control/processed/$nonce.json"; exit 1; }
[ "$(cat "$T/repo/.fcpi-source-commit")" = "$base" ]
[ "$(wc -l <"$T/releases")" = 2 ]
ok 'partial candidate cutover automatically returns to paired accepted release'
# Explicit rollback failure must not recursively attempt a second rollback.
current=$(git -C "$W/tree" rev-parse codex/incident-55555555)
echo "$current" >"$T/repo/.fcpi-source-commit"
jq -n --arg b "$base" --arg c "$current" '{previous_sha:$b,candidate_sha:$c}' >"$W/release.json"
jq --arg c "$current" '.state="EXECUTION_STARTED" | .action="rollback" | .base_sha=$c' "$T/state/incidents/control/processed/$nonce.json" >"$T/proof"
cp "$T/proof" "$T/state/incidents/control/processed/$nonce.json"
printf '#!/bin/bash\necho failed >>%s\nexit 1\n' "$T/rollback-calls" >"$T/repo/scripts/m1/deploy.sh"
reject bash "$T/repo/scripts/m9/incident-apply.sh" 55555555 "$nonce" --rollback
[ "$(wc -l <"$T/rollback-calls")" = 1 ]
jq -e '.state=="ROLLBACK_FAILED"' "$T/state/incidents/control/processed/$nonce.json" >/dev/null
ok 'failed explicit rollback is terminal without recursive retry'
echo "RESULT pass=$pass fail=0 source=$base"
