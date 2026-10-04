## Summary
I read all eight listed files and the code around them: `scripts/m9/incident-agent.sh`, `scripts/ops/doctor.sh`, and the `incident-prepare.sh` launch and cleanup path. The delta does what it says.

- **Input size:** `incident-input.sh` runs only after the doctor's literal secret scan has passed. It checks the `REDACTION.txt` marker that `scripts/ops/doctor.sh:80` writes, records each file's byte count and SHA-256 from the original bytes, cuts each file to a head-and-tail excerpt, and drops the lowest-priority rows until the output is at most 20480 bytes. A failure exits non-zero. Under `set -e`, `cleanup_prepare` then removes the new `$W`.
- **StructuredOutput:** the hook branch allows only that exact tool name. The incident ID comes from `FCPI_INCIDENT_INPUT=$W/input.json` (`scripts/m9/incident-agent.sh:9`), which the model cannot change, so the ID is always this incident's. Other tool names still go through the unchanged Read/Edit/Write file guard.
- **BindReadOnlyPaths:** the triple check in `evidence-checks.mjs` survives `incident-live.mjs`'s `split('=')` parsing, because the value contains no `=`.

I found no reachable security or authority regression. One functional weakness can still hide part of the highest-priority evidence from the model.

## Critical Issues
None

## Warnings
1. **The tails of the top-priority excerpts may be cut off by the Read tool's line limit** (`scripts/m9/incident-input.sh:12-16`, `:21`).
   - `status.json`, `incidents.json` and `host.txt` get `width=2048` characters. Each excerpt is stored as one JSON string, so every newline becomes a two-character `\n` and every `"` becomes `\"`, all on a single line of the pretty-printed output. With the excerpt marker added, the `"content_excerpt": "..."` line will often be well over 2000 characters.
   - The native Read tool's documented behaviour is to truncate lines longer than 2000 characters. If the pinned binary does that, the model sees the head of `status.json` but not the tail. The tail is exactly what the head-and-tail design (and the "last observation" assertion in `tests/contracts/m9-incident-input.test.mjs:13`) is meant to keep.
   - The test checks the parsed JSON, not what Read shows per line, so it passes either way.
   - Proposed change: output the excerpt as an array of lines, so pretty-printed `jq` puts each line on its own row:
     ```diff
     -...content_excerpt:(if ($content|length)>$width then $content[0:($width/2)]+"\n<excerpt truncated; full redacted bundle retained by owner>\n"+$content[-($width/2):] else $content end)}'
     +...content_excerpt:((if ($content|length)>$width then $content[0:($width/2)]+"\n<excerpt truncated; full redacted bundle retained by owner>\n"+$content[-($width/2):] else $content end)|split("\n"))}'
     ```
     Then add a test assertion that no output line is longer than 2000 characters.

## Suggestions
1. **Omitted files are only a count** (`scripts/m9/incident-input.sh:25`). `omitted_files` gives the number but not the names. With a typical bundle (about 10 containers × `.json` and `.log`, plus priority-9 files), every priority-9 row gets dropped first. That includes `supervisor-restarts.jsonl` and `notices-recent.jsonl`, which are often the most diagnostic files after `status.json`. Two options:
   - Add a compact `omitted:[name]` list.
   - Give `supervisor-restarts*` and `notices-*` a priority above `compose-rendered.yaml` and `boots/*`.
2. **`full_manifest_sha256` hashes the intermediate rows, excerpts included** (`:19`), not the original files. The owner can only reproduce it by re-running the same script with the same `jq` version. A hash over sha256sum-style `"<sha256>  <name>"` lines would let the owner check it directly against the retained bundle.
3. **Container rows are dropped by file name, not relevance** (`:21`, `sort_by(.priority,.name)`). Under size pressure, the logs of containers late in the alphabet go first, whatever their health. One option is to rank logs of unhealthy or restarting containers higher, using `containers/*.json` `State`.
4. **The hook gets the incident ID from a path** (`scripts/m9/incident-hook.sh:14`). This works because `incident-agent.sh` always uses `$W/input.json`. Exporting an explicit `FCPI_INCIDENT_ID` from `incident-agent.sh` would make the link explicit and not depend on the directory layout.
5. **`declared_tools` is a hard-coded label** (`scripts/m9/incident-live.mjs:17`), so the matching check in `evidence-checks.mjs:41` proves nothing. The CLI still gets `--tools Read,Edit,Write` (`scripts/m9/incident-agent.sh:16`); StructuredOutput only appears because of `--json-schema`. Both points are disclosed in `tools_evidence`. A stronger check would derive it from the pinned agent arguments, or from tool-use or permission-denial data in `result.json`.
6. **Test gaps:**
   - `tests/contracts/m9-evidence-bound.test.mjs`: add negative cases for the old bare `BindReadOnlyPaths` value and for an `:rbind` triple with the wrong target, so the exact pin is protected against regressions.
   - `tests/contracts/m9-incident-input.test.mjs`: add an empty or missing diagnostic directory (expect exit 2), and an assertion that rows stay sorted by priority after rows are dropped.

## Good Practices
- Each row's byte count and hash come from the original bytes (`wc -c` and `sha256sum` on the file), never from the excerpt. Truncation is reported per row and in the `trust` string.
- The script refuses to run unless the doctor's enforced scan marker is present. The test shows that a bad marker produces no stdout.
- Rows are dropped from the end of a priority-sorted list, so the size cap removes low-value data first. The loop always ends, because the header alone fits well under 20 KiB.
- The temporary directory is created with `mktemp -d` and removed by a trap. The full bundle never reaches the agent's input.
- The StructuredOutput branch matches the tool name exactly, requires a strict `^[0-9a-f]{8}$` ID, and compares it with `jq`, which handles a missing or non-string `incident_id` safely. Tests cover the wrong ID, a missing ID, and a lookalike `mcp__` name.
- The evidence check pins the BindReadOnlyPaths source, target and `rbind` exactly, rather than loosening it to a prefix match.

## Verdict
- [ ] Approve
- [x] Approve with suggestions
- [ ] Request changes

I recommend fixing Warning 1 before the next live investigation, so that the highest-priority excerpts reach the model in full.
