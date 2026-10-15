# Local playground

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

Examples only fill the composer. Only Run submits work. Opening the page makes a
read-only gateway health check. LLM extraction starts off and uses the existing
approved policy when enabled; normal retrieval can still use separately budgeted
proxy routing. No budget or provider setting is changed by the playground.

Responses and recent requests are held in tab memory, not saved automatically.
Save JSON downloads the current response to a local file. Scraped content is displayed
as text, never executed as HTML. Closing the tab does not cancel a durable crawl;
use its job ID to check or cancel it. A lost synchronous response may still have
consumed retrieval/model budget: the playground never automatically retries it.

Run the local bridge checks with `node --test tests/playground.test.mjs`.
