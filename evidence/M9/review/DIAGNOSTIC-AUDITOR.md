## Summary

I read the 8 listed files, the new untracked `scripts/m9/incident-input.sh` and its test, and the callers around them: `scripts/m9/incident-agent.sh` and the part of `scripts/ops/doctor.sh` that writes `REDACTION.txt` and keeps bundles. The delta does what it claims:

- **Hook:** `StructuredOutput` is allowed only when the tool name matches exactly and `incident_id` equals the incident directory's 8-hex basename. That branch returns before any file-path handling, so it adds no file, shell or network authority. Read, Edit and Write still go through the same unchanged checks.
- **Projection:** the input is built only from the doctor bundle, which has already passed its secret scan and been redacted. Every excerpt is a substring of a scanned file, so nothing new is exposed. Each row records the original byte count and SHA-256 of the full file, and the total output is capped at 20480 bytes.
- **Evidence check:** `BindReadOnlyPaths` is now pinned to the exact `source:target:rbind` value.

I found no reachable path to secrets, writes outside the worktree, command execution or network access. There are two warnings about how complete the evidence is.

## Critical Issues

None

## Warnings

1. **The newest part of the most important files may be invisible to the model** (`scripts/m9/incident-input.sh:13`, `:16`, `:20-21`).
   - `status.json`, `incidents.json` and `host.txt` get a 2048-character excerpt. jq `length` counts characters, not bytes, and the excerpt is written as one JSON string on a single pretty-printed line.
   - With the indentation, the `"content_excerpt": "` key, the truncation marker (about 60 characters) and escaping (`\n` takes 2 characters, control characters take 6), that line is always well over 2000 characters.
   - The native Read tool's documented behaviour is to cut off lines longer than 2000 characters. If the pinned binary does this, the model sees the head of the excerpt but not the truncation marker or the tail half, which is usually the newest status. It is also not told that anything is missing.
   - The 20 KiB file cap only fixes the earlier whole-file Read failure, not this per-line limit.
   - The test only checks the parsed JSON (`tests/contracts/m9-incident-input.test.mjs:13`). Its `r.stdout.includes('\n')` check passes for any pretty-printed output.
   - Suggested fix: reduce the large-file width to about 1400 characters, or split each excerpt into a `content_lines` array of short strings. Add a test that every output line is under 2000 characters.

2. **Files dropped to meet the size cap lose all their metadata** (`scripts/m9/incident-input.sh:24-27`, `:19`).
   - The loop deletes whole rows with `.diagnostics |= .[0:-1]`. Each dropped file loses its name, `original_bytes` and `sha256`, and only the `omitted_files` count is left. That does not match the stated goal of keeping byte counts, hashes and omission details.
   - `full_manifest_sha256` is a hash of the intermediate excerpt rows (`$tmp/rows`, including `priority`), not of the original bundle. It can only be checked by re-running this script with the same jq version, and nothing in `input.json` points to the retained `.tar.gz`.
   - `doctor.sh:82` keeps only the 5 newest bundles, so "full redacted bundle retained by owner" only holds until 5 more doctor runs.
   - Suggested fix: drop `content_excerpt` from the lowest-priority rows first, and keep a compact `{name, original_bytes, sha256}` list of omitted files, dropping that list only as a last resort. Add a `bundle_sha256` field, computed by `sha256sum` on the tarball in `incident-prepare.sh`, and pass it in.

## Suggestions

- `scripts/m9/incident-live.mjs:17`: `declared_tools:'Read,Edit,Write,StructuredOutput'` is a hard-coded constant, but `scripts/m9/incident-agent.sh:16` still passes `--tools Read,Edit,Write`; `StructuredOutput` is added by `--json-schema`. Because the verdict compares the constant against itself, that check proves nothing. Either derive the field from the agent arguments, or rename it to something like `effective_tools` and point `tools_evidence` at `--json-schema`.
- `tests/contracts/m9-evidence-bound.test.mjs:19`: add the old bare `BindReadOnlyPaths:'/home/danny/.local/bin/claude'` as a negative case, so a regression to the unpinned form fails explicitly instead of only through the `null` case.
- `tests/contracts/m9-incident-hook.test.mjs`: add `StructuredOutput` negative cases for a non-hex incident directory, and for a numeric or array `incident_id`.
- `tests/contracts/m9-incident-input.test.mjs`: check that the omitted rows are the lowest-priority ones (for example, no `containers/*.log` row is kept while a higher-priority row is dropped), and that `status.json` is always first.
- `scripts/m9/incident-input.sh:6-7`, `:18`: an exit 2 here makes `incident-prepare.sh` stop under `set -e` without any message. Print a reason to stderr, or wrap the call in prepare with `|| die 'diagnostic projection rejected'`.
- `scripts/m9/incident-input.sh:7`: anchor the check, for example `grep -qx 'secret values checked: [0-9]*; files carrying one: 0'`, to match the single line `doctor.sh:80` writes. It is fine today because doctor only writes that file after passing.

## Good Practices

- The hook ties the `StructuredOutput` incident to the trusted `FCPI_INCIDENT_INPUT` path, not to anything the model supplies, and tests reject `mcp__x__StructuredOutput`, a mismatched ID and a missing ID.
- The `StructuredOutput` branch returns before Read/Edit/Write handling, so the existing protections (symlink walk, `@`/newline rejection, gitignore check, writable allowlist) are unchanged for file tools.
- The projection refuses to run without the doctor's redaction marker and removes its temp files with a trap. Because it runs as a child process, prepare's `cleanup_prepare` trap still removes `$W` on failure.
- Hashes and byte counts come from the original file bytes (`wc -c`, `sha256sum`), not the jq-decoded text, so replacement of invalid UTF-8 cannot hide changes.
- Truncated excerpts keep both head and tail with an explicit marker, `truncated:true` and `trust:"…excerpts are incomplete"`, so a missing part never looks like health.
- The size loop always terminates (the empty structure is tiny), and rows are dropped in priority order.
- The `BindReadOnlyPaths` pin uses the exact `systemctl show` triple and still goes through `exactPaths`.

## Verdict

- [x] Approve
- [ ] Request Changes
- [ ] Needs Discussion

There is no critical security or evidence-integrity issue. I recommend fixing Warning 1 before the next live investigation, because it can quietly hide the newest status from the model.
