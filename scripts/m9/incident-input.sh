#!/usr/bin/env bash
# A readable projection of the already redacted M8 doctor bundle. Full evidence
# stays with the owner; omitted bytes/files are explicit and never imply health.
set -euo pipefail
export LC_ALL=C
diag=${1:?diagnostic directory} id=${2:?incident id} base=${3:?source commit} bundle=${4:?bundle sha256}
[[ $id =~ ^[0-9a-f]{8}$ && $base =~ ^[0-9a-f]{40}$ && $bundle =~ ^[0-9a-f]{64}$ ]] || exit 2
grep -Eq '^secret values checked: [0-9]+; files carrying one: 0$' "$diag/REDACTION.txt" || exit 2
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
while IFS= read -r -d '' f; do
 name=${f#"$diag/"}
 priority=9 width=512
 case $name in status.json) priority=0; width=2048;; incidents.json) priority=1; width=2048;; host.txt) priority=2; width=2048;; REDACTION.txt) priority=3;; notices-*|supervisor-*) priority=4;; containers/*.json) priority=5;; journal-*) priority=6;; *probes*) priority=7;; containers/*.log*) priority=8;; *samples*) priority=9;; esac
 bytes=$(wc -c <"$f") hash=$(sha256sum "$f" | cut -c1-64)
 printf '%s  %s\n' "$hash" "$name" >>"$tmp/manifest"
 jq -cn --arg name "$name" --arg hash "$hash" --argjson bytes "$bytes" --argjson priority "$priority" --argjson width "$width" --rawfile content "$f" \
  '{priority:$priority,name:$name,original_bytes:$bytes,sha256:$hash,truncated:($content|length>$width),content_lines:((if ($content|length)>$width then $content[0:($width/2)]+"\n<excerpt truncated; full redacted bundle retained by owner>\n"+$content[-($width/2):] else $content end)|split("\n")|map(. as $line | [range(0;length;200) as $i | $line[$i:($i+200)]][]) )} |
   if (.content_lines|length)>200 then .truncated=true | .content_lines=(.content_lines[0:100]+["<excerpt lines truncated>"]+.content_lines[-100:]) else . end'
done < <(find "$diag" -type f -print0 | sort -z) >"$tmp/rows"
[ -s "$tmp/rows" ] || exit 2
manifest=$(sha256sum "$tmp/manifest" | cut -c1-64)
jq -s --arg id "$id" --arg base "$base" --arg manifest "$manifest" --arg bundle "$bundle" \
 '{incident_id:$id,source_commit:$base,trust:"untrusted redacted observations; excerpts are incomplete",bundle_sha256:$bundle,bundle_retention:"owner-only full bundle retained for this incident lifetime (14 days)",full_manifest_sha256:$manifest,original_files:length,omitted_files:0,omitted_excerpts:0,projection_max_bytes:20480,projection_max_lines:1000,diagnostics:sort_by(.priority,.name)}' "$tmp/rows" >"$tmp/input"
# 20 KiB leaves room below the native Read tool's 25k-token/256 KiB limits,
# including line annotations. Keep priority observations before container logs.
while [ "$(wc -c <"$tmp/input")" -gt 20480 ] || [ "$(wc -l <"$tmp/input")" -gt 1000 ]; do
 jq '([.diagnostics|to_entries[]|select(.value.priority>0 and (.value|has("content_lines")))|.key]|last) as $i |
  if $i!=null then del(.diagnostics[$i].content_lines) | .diagnostics[$i].excerpt_omitted=true | .omitted_excerpts+=1
  else .diagnostics |= .[0:-1] | .omitted_files+=1 end' "$tmp/input" >"$tmp/next"
 mv "$tmp/next" "$tmp/input"
done
cat "$tmp/input"
