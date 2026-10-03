# Shared trusted proposal boundary. Existing tests, policy, authorization, routing,
# budgets, SSRF, provider dispatch and deployment remain read-only to the model.
incident_writable() {
 local tree=$1 rel=$2
 git -C "$tree" rev-parse --verify HEAD >/dev/null 2>&1 || return 1
 case "$rel" in
  services/access/src/changes.mjs|services/retrieval/src/quality.mjs) ;;
  services/access/test/*.test.mjs|services/retrieval/test/*.test.mjs)
   [[ ${rel##*/} != */* && ${rel#services/*/test/} != */* ]] || return 1
   git -C "$tree" cat-file -e "HEAD:$rel" 2>/dev/null && return 1 ;;
  *) return 1 ;;
 esac
 [[ /$rel/ != */.* && $rel != *$'\n'* ]] || return 1
 git -C "$tree" check-ignore -q -- "$rel" && return 1
 return 0
}
