# Google search engine configuration

Google is loaded by the pinned SearXNG image, and `www.google.com` has a residential-only route under the existing proxy budget. No image rebuild, provider subscription or budget change was needed.

**Useful Google results remain UNAVAILABLE.** The actual Firecrawl search test returned HTTP 200 with zero results and an explicit partial-result warning: Google access denied. The observed Google tunnel used the residential route; its one reservation settled at a ledger estimate of 34 micro-USD. Provider invoice reconciliation was not run.

Google remains configured, with automatic fallback disabled to avoid recurring paid refusals. Yahoo remains primary and returned five results, including official Python documentation, in the final Firecrawl check. All 15 project containers were healthy. The affected fixture tests passed 37/37 after using the harness directory layout; the initial direct repository invocation failed because that layout was absent.

`verification.json` records the separate successful configuration checks and failed live Google result. `snapshot-attribution.json` attributes every changed snapshot line: the two owned network namespaces, the existing probe timer's transient state and a permutation of three destination-disjoint DROP rules. Applying that permutation to the current ruleset reproduces the exact pre-session ruleset hash. No unrelated service or firewall policy change was found. Private snapshots and response bodies remain outside Git.

Both canonical documents describe the current blocked Google state. `ORCHESTRATION.html` was realigned to those source snapshots and hashes; milestone ordering and acceptance remain unchanged. A working Google source requires a separately verified acquisition path before automatic dispatch is enabled.
