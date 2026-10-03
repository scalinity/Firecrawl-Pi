# Selected AI surface audit — PRE-M9 closure

Baseline: `c622e80`; upstream `7666c1f9ae8720a6bba271e0f60b6a217f8a5210`, patch series unchanged.
This dated evidence supplements the original M5 report; it is not a new architecture document.

| Feature | Selection | Actual project path | Provider/secret | Selection and reservation | Verification |
| --- | --- | --- | --- | --- | --- |
| Scrape JSON / schema extraction | Required | `services/access/src/jsonscrape.mjs` → `extractor.mjs` → retrieval `/internal/extract` → `services/retrieval/src/extract.mjs` | OpenAI chat completions at the official endpoint; `openai_api_key` in the restricted provider directory | Host selection, budget model allowlist, one atomic reservation for each chunk/repair | M5 E01/E03/E04 fixtures; E05 live |
| Explicit URL `/v2/extract`, schema-driven durable jobs | Required | `services/access/src/extract.mjs` → core scrape → `extractor.mjs` → same adapter | Same OpenAI abstraction and secret; gateway/core have no provider key | Same allowlist; durable job/call keys and persisted receipts; one repair at most per chunk | M5 E02 fixtures; E05 live |
| Native PDF/DOCX parsing | Required, not an LLM path | `patches/0008-document-policy-and-parser-fallback.patch` | Native document parser, no OpenAI key | Native first, quality-based escalation only | M5 D01/D02 |
| Complex/scanned documents | Required external fallback | Patched core → `services/retrieval/src/parse.mjs` | LlamaParse cost-effective; owner `LLAMA_CLOUD_API_KEY` maps to `llamaparse_api_key` | Page × credit reservation, owner-scoped byte/options cache; cleanup when file ID is provided (live multipart jobs had none and use documented 48-hour expiry) | M5 D03 live and parser fixture suite |
| Search | Required, not an LLM path | SearXNG → guarded search proxy | No OpenAI call; residential engines use Decodo independently | Shared policy, pacing, proxy reservation | M5 S01–S05; M6 L02 / M5 F11 live |
| Native AI summary/question/query/highlights, deterministic JSON, prompt-generated crawl options, JSON batch/crawl | Unsupported | Refused by `services/access/src/validate.mjs` and `deploy/policies/capabilities.json` before core forwarding | Native upstream model paths disabled; core has no model credential/configuration | No advertised capability and no paid dispatch path | Gateway contract/manifest fixtures |
| Image-alt generation, embeddings, semantic transforms, discovery-style Cloud Agent | Unsupported / not selected | No project capability or adapter exposed | No secret injected | No model fallback or experimental activation | Capability manifest / gateway denial |

GPT-6 Luna is the only paid model in the policy. `reasoning_effort=none`, strict structured output,
`store=false`, `service_tier=default`, and explicit cache mode without breakpoints preserve the selected
deterministic, bounded contract. Reported ordinary, cached, cache-write and output tokens are priced
separately. Missing/malformed usage is charged conservatively at the full reservation.

Official contract/rate sources checked on 2026-10-02:

- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/guides/latest-model
- https://developers.openai.com/api/docs/guides/prompt-caching

Production paid caps remain zero. The owner-authorized session override is temporary, with lower caps
than the authorization ceilings and a host timer that restores base Compose. No provider alternative,
Firecrawl Cloud route, upstream model path, public publication or recurring spend profile is enabled.
