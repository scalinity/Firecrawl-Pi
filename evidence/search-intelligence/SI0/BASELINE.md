# SI0 — Reconciled source, frozen contracts and baseline (2026-10-17)

## Checkout and drift

- Start: branch `main` at `2a6251333e3fa1572af25cd2e8aec375b5a955be`, equal to `origin/main`; the only uncommitted files were the owner's two feature inputs (`docs/FIRECRAWL_PI_SEARCH_INTELLIGENCE_SPEC.md`, `docs/CLAUDE_CODE_IMPLEMENTATION_KICKOFF.txt`), committed on the feature branch as `97ea101`. No other work was present to preserve.
- Work branch: `search-intelligence`, pushed to `origin/search-intelligence`.
- Drift since the design baseline `88d8e4c`: 11 commits (streaming Anthropic calls, the Sonnet Agent, the start-up sweep log, the asynchronous pinned lookup). None touches `search.mjs` or `serper.mjs`. `provider.mjs` gained the idle limit and `resolve.mjs` answers its pinned lookup asynchronously; the design's observation (R07) still held at `2a62513`: the transport's abort listener and timer started after DNS.
- `AGENTS.md` and `CLAUDE.md` byte-identical at the start.

## Deployment observed (read-only)

- The Pi runs source commit `5d91186` (one commit behind `main`; `main` adds evidence only). All 15 project containers healthy. Paid-dispatch host switch on (`/etc/firecrawl-pi/paid-dispatch.env`), search selection `live`.
- Provider credential files on the Pi (presence only): `serper_api_key` present; none of the new providers' files exist yet.

## Credentials (names and presence only; no value was read or printed)

The workstation `.env` names every credential the feature needs. Proposed mapping to the existing provider-file mechanism (`scripts/m5/pi-provider-key.sh <name>` over SSH stdin):

| `.env` variable | Credential file (budget policy) | Provider |
|---|---|---|
| `SERPER_API_KEY` | `serper_api_key` (already present on the Pi) | Serper |
| `BRAVE_API_KEY` | `brave_api_key` | Brave |
| `EXA_API_KEY` | `exa_api_key` | Exa |
| `DEEPSEEK_API_KEY` | `deepseek_api_key` | DeepSeek |
| `TAVILY_API_KEY` | `tavily_api_key` | Tavily |
| `CONTEXT7_API_KEY` | `context7_api_key` | Context7 |
| `REF_API_KEY` | `ref_api_key` | Ref |
| `OPENROUTER_API_KEY` | `openrouter_api_key` | OpenRouter Decisions (Jev) |

`scripts/pre-m9/stage-secrets.mjs` stages only the older providers and was not run.

## Contracts frozen

`provider-contracts-2026-10-17.md` (documentation-only verification; no keyed call). Differences from the feature spec adopted in code: Brave `offset` ≤ 9 and an optional `web` section; Exa has no `score`, `costDollars` is `{total, search, summary, contents}`, error body `{requestId, error, tag}`, 503 unbilled; DeepSeek `count` ≤ 50, `site_name`, documented 400/401/402/408/413/429/500/504; Tavily `include_domains_mode` `restrict|prefer`; Context7 single-library version falls back to current docs with a flag; Jev Noul has no confidence, budget errors may be 403.

Exa's reservation was raised to 37,000 micro-USD: the documented components bound a 20-result auto search with highlights between $0.017 and $0.037, and whether `/search` highlights bill at the contents rate is not stated.

### Live contracts still unverified (each needs a keyed smoke in SI5)

Serper error tags and bodies (no official reference); Brave 401/402/403; Exa highlight billing on `/search`; whether DeepSeek counts operators toward 128; Tavily charges on failed searches; Context7 `RateLimit-Reset` unit and which snippet fields are required; Ref's hosted output format and error shapes; Jev's maximum questions and bytes per request and `X-RateLimit-Reset` unit.

## Test inventory and baseline (before any feature change, on this workstation)

| Suite | Command | Result |
|---|---|---|
| retrieval, no database | `node --test test/*.test.mjs` (container layout) | 299 tests: 268 pass, 0 fail, 31 skipped (all database-backed) |
| retrieval, disposable PostgreSQL, serial | `FCPI_TEST_PG=127.0.0.1 PGPORT=55432 --test-concurrency=1` | 299 / 299 pass |
| access gateway | `node --test --test-concurrency=1 test/*.test.mjs` (database set) | 96 / 96 pass |
| MCP gateway | `node --test test/*.test.mjs` | 47 / 47 pass |
| root (`tests/*.test.mjs`) | serial | 58 / 58 pass |
| contracts (`tests/contracts`) | serial, `FCPI_TEST_PG=127.0.0.1:55432` | 152 / 167 pass; the 15 failures are all `m1-gateway.test.mjs`, which boots the gateway with M1-era configuration keys the current gateway refuses (pre-existing, unrelated to search) |

The database suites must run serially: run in parallel, files truncate one database under each other (observed: several `m5-store` failures at concurrency > 1, 14 / 14 alone). The disposable database is the pinned PostgreSQL image on the workstation's Colima VM, data in tmpfs, bound to `127.0.0.1:55432`, label `fcpi.transient=si-db-tests`.

## Evaluation setup frozen

- Corpus: `corpus/corpus-v1.json`, sha256 `b4ae2b8f79d9cd8a406dbded7345246985209280fa8c06ac2aa5c55cb913f724`, authored by a fresh-context agent that read no implementation and ran no search; 120 queries, positions 3 and 8 of each category tuning (24), the rest held out (96); 43 held-out documentation-positive, 19 held-out version-constrained. Committed (`42aa3d0`) before any ranking code existed.
- Metrics as frozen in the feature spec §23.2: macro nDCG@10 (gain 2^rel − 1, discount log2(rank + 1)), pooled recall@20 (grade ≥ 2), precision@5/@10, primary-source presence@10, documentation evidence coverage, paired category-stratified bootstrap (10,000 resamples).

## Implementation map

`services/retrieval/src/search-intelligence/`: `contracts.mjs` (trusted request, reasons, outcome), `normalize.mjs` (query/URL identity, constraints, fair pool), `rank.mjs` (RRF, shortlist, blend, diversity), `permits.mjs` (API/Jev permits, Ref stream slots, DeepSeek QPS), `availability.mjs` (account state, Brave/Retry-After parsing), `coordinator.mjs` (fan-out, outcomes, caches, coalescing), `adapters/{common,serper,brave,exa,deepseek,tavily,searxng}.mjs`; SI2 adds `documentation.mjs`, `decisions.mjs`, `adapters/{context7,ref}.mjs`; SI3 `evidence.mjs` and the core patch `0011`; SI4 `telemetry.mjs`.
