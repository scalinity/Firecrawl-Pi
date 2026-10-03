#!/usr/bin/env bash
# Fixed privileged verb, reached only through a twice-verified phone approval.
# No schema/data/policy changes: only a frozen, tested source patch, rebuilt from
# trusted pinned Dockerfiles. Source deployment is M1's existing archive pipeline.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/../ops/lib.sh"
need_root
id=${1:?}; nonce=${2:?}; [[ $id =~ ^[0-9a-f]{8}$ && $nonce =~ ^[0-9a-f]{32}$ ]] || exit 2
W=$STATE/incidents/work/$id C=$STATE/incidents/control
exec 9>"$STATE/incidents/deploy.lock"; flock -n 9 || die 'another incident deployment is active'
g=$(cat "$C/processed/$nonce.json")
[ "$(jq -r .state <<<"$g")" = EXECUTION_STARTED ] && [ "$(jq -r .incident_id <<<"$g")" = "$id" ] || die 'no verified execution record'
[ "$(jq -r .base_sha <<<"$g")" = "$(source_commit)" ] || die 'approved base changed'
[ "$(stat -c %U "$W/tree")" = root ] || die 'candidate is not frozen'
systemctl is-active --quiet "fcpi-incident-$id.service" && die 'agent still active'
[ "$(jq -r .patch_sha <<<"$g")" = "$(sha256sum "$W/patch.diff" | cut -c1-64)" ] && [ "$(jq -r .tests_sha <<<"$g")" = "$(sha256sum "$W/tests.txt" | cut -c1-64)" ] || die 'approved patch/test binding changed'
export GIT_CONFIG_GLOBAL=/home/danny/.gitconfig
base=$(cat "$W/base-sha")
if [ "${3:-}" != --rollback ]; then
 [ "$base" = "$(source_commit)" ] || die 'proposal base changed; a new investigation and approval are required'
fi
if [ "${3:-}" = --rollback ]; then
 [ "$(jq -r .action <<<"$g")" = rollback ] && [ -s "$W/release.json" ] || die 'no approved rollback release'
 [ "$(source_commit)" = "$(jq -r .candidate_sha "$W/release.json")" ] || die 'release has moved'
 git -C "$W/tree" switch --detach "$base" >/dev/null
else
 [ "$(jq -r .action <<<"$g")" = apply_fix ] && [ "$(jq -r .test_exit "$W/harvested.json")" = 0 ] && [ "$(jq -r .changed_files "$W/harvested.json")" -gt 0 ] || die 'no tested approved patch'
 [ "$(git -C "$W/tree" rev-parse HEAD)" = "$base" ] || die 'candidate base moved'
 [ "$(git -C "$W/tree" diff --binary | sha256sum | cut -c1-64)" = "$(jq -r .patch_sha <<<"$g")" ] || die 'frozen source changed'
 # Trusted tests run again immediately before creating an executable release.
 bash "$REPO/scripts/m9/incident-tests.sh" "$W/tree" >"$W/predeploy-tests.txt" 2>&1
 while IFS= read -r -d '' p; do git -C "$W/tree" add -- "$p"; done < <(git -C "$W/tree" diff --name-only -z)
 git -C "$W/tree" -c core.hooksPath=/dev/null commit -m "Fix incident $id with owner-approved tested patch" >/dev/null
 code=$(git -C "$W/tree" rev-parse HEAD)
 # Only approved tracked bytes enter Docker COPY; the mutable tree is not a build context.
 install -d -m 0755 "$W/build-context"
 git -C "$W/tree" archive "$code" | tar -xf - -C "$W/build-context"
 # Both bounded services are rebuilt; no browser/upstream/database image changes.
 for component in access retrieval; do
  tag=access-gateway; [ "$component" != retrieval ] || tag=retrieval
  timeout 600 docker buildx build --platform linux/arm64 --provenance=false --sbom=false --build-arg "FCPI_SOURCE_COMMIT=$code" --load -t "fcpi/$tag:incident-$id" "$W/build-context/services/$component" >"$W/build-$component.txt" 2>&1
 done
 access=$(docker image inspect "fcpi/access-gateway:incident-$id" -f '{{.Id}}')
 retrieval=$(docker image inspect "fcpi/retrieval:incident-$id" -f '{{.Id}}')
 image=$(docker inspect -f '{{.Image}}' "$(cid access-gateway)")
 docker run --rm --label fcpi.transient=incident-release --network none --read-only --user 0:0 --cgroup-parent fcpi.slice --cap-drop ALL --security-opt no-new-privileges --memory 128m --memory-swap 128m --pids-limit 32 -v "$W/tree:/tree" -v "$REPO:/repo:ro" "$image" node /repo/scripts/m9/incident-pin.mjs "$access" "$retrieval" "$code"
 git -C "$W/tree" add -- deploy/compose.yaml deploy/versions.lock.json
 git -C "$W/tree" -c core.hooksPath=/dev/null commit -m "Pin native images for approved incident $id" >/dev/null
 candidate=$(git -C "$W/tree" rev-parse HEAD)
 jq -cn --arg base "$base" --arg c "$candidate" --arg code "$code" '{previous_sha:$base,candidate_sha:$c,image_source_sha:$code,state:"PREPARED"}' | write_atomic "$W/release.json" 0600
 # Current platform remains active unless the encrypted pre-change backup passes.
 bash "$REPO/scripts/ops/backup.sh" >"$W/predeploy-backup.txt" 2>&1
 bash "$REPO/scripts/ops/restore-test.sh" >"$W/predeploy-restore.txt" 2>&1
fi
hold_set incident-deploy 900
trap 'hold_clear incident-deploy' EXIT
rc=0
bash "$REPO/scripts/m1/deploy.sh" --local "$W/tree" >"$W/deploy.txt" 2>&1 || rc=$?
if [ "$rc" = 0 ]; then
 bash "$REPO/deploy/host/fcpi-data-check.sh" >>"$W/deploy.txt" 2>&1 || rc=$?
fi
if [ "$rc" = 0 ]; then
 docker compose -p fcpi -f "$REPO/deploy/compose.yaml" up -d --no-build --no-deps access-gateway retrieval-service >>"$W/deploy.txt" 2>&1 || rc=$?
fi
# Fixed functional/health probe after bounded startup, not an arbitrary model command.
if [ "$rc" = 0 ]; then
 sleep 20
 bash "$REPO/scripts/ops/verify.sh" functional >"$W/postdeploy-tests.txt" 2>&1 || rc=$?
fi
if [ "$rc" != 0 ]; then
 notice deployment_failed "incident_agent:$id" '{"state":"DEPLOYMENT_FAILED","rollback_requires_owner_approval":true}' "$(now_s)" "$id"
 exit "$rc"
fi
notice cleared "incident_agent:$id" '{"state":"APPROVED_RELEASE_VERIFIED"}' "$(now_s)" "$id"
