# PRE-M9 closure — 2026-10-03 UTC

M5, M6 and M7 are ACCEPTED with these supplemental live proofs. M0–M4 and M8 remain ACCEPTED under their original interpretation, including M8's preserved B00/X04 failures. M9 remains NOT_STARTED. This session did not run M9's corpus, acceptance matrix, F13 Redis helper fixes, onboarding or incident-agent work.

## Live evidence and accounting

| Provider | Real proof | Usage | Cost interpretation |
| --- | --- | --- | --- |
| OpenAI | Firecrawl JSON scrape: schema, prompt-injection resistance and missing manufacturer null; durable two-URL extract/poll/merge/provenance; E05 PASS | Five calls; requested/resolved `gpt-6-luna`; 974 input, 140 output, zero cache/read/write tokens, zero repairs | Standard rate-card token price $0.0001674; per-call rounded ledger $0.000170. No vendor invoice claim |
| LlamaParse | Scan sentinel and complex table; D03 PASS; cached scan causes no new reservation | Two one-page jobs, six free credits; signed-in Free-plan UI confirms 6/10000 | $0 paid; no plan/auto-reload activation |
| Decodo | L01 differing direct/proxied public IP hashes; browser page and image loaded on residential route; L02 Brave/DDG residential, Bing direct | Four settled tunnels/rows, 134591 locally measured upload+download bytes | Rounded local $0.000540 estimate. Provider-side existing user cap 0.05 GB saved; provider-day billing not reconciled |
| Zyte | E05 usable Example Domain paragraph; cache hit makes no additional dispatch; automatic direct→enhanced synthetic challenge is rejected as unusable | Three HTTP dispatches, including an earlier permitted-content proof; all settled; synthetic run uses two acquisition attempts and one enhanced request | $0.003810 conservative highest-tier estimate; actual vendor tier/bill unreported |

All 14 real-provider reservations are SETTLED in `evidence/M6/pre-m9-closure/raw/ledger-after-stop.json`. The original search transcript correctly shows RESERVED while sockets are open; both settle before shutdown. Total rounded dollar ledger is $0.004520, plus six free credits. Unrounded token/byte calculations are not presented as invoices.

Search returned five results with an explicit partial warning: Brave 429 and DuckDuckGo CAPTCHA. Those targets did not become usable merely because proxy transport succeeded. The synthetic Zyte target establishes routing, quality rejection and attempt bounds, not real anti-bot success. Decodo vendor-day reconciliation remains disabled (`usageDedicated=false`, account API key absent); the implemented reconciliation contract is fixture-tested and requires dedicated usage consent before activation.

The parser jobs supplied no persistent Files API file ID. Their multipart source uploads use the provider's [48-hour retention](https://developers.llamaindex.ai/llamaparse/general/data_retention/), checked 2026-10-03; explicit deletion is not claimed. The six-page-credit ledger and local cached result remain available.

## Authorization and recovery

The owner authorized only PRE-M9 closure: $1 OpenAI, $1-equivalent Decodo, $1 Zyte and at most 500 free parser credits/$0 parser paid. The three temporary windows used lower caps: $0.05 model, $0.20 proxy only after cap verification (otherwise zero), $0.05 enhanced, 100 free parser credits, $0.30 total. Each had an absolute 45-minute lease, dynamic reservation/send guards, restart disabled and a pre-armed cleanup timer. Final base Compose is restored: paid dispatch false; all production paid/credit caps zero; temporary override/policy files absent; Cloud disabled. No purchase, subscription, account upgrade, public ingress or alternate activation occurred.

Four credentials were installed through the existing restricted secret-file mechanism. Each is mode 0600, uid/gid 3310, mounted read-only; no value enters this evidence. `.env` remains ignored/untracked at mode 0600.

## Verification and preserved failures

- `raw/pi-suites-remediation.tap`: 360 native ARM64 isolated tests PASS; zero temporary test containers/networks remain. Runtime retrieval image is `sha256:703f076d7a0a78c0c9fa80957e86708a0960b1816f9671828e5a3ce9441d04ba`, built from `a51ec7f`; later source changes are fixture/evidence/collector/verifier changes, not service code.
- `verification.json`: 21 selected fixture/live/resource/lock/review checks PASS. Unselected historical checks are NOT_RUN in this supplement, inherited from the preserved original reports rather than relabeled PASS.
- `additional-verification.json`: model null/selection, parser cache, residential browser assets, enhanced cache and bounded automatic-enhanced proofs PASS. Positive and negative controls are in `raw/verdict-controls-actual-schema.tap`; invalid class, missing image/tunnel, duplicate strategy/dispatch and missing accounting fail.
- `posture-verification.json`: current layout PASS; 15 healthy native containers, effective parent swap denial, private authenticated publication, zero caps, secret modes, all final settlements, unchanged boot/unrelated state, current guard window, log scans and retained off-device restore proof.
- `raw/legacy-verifier-probe.json` retains exploratory M5 X01/X02/X03 FAIL. The M8 collector has a metadata line before counters, 15 services instead of 13, and parent-level swap denial; the recreated base retrieval container has six startup lines instead of 100 workload lines. The current equivalent check uses the retained 291-line whole fixture scan, current base scan, all saved core instances, four successful driver phases, guard handle 10→10 and accepted-web delta 25. It does not claim a retained whole log for every replaced paid container. Historical evidence is unchanged.
- Earlier failing fixture/collector/client-label/public-target/sentinel probes remain under named raw files. Full retained complex-table output is bound to original logical ID, ledger settlement, input/content hashes and transcript hash; no extra parser call or rewritten success transcript was needed.
- `raw/orchestration-ui.json`: desktop light/dark 1440×1000 and phone dark 390×844 inspected; no horizontal overflow, nine ACCEPTED plus M9 NOT_STARTED, M9-only eligibility filter, updated source dialog, zero JavaScript errors, no external scripts/styles. Page screenshots were inspected inline and not saved.

The final status records REST/MCP healthy, all 15 services healthy, no OOM, no foreign containers, 4754 MiB host memory available, 49°C, throttled 0x0. Core instance/data services and unrelated host services were preserved. Snapshot changes are the retrieval/fixture-m6 containers, SearXNG/project namespaces, collector SSH sessions and an equivalent Docker raw-rule reorder. Backup to the existing off-device destination succeeded 2026-10-02; the retained isolated restore test passed 2026-10-01.

## Review, commits and entry gate

`review/REVIEW.md` is the saved report of record, also copied into M6/M7's supplemental review directories. Opus 5.5 was unavailable; two independent fresh GPT-6.1 Sol agents performed the recorded substitution. The report existed before remediation. Every finding was fixed in a named local commit; affected tests were rerun. Both reviewers approved final remediation, including the actual producer-schema and posture-provenance corrections. No push, rebase or history rewrite occurred.

Both canonical documents and ORCHESTRATION.html reflect M5–M7 ACCEPTED, B3–B5 cleared, verified Luna selection and current proof limitations. M9's literal Dependencies require all mandatory M0–M8 criteria with real proxy/enhanced/model/complex-parser/off-device restore evidence. Those entry requirements are satisfied. No additional owner input is required for entry; starting M9 still needs its own kickoff, and new paid calls require fresh authorization. M9 owns M8 F13, global MCP/client onboarding and incident-agent work. Optional hosted access remains disabled.

Before any future push, scan full history after remote baseline `5ab47b979c9e243f62f46035714aa83a94d7b090`, including `.env`-ignore commit `c622e80` and these local commits. This close-out does not authorize publication.
