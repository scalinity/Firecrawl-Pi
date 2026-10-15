# Firecrawl Agent client research — 2026-10-15

The captured client implements a research conversation with asynchronous run handles, status polling, activity traces, follow-ups, and optional connected-provider controls. The client artifacts do **not** contain the Spark 2 backend. This investigation establishes the client contract and visible behavior; it does not recover the hosted model, server prompts, orchestration implementation, or provider execution.

## Target and provenance

Public capture page: [Firecrawl Agent](https://www.firecrawl.dev/app/agent). A signed-in Chrome session was inspected without submitting an Agent task. No Cloud Agent run or Cloud credit consumption occurred. Downloaded JavaScript was inspected as inert data, without executing it. Private page HTML, captured assets, and complete REA output remain outside Git; no account, team, run, thread, or share identifiers are included here.

Artifact paths below are keys relative to the private capture directory. Offsets are zero-based UTF-8 byte offsets with an exclusive end. SHA-256 values identify the exact captured files, rather than a changing deployment.

| Artifact path | Bytes | SHA-256 |
|---|---:|---|
| `app-bundles/0jt2wflj7xm_0.js` | 83,291 | `2080080649e254c71ffe72e5ddae780ec0b31a056e14e2dd207a4a177fcafe46` |
| `app-bundles/1l1385dh2750a.js` | 196,301 | `c0e6cac2749597e9025b66903699fb2186ddbd887e533df8b73f30a6a07ef836` |
| `app-bundles/19gomjdgfdc9e.js` | 297,557 | `6d9af2f25d9fc6f487be82a35c6727dedeb445a323d0b453812bdf535d91aa47` |
| `app-bundles/3wrvovn-4uvas.js` | 41,895 | `17a849d866631e64e52e97164a517ef2d4be7cd6783fb1ac5ffb7d387efdf6d6` |

REA analyzed these four files, totaling **619,044 bytes**, with zero parse failures. The retained application artifact identifier is `9d201f7d19027956546e454e3b5f5620ff92c279e1da4a4b05ddc70824dab534`; parent Evidence ID: `ev_94f8411f76924abd4e77a9d534e5e0ca4d142dc9243be30dedff33efd6144793`. Its semantic graph reached the 100,000-node ceiling and reported 35,511 semantic unknowns. The separate 83,291-byte controller analysis, Evidence ID `ev_809b23b832d461bb4406048bd2f12a7094d8fc5bcbdff9ec90153212f6977bfe`, omitted no graph nodes but still reported 4,267 semantic unknowns. Parsing success and an untruncated graph do not establish complete semantic recovery. The byte-level observations below supplement those retained analyses.

## Observed UI

The inspected page exposed an Agent task composer, Sites and Schema controls, the Spark 2 label, Low/Medium/High effort choices, an Alexandria checkbox, and Agent Settings. The credit-limit field presented 100–2,500 credits, with an empty value described as having no limit. These are observed controls; their presence does not establish account entitlement, successful provider access, or backend enforcement.

Static corroboration: the Spark label map is in `1l1385dh2750a.js` at `[111700,112700)`; effort choices and site parsing are in the controller at `[32300,34700)`; credit-setting validation and UI are in `19gomjdgfdc9e.js` at `[151700,154870)`. A dashboard credit cap is not a dollar-denominated spending authorization for the Pi implementation.

## Observed static client flow

1. **Compose and submit.** The controller builds a task from prompt, optional URLs, strict URL constraint, schema, effort, and optional Alexandria/exchange configuration. It posts JSON to the internal application route `/api/extract-v3` in chat mode, adding `maxCredits` only when configured. A successful response must include a run ID and may include a thread ID. This is an observed same-origin application contract, not proof that the public API has the same contract. Controller `[4850,6150)`, `[11330,12650)`, `[14000,14950)`.

2. **Poll status.** The controller immediately requests the run status, then polls at one-second intervals. It handles completed/success, failed, and cancelled states; retains in-progress or partial data; and unwraps a sole `FINAL_OUTPUT` result field. Repeated not-found responses and lost access have separate handling. A terminal trace verdict can resolve a status response that remains behind. Controller `[8580,11370)`.

3. **Incremental activity.** A separate trace request uses `/api/extract-v3/{run}/trace`. With cached events it sends an `after` cursor from the latest event ID and a `have` count. Delta events merge by event ID, replacing existing entries or appending new ones; a changed run ID or full-trace response replaces the cached trace. Trace polling runs at one-second intervals while active, with bounded additional reads after activity stops and automatic query retries disabled. Controller `[1210,1900)`, `[7120,7790)`. This establishes client merge behavior, not server delivery guarantees.

4. **Follow-up turns.** The controller sends subsequent tasks with the thread ID and changed options, restores a thread through its run list, and maintains run/thread navigation state. A compatibility path builds bounded prior-conversation text when server-backed threads are unavailable. Controller `[12650,16650)`, `[16600,19900)`. The server's persistence and concurrency semantics remain unknown.

5. **Cooperative cancellation.** Cancel first updates local state, then posts to the run's cancel route. The helper suppresses network errors; cancelling before the run ID arrives is remembered and sent after submission returns. This proves an explicit cancellation request and optimistic UI behavior. It does not prove immediate termination, reclamation of remote resources, or avoidance of already-incurred charges. Controller `[4850,5250)`, `[12000,12450)`, `[15100,15350)`.

6. **Credit stops preserve uncertainty.** The client recognizes `credit_limit_reached`, retains partial data and `partialSchemaValid` when supplied, and offers a continuation control turn. Failed or partial work is not uniformly presented as complete. Actual reservation, settlement, pricing, and hard-cap enforcement are server-side unknowns. Controller `[2890,4200)`, `[8580,11370)`, `[2000,2480)`.

7. **History, sharing, and export.** History groups runs by thread, restores earlier settings/results, and supports hiding a session. Share controls create or revoke a share link and present it as viewable by anyone holding it; neither operation was exercised. `19gomjdgfdc9e.js` `[154870,155400)`, `[157100,159100)`, `[161600,163200)`. A supplemental captured helper, `app-bundles/2f5290bvc-tqz.js` (73,591 bytes; SHA-256 `3e0d47747f43d55ceffff0cb9d1fce1da65e2f84d5794c298a64148d20bc2d72`), constructs a CSV Blob and download link at `[8600,9370)`. That helper was manually inspected as inert text; it is outside the four-file REA totals. CSV export was not executed.

8. **Skills and connected-provider review.** The client embeds reusable skill blueprints into prompts and offers agent-installation guidance. Provider calls can expose one-time approval, persistent approval, decline, and terms-review controls; their responses become explicit follow-up turns. Controller `[14000,15950)`, `[59000,60000)`, `[61400,62150)`, `[63500,65200)`, `[69000,71000)`; blueprint serialization in `1l1385dh2750a.js` `[194000,195150)`. These controls establish a client interaction design. No connected-provider call, approval, terms acceptance, or skill installation occurred.

## Inferred and unknown

**Inferred:** the visible product coordinates longer-lived, multi-turn research runs and renders structured server activity. Trace and status are separate views of a run, so client reconciliation matters. The client can display provider-call progress, but that does not reveal how the server chooses tools or executes them.

**Unknown:** Spark 2 model composition and weights; system/developer prompts; planning and completion policy; tool selection, tool implementations, browser concurrency and isolation; connected-provider execution; retry and fallback policy; durable storage; billing reservations and settlement; server-side URL validation; citation correctness; cancellation guarantees; performance and failure behavior under real workloads. The semantic unknown counts above remain limitations. No negative source search or missing client implementation establishes that a backend feature is absent.

## Relationship to the personal Agent implementation

The local implementation in `scripts/playground/agent.mjs` and `scripts/playground/server.mjs` is a bounded personal research workflow using the Pi's search and scrape-plus-JSON paths. It requests `gpt-6.1-sol` with `xhigh` effort through the budgeted model adapter. Its progress stream and grounded findings reproduce useful interaction patterns without claiming Spark 2 backend compatibility. It is a synchronous session workflow, not the hosted Agent API or a durable Agent job service.

Remaining product gaps include durable Agent conversations and resumable history; server-managed thread follow-ups; parallel browser research; connected providers, approvals and provider terms; shareable Agent runs; reusable hosted skills; and Cloud-compatible run/trace APIs. Existing durable crawl jobs are a separate capability. UI similarity and fixture tests do not close these gaps or establish live model qualification.

The [official OpenAI model reference](https://developers.openai.com/api/docs/models/gpt-6.1-sol) was retrieved through fcpi as complementary model documentation. An attempted Firecrawl reference retrieval through fcpi returned `CLOUD_DENIED`; that guard was preserved. The Morph public GitHub source lookup failed to fetch, so source was unavailable through that lookup during this investigation; this is not evidence that public source does not exist. Neither documentation retrieval nor client analysis supplies the private Spark 2 implementation.
