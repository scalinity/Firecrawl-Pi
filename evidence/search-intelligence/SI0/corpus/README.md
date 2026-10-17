# SI0 evaluation corpus, version 1

`corpus-v1.json` (schema `fcpi.si-corpus/v1`) holds 120 frozen search queries for comparing the search profiles (legacy single engine, five-engine aggregate, semantic reranker, documentation-source augmentation). Every query has `asOf` `2026-10-17T00:00:00Z`.

## How it was written

- A fresh-context agent wrote it from model knowledge alone. That agent never read anything under `services/`, never ran a search, scrape or MCP tool and never browsed, so the corpus is independent of the implementation it measures.
- Labels (`documentationRelevance`, `versionConstraint`, `requiredEvidence`, `expectNoMatch`) were written before any result existed. `requiredEvidence` lists 2 to 4 concrete, checkable items that a good source page must contain.
- Queries keep identifiers, code symbols, negations (`without`, `not`, `-term`), quoted phrases and version strings exactly as a developer would type them. Three contain code fences or compiler or stack-trace lines, six are longer than 128 characters, and several are short navigational queries.
- `secondaryTags` mixes authored tags (such as `navigational` or `independent_reporting`) with tags derived mechanically from the fields: `docs_positive`/`docs_negative`/`docs_ambiguous`/`docs_explicit`, `version_constraint`, `no_match_expected`, `code_fence`, `long_query` (over 128 code points), `time_window` and `restricted_domain`.

## Split rule (fixed before any query was written)

Within each category the ten queries are numbered 1 to 10 in authoring order. Positions 3 and 8 are `tuning`; the other eight are `heldout`. The id is `Q{(categoryIndex-1)*10 + position}`, so the tuning ids are Q003, Q008, Q013, Q018 and so on up to Q113 and Q118.

## Counts

| Category | Tuning | Held out |
|---|---|---|
| each of the 12 categories | 2 | 8 |
| total | 24 | 96 |

- Documentation-positive held-out queries (`positive` + `ambiguous_positive`): 43. Of these, 35 fall outside `software_documentation`. Requirement: at least 32.
- Version-constrained held-out queries: 19 (23 across the whole corpus). Requirement: at least 12.
- `expectNoMatch`: 2 (Q117, a Python 4.0 page on docs.python.org; Q119, pandas restricted to kubernetes.io). `time_window`: 8. `restricted_domain`: 7. Non-null `searchIntelligence`: 43.

## Request mapping

- `constraints.includeDomains` and `constraints.excludeDomains` go to the top-level request fields. They are hostnames only, and no query sets both.
- `constraints.publishedAfter`, `constraints.publishedBefore` and `constraints.dateMode` go to the `searchIntelligence` fields of the same names.
- When `searchIntelligence` is non-null it is sent as written. It is set only where a real caller would plausibly send documentation, library or version hints.

## How the relative windows were resolved

Each window was resolved once against `asOf` and stored as absolute UTC bounds, with `dateMode` `strict_publication`:

| Phrase | Query | Resolved window |
|---|---|---|
| "last 30 days" | Q061 | 2026-09-17T00:00:00Z to 2026-10-17T00:00:00Z |
| "this year" | Q063 | 2026-01-01T00:00:00Z to 2026-10-17T00:00:00Z |
| "past week" | Q064 | 2026-10-10T00:00:00Z to 2026-10-17T00:00:00Z |
| "last 90 days" | Q067 | 2026-07-19T00:00:00Z to 2026-10-17T00:00:00Z |
| "yesterday" | Q069 | 2026-10-16T00:00:00Z to 2026-10-17T00:00:00Z |

Explicit months were resolved to their calendar bounds: October 2025 for Q062 and Q066, September 2025 for Q068. Queries that say "latest" (Q013, Q065) or name a date only as their subject (Q070) carry no window.

## Limitations

- The queries and labels come from model knowledge, with a cutoff before `asOf`. Facts in `requiredEvidence`, such as dates, version numbers and arXiv ids, are the author's recollection. Evaluators judge them against captured pages, not against this file.
- Time-sensitive truths are unverified until capture. Q061, Q063, Q064, Q067 and Q069 may have no in-window publication; in that case an empty in-window result is correct. Q065 notes the quarterly schedule but does not assert which release is latest.
- Where the author was unsure a fact exists, the query is phrased as a question (for example Q031, which asks which mlx-lm release dropped `temp`, and Q059, on the MCP 2025-11-25 changes). Such queries carry no `versionConstraint`, or no asserted specifics.
- Documentation relevance is a single judgement per query. The `ambiguous_*` labels mark cases where both readings are defensible.
- The split is positional, not stratified by tag, so the tuning set's tag mix is whatever positions 3 and 8 happen to hold.
