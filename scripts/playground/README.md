# Local playground

The [Tauri desktop wrapper](../../desktop/README.md) opens the same playground in a
native macOS window without a title bar and manages its own local server.

From the repository root, run:

```sh
node scripts/playground/server.mjs
```

Open `http://localhost:8767/LLM-DEMO.html`. On macOS, an app window opens with:

```sh
open -na 'Google Chrome' --args --app=http://localhost:8767/LLM-DEMO.html
```

The server listens only on loopback. Node, SSH access from `scripts/m1/pi-target.conf`,
and passwordless sudo for the existing Pi operations account are required. The default
gateway client is `m9codex`; `FCPI_PLAYGROUND_CLIENT` selects another existing client
token on the Pi. It needs read, scrape, search, map, crawl, cancel, and extract scopes.
The browser never receives this token. `FCPI_PLAYGROUND_PORT` overrides port 8767.

Scrape returns Markdown. Its optional LLM switch adds a prompt and JSON schema,
returning source text and extracted fields together, with actual model usage and cost.
Search returns web results; Map discovers links; Crawl submits a durable job with a
1–10 page limit. Refresh reads up to ten crawl results; Cancel requests cancellation.
Job IDs can be pasted into the crawl controls after reloading. An uncertain crawl
submission reuses its idempotency key when retried in the same tab.

Agent takes a task of up to 1,200 characters, up to three optional starting URLs,
and a 1–5 page limit (default three). Its optional Result schema editor accepts a
JSON object schema; leave it blank for the ordinary answer, findings, and sources.
When supplied, the structured result appears alongside those in the response.
It requests Claude Opus 5.5 at high effort through the existing budgeted extraction
path, on its own Anthropic key. The response reports the provider's model identity, available usage, and
accounted cost. Missing token counts remain unknown; a conservative reservation cost
is identified in response warnings. The high effort is configured and sent with each
model request; provider responses do not confirm that setting. The provider
constrains a model's output with a grammar only up to 16 nullable fields in all. The Agent's own
decision uses 10 of them, so a result schema of more than five fields (nested ones included) sends
the whole decision as prompt text; its answer is then checked locally against the full schema, with
one repair, and the model-call log records which way each call went.
An unavailable model or unsupported setting fails explicitly, without a model fallback.
The model can direct follow-up searches and reads within five page dispatches, three
searches, eight tool calls, and 15 minutes (a page read that uses its whole wait takes about seven minutes, so two of those fill the run; a usual read is far shorter). A page extraction can use more than one
model call for chunking or repair; actual model calls, tokens, and cost are reported
rather than inferred from page count. Budget denials and errors stop further work.

The Agent activity list streams actual search and scrape events. Its final response
includes an answer, source URLs, quoted findings, limitations, and a tool trace.
Source documents and raw JSON remain inspectable in the response. This is a local,
session-bound workflow, not a durable Agent job or a claim of Firecrawl Cloud Agent
API parity. Stop agent, closing the page, or losing its connection stops future
steps; already dispatched calls may finish and consume budget. There is no hidden
background run and no automatic retry. A stopped or interrupted session retains
the step summaries received by the browser and labels incomplete results honestly.

Examples only fill the composer. Only Run submits work. Opening the page makes a
read-only gateway health check. Scrape's LLM extraction starts off; Agent always uses
a model. Both use the existing approved policy, and normal retrieval can still use
separately budgeted proxy routing. No budget or provider setting is changed by
opening or using the playground.

Responses, source documents, and recent requests are held in tab memory, not saved
automatically. Save JSON explicitly downloads the current response to a local file.
Scraped content and model output are displayed as text, never executed as HTML.
Closing the tab does not cancel a durable crawl; use its job ID to check or cancel it.
A lost synchronous response may still have consumed retrieval/model budget: the
playground never automatically retries it.

Run the local bridge and Agent checks with:

```sh
node --test tests/playground.test.mjs tests/playground-agent.test.mjs
```

The default Content tab formats returned Markdown as headings, tables, lists and code.
The Markdown tab displays the exact source; Copy there copies the raw Markdown.
Rendering uses local, pinned Marked and DOMPurify distributions. Release URLs, hashes
and licenses are in `vendor/`; no CDN request is required. Source HTML is sanitized
and remote images are not loaded automatically.
