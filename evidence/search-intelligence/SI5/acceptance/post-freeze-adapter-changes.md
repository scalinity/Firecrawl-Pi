# Adapter changes after the freeze, and whether the collection could have felt them

The collection ran at the frozen configuration (`eval/frozen.json`, commit `8598be4`; 18 queries from Q099 at `fe923a7`, which changed only the collector). Two provider adapters changed afterwards and were not re-measured on the corpus: Ref's result parser (`7a62351`) and Context7's rate-limit header handling (`5f4f1fe`). The raw provider answers were not kept (a run's lane record holds each candidate's URL, title and a text hash), so the corpus cannot be replayed through today's adapters. What can be checked is whether the changed code was reachable in the 120 runs, from the lane outcomes the runs did keep. The figures below are over profile D's lanes, which are the live ones; B, C and the ablations replay them.

## Context7, `5f4f1fe`: read only whole rate-limit counts, bound a reported reset

The change applies when Context7 answers 429. Across the 91 Context7 lanes the outcomes were 89 `success_results` and 2 `success_empty`: not one rate-limited or quota-exhausted. The changed path was never reached, so no result of the collection can differ.

## Ref, `7a62351`: parse a hosted result by its own shape before any refusal

The change decides whether a Ref text block is a result or a refusal, and how a hosted result is titled. Across the 91 Ref lanes the outcomes were 73 `success_results` and 18 `success_empty` (Ref's exact "no results" sentinel, which the change leaves alone). None was refused or failed, so the case it fixes, a result wrongly taken for a refusal because its breadcrumb said "unauthorized", did not occur.

The other direction, a notice that ends in a link being taken for a result before the change, would have left candidates from the service itself or notice text. Of the 258 Ref candidates, none is hosted at `ref.tools` or `ref.dev`, all come from 22 documentation hosts (GitHub 168, docs.python.org 16, modelcontextprotocol.io 8, and others), and every one has a usable title. Three titles contain the word "upgrade" and are documentation pages (a WebSocket handshake reference and two Terraform upgrade-guide sections).

What remains is the title of a hosted block that has no `page='…'` field: it is now the first line of the block, and was the first sentence of its description. A title is one of Jev's inputs, so a rank could differ by a small amount for such blocks. The corpus cannot show how many there were, and Ref contributes few documents that reach a top ten (33 relevant documents only Ref found, across the 96 queries).

## What this note concludes

The quality figures describe the frozen-commit adapters. For Context7 that is identical to HEAD's behaviour on this corpus. For Ref the parse is identical wherever the collection's answers parsed at all (no lane failed), and the title of a block without a `page` field may differ. That residual is named here as a limitation rather than measured; the ranking code (`rank.mjs`, `normalize.mjs`, `documentation.mjs`) is unchanged since the freeze.
