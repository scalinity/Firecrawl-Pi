#!/usr/bin/env bash
# Trusted test/patch collector, not an agent tool. Tests run without network,
# host secrets, Docker socket, root, writable source or unbounded resources.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/../ops/lib.sh"
need_root
. "$REPO/scripts/m9/incident-paths.sh"
id=${1:?incident id}; [[ $id =~ ^[0-9a-f]{8}$ ]] || exit 2
W=$STATE/incidents/work/$id
systemctl is-active --quiet "fcpi-incident-$id.service" && die 'agent still running'
# Freeze the candidate before its trusted tests/hash. The model cannot edit a
# proposal after the phone grant was issued.
chown -R root:root "$W/tree"
base=$(cat "$W/base-sha")
[ "$(git -C "$W/tree" rev-parse HEAD)" = "$base" ] || die 'incident base moved'
# Reject ignored bytes, including nested node_modules, before hashing/testing.
[ -z "$(git -C "$W/tree" ls-files --others --ignored --exclude-standard)" ] || die 'ignored bytes in candidate'
while IFS= read -r -d '' p; do
 incident_writable "$W/tree" "$p" || die 'unexpected incident file'
 git -C "$W/tree" add -N -- "$p"
done < <(git -C "$W/tree" ls-files --others --exclude-standard -z)
paths=()
while IFS= read -r -d '' p; do
 incident_writable "$W/tree" "$p" || die 'incident patch changes protected code or existing tests'
 [ -f "$W/tree/$p" ] && [ ! -L "$W/tree/$p" ] || die 'only ordinary files allowed'
 paths+=("$p")
done < <(git -C "$W/tree" diff --name-only -z)
git -C "$W/tree" diff --binary >"$W/patch.diff"
[ "$(stat -c %s "$W/patch.diff")" -le 262144 ] || die 'patch exceeds 256 KiB'
# Literal-secret scan of BOTH diagnosis and patch. The trusted bundle's positives
# were checked before launch; model output is checked again before it is shared.
pat=$(mktemp "$RUND/incident-secret.XXXXXX"); chmod 0600 "$pat"
trap 'rm -f "$pat"' EXIT
find /etc/firecrawl-pi/secrets -type f -size -8k -print0 | xargs -0 -r awk 1 | awk 'length($0)>=12' >"$pat"
px=$(mktemp "$RUND/incident-secret-parts.XXXXXX")
{ grep -Eo '://[^:/@]*:[^@]+@' "$pat" | sed -E 's#^://[^:]*:##; s#@$##'
  grep -v '://' "$pat" | grep : | sed -E 's/^[^:]*://'
  grep -E '^[^=]+=' "$pat" | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]+$//'
  grep -v '://' "$pat" | grep : | while IFS= read -r l; do printf '%s' "$l" | base64 -w0; echo; done
} | awk 'length($0)>=8' >"$px" || true
cat "$px" >>"$pat"; rm -f "$px"
[ "$(wc -l <"$pat")" -ge 5 ] || die 'secret scan has no adequate positive set'
if grep -qF -f "$pat" "$W/patch.diff" "$W/run/result.json"; then die 'incident output contains a real secret; report withheld'; fi
# Test exactly the tracked candidate tree that will enter the image archive.
export GIT_INDEX_FILE="$W/candidate.index"
git -C "$W/tree" read-tree "$base"
for p in "${paths[@]}"; do git -C "$W/tree" add -- "$p"; done
tested_tree=$(git -C "$W/tree" write-tree)
unset GIT_INDEX_FILE
git -C "$W/tree" archive "$tested_tree" >"$W/candidate.tar"
install -d -m 0755 "$W/tested-source"
tar -xf "$W/candidate.tar" -C "$W/tested-source"
touch "$W/tests.txt"
test_rc=0
if [ ${#paths[@]} -gt 0 ]; then
 if ! bash "$REPO/scripts/m9/incident-tests.sh" "$W/tested-source" >"$W/tests.txt" 2>&1; then test_rc=1; fi
fi
patch_sha=$(sha256sum "$W/patch.diff" | cut -c1-64); tests_sha=$(sha256sum "$W/tests.txt" | cut -c1-64)
jq -n --arg id "$id" --arg base "$base" --arg patch "$patch_sha" --arg tests "$tests_sha" --arg tree "$tested_tree" --arg archive "$(sha256sum "$W/candidate.tar"|cut -c1-64)" --argjson rc "$test_rc" --argjson changed "${#paths[@]}" \
 --slurpfile result "$W/run/result.json" '{schema:"fcpi.incident-report/v1",incident_id:$id,base_sha:$base,patch_sha:$patch,tests_sha:$tests,test_exit:$rc,changed_files:$changed,tested_tree:$tree,archive_sha:$archive,diagnosis:$result[0].structured_output,
 subscription_usage:{api_equivalent_estimate_usd:$result[0].total_cost_usd,invoiced_usd:null},state:(if $changed==0 then "DIAGNOSIS_ONLY" elif $rc==0 then "AWAITING_OWNER_APPROVAL" else "TESTS_FAILED" end)}' \
 | write_atomic "$W/harvested.json" 0640
notice diagnosis_ready "incident_agent:$id" "$(jq -c '{state,test_exit,changed_files,patch_sha,tests_sha}' "$W/harvested.json")" "$(now_s)" "$id"
if [ "$test_rc" = 0 ] && [ ${#paths[@]} -gt 0 ]; then
 notice approval_required "incident_agent:$id" "$(jq -c '{state,test_exit,changed_files,patch_sha,tests_sha}' "$W/harvested.json")" "$(now_s)" "$id"
fi
