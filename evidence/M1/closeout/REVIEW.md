# M1 close-out — `/review-2` report and outcomes

- **Review:** `/review-2` on the close-out's first window (commits `20cd0b4..0662cc2` plus its records). Both agents ran on Opus 5.5 (one debugger, one code-auditor), with the evidence transcripts read as data.
- **Verdict:** request changes: 2 critical, 7 warnings, 13 suggestions.
- **Outcomes:** `/address` fixed each finding or rejected it with evidence; none is deferred. Commits are on `main`, and the checks are in `evidence/M1/closeout/verification.json`.

## Findings and outcomes

| ID | Severity | Finding | Outcome | Commits | Check |
|---|---|---|---|---|---|
| C1 | critical | `fcpi_core` owned NuQ's tables, which NuQ's pg_cron jobs update as the superuser every 15 s. An owner can attach a trigger those jobs run with superuser rights (CWE-269), so R11's narrowing could be undone within 15 s. | Fixed: DML only. Tables, schema and jobs stay the superuser's, `fcpi_core` owns nothing, and the superuser has no password. As `fcpi_core`, a function in `nuq` and a trigger on a NuQ table are refused. | `371e0cc`, `63599f0`, `faa37e3` | V22, V26 |
| C2 | critical | `pi-nm-state.sh` passed a zoneless UTC time to `journalctl --since`, which reads it as local time (America/New_York), so V23's window read an empty journal. | Fixed: the window names UTC, and the journal-line and Docker-interface counts are required as a positive control. | `f5bac0b`, `a1e6c15` | V23 |
| W1 | warning | R13 was recorded fixed without reaching StartLimitBurst; the 180 s queue was unexplained. | Fixed. A logged timeline showed `fcpi-stack`'s `Requires=docker.service` carrying docker's restart, with `compose stop` waiting 180 s. The unit now `Wants` docker, and dockerd reaches its start limit in 6 s. | `a1e6c15`, `f4d0cae` | V19, V12 |
| W2 | warning | A rollback deploy would prune the guard ruleset the drop-in loads, and would break the core's login. | Fixed. The ruleset is installed under `/etc/firecrawl-pi`, and CLOSEOUT.md documents the credential rollback. | `62f2847`, `017c6a8` | V19, V20 |
| W3 | warning | An interrupted migration continued with a mismatched secret pair. | Fixed: the "kept" branch stops when the pair differs. | `63599f0` | V22 |
| W4 | warning | `pi-init.sh` ignored a failed guard load or NetworkManager reload (under `set -e`, a failure inside `&&` does not stop the script). | Fixed: `nft -c` runs before install, a failed load stops the script, and the effective configuration and device states are checked. | `62f2847`, `43157fb` | V20, V23 |
| W5 | warning | The recorded SHAs did not contain the verifier code that produced V23 and V14; `worktree_dirty` was always true. | Fixed: `code_dirty` ignores `evidence/`, and every rerun result records `code_dirty=false`. | `1def8e5`, `017c6a8` | all |
| W6 | warning | The fresh-install paths (initdb script, the broker's first boot) never ran. | Fixed: throwaway containers of the pinned images prove both paths. | `bdca714`, `bfc9a0c`, `91e491f` | V26 |
| W7 | warning | The NetworkManager reload fell outside the journal window. | Fixed: the window starts at the reload (23:07:38 UTC). | `f5bac0b` | V23 |
| S1 | suggestion | V22's session sample caught pg_cron's loopback sessions. | Fixed: loopback is excluded. | `371e0cc`, `63599f0` | V22 |
| S2 | suggestion | The migration could set an empty password. | Fixed: the password is read into a variable and checked first. | `63599f0` | — |
| S3 | suggestion | `up_exit` could only print 0. | Fixed: the exit status is captured, and a failure stops the script. | `63599f0` | — |
| S4 | suggestion | `deploy.sh` accepted backslash paths, its comment was inaccurate, and it wrote the commit marker before pruning. | Fixed. | `ddc0ad4` | V24 |
| S5 | suggestion | Scripts documented as runnable were mode 644. | Fixed: every `scripts/m1` script is mode 755. | `ddc0ad4` | — |
| S6 | suggestion | A default-mode rerun would add the close-out checks to M1's file. | Fixed: default mode lists only M1's 28 checks. | `a1e6c15` | — |
| S7 | suggestion | `unmanaged-devices=` overrode earlier lists. | Fixed: `+=` appends, and the effective value is recorded. | `f5bac0b` | V23 |
| S8 | suggestion | V07 accepted the administrator tag in close-out mode. | Fixed: it requires `fcpi[]` there. | `a1e6c15` | V07 |
| S9 | suggestion | Guard probe coverage: DNS, bridge-name coupling, forward-in firing, a public positive control. | Partly fixed, partly rejected. **Fixed:** the probe's lookup found that Docker's resolver reached the host's loopback resolver past the guard, so the gateway now names its own upstream; V20 requires a public name to resolve before that setting and fail after it, and requires the rendered bridge name to be the one the guard matches. **Rejected, with the evidence:** forward-in cannot be exercised, because no interface on this host routes to 10.231.0.0/24 without a static route on another LAN device, and the rule is defense-in-depth. Repeating the guard-absent control without a public target would require removing the guard, and its one public connection is disclosed. | `62f2847`, `43157fb` | V20 |
| S10 | suggestion | A failing `ALTER ROLE … PASSWORD` could reach the server log; the superuser kept a network password. | Fixed: statement and error logging are off in the role script, and the superuser has no password. | `371e0cc` | V22, V26 |
| S11 | suggestion | Close-out wording went beyond its transcripts, and REVIEW.md's Owner column had been rewritten. | Fixed: CLOSEOUT.md was rewritten against both windows' transcripts, and the review's Owner column was restored. | `017c6a8` | — |
| S12 | suggestion | The deferral clause was broad. | Fixed: it requires the needed item to appear in the later milestone's Scope or Implementation Work. | `7b85385` | — |
| S13 | suggestion | The ownership SQL had a missing `pg_depend` classid filter and missing type kinds. | Rejected, with the evidence: the DML-only design (C1) removed the ownership-transfer SQL it applied to. | `371e0cc` | — |

## Found while addressing

| Item | Outcome | Commit | Check |
|---|---|---|---|
| The gateway resolved public names past the guard, through Docker's resolver and the host's loopback resolver | Fixed: `dns: [192.0.2.1]` on the gateway | `43157fb` | V20 |
| `fcpi-stack.service` stalled any dockerd restart for 180 s and was left failed | Fixed: `Wants=docker.service`, and the gate test's restore leaves the unit active | `f4d0cae` | V19, V12 |
| The fresh proof's readiness wait hit the pipefail and SIGPIPE trap, and `pg_isready` had no user name | Fixed | `bfc9a0c`, `91e491f` | V26 |
| psql printed command tags into the credential probe | Fixed | `faa37e3` | V22 |
