# Adapter changes after the freeze, and whether the collection could have felt them

The collection ran at the frozen configuration (`eval/frozen.json`, commit `8598be4`; 18 queries from Q099 at `fe923a7`, which changed only the collector). Two provider adapters changed afterwards and were not re-measured on the corpus: Ref's result parser (`7a62351`) and Context7's rate-limit header handling (`5f4f1fe`). The raw provider answers were not kept (a run's lane record holds each candidate's URL, title and a text hash), so the corpus cannot be replayed through today's adapters. What can be checked is whether the changed code was reachable in the 120 runs, from the lane outcomes the runs did keep. The figures below are over profile D's lanes, which are the live ones; B, C and the ablations replay them.

## Context7, `5f4f1fe`: read only whole rate-limit counts, bound a reported reset

The change applies when Context7 answers 429. Across the 91 Context7 lanes the outcomes were 89 `success_results` and 2 `success_empty`: not one rate-limited or quota-exhausted. The changed path was never reached, so no result of the collection can differ.

## Ref, `7a62351`: parse a hosted result by its own shape before any refusal

The change decides whether a Ref text block is a result or a refusal, and how a hosted result is titled. Across the 91 Ref lanes the outcomes were 73 `success_results` and 18 `success_empty` (Ref's exact "no results" sentinel, which the change leaves alone). None was refused or failed, so the case it fixes, a result wrongly taken for a refusal because its breadcrumb said "unauthorized", did not occur.

The other direction, a notice that ends in a link being taken for a result before the change, would have left candidates from the service itself or notice text. Of the 258 Ref candidates, none is hosted at `ref.tools` or `ref.dev`, all come from 22 documentation hosts (GitHub 168, docs.python.org 16, modelcontextprotocol.io 8, and others), and every one has a usable title. Three titles contain the word "upgrade" and are documentation pages (a WebSocket handshake reference and two Terraform upgrade-guide sections).

What remains is the title of a hosted block that has no `page='…'` field: it is now the first line of the block, and was the first sentence of its description. A title is one of Jev's inputs, so a rank could differ by a small amount for such blocks. The corpus cannot show how many there were, and Ref contributes few documents that reach a top ten (33 relevant documents only Ref found, across the 96 queries).

## Context7's version evidence, `730b623`

A Context7 scope now reports a version verdict, and a library id that names a version is evidence of it; a passage whose id names another version is left out. The acceptance review measured its effect on the frozen collection (`SI5/ACCEPTANCE.md`, "F03 after the change"): of 30 version-scoped top-20 documents in D and D-C7, 4 would lose their Context7 passages, all Q117's documents at ranks 15 and 17 (graded 1 and 0), so no gated figure moves.

## Ref, `5e035b2` and `49bee98`: read unmarked result blocks, but not a lone notice

After the cutover the live run showed Ref sending result blocks with no `page='…'`, `section='…'` or breadcrumb marker, which the parser of `7a62351` refused as unrecognised text (5 of about 25 live searches). A block of that form is now a result unless its description opens with a refusal or its link is `ref.tools`, and a lone unmarked block that reads like a notice fails closed. The collection's 91 Ref lanes had no refused answer, so no collected result could differ: the case the change fixes did not occur there, and the raw answers were not kept to say whether any block beside a marked one was dropped before the change. That residual is named here, not measured.

## The exact-version rule, `dec9694`: the one change to a ranking file

`normalize.mjs` changed, and the earlier version of this note said it had not. A general candidate whose URL states another release of a requested library is now removed before ranking (spec §6.1, §11.2), and each returned row says whether its URL confirmed the version. The rule was written from the spec's principle before it was measured and was not adjusted afterwards. `scripts/si5/version-rule-measure.mjs` measures it from the stored runs and labels (output: `version-rule-measure.json`), after reproducing the published macro nDCG@10 of A and D exactly.

- **Against the judged labels**, D's top-10 rows of the 16 held-out queries that carry a hard version: 20 rows were judged a version mismatch; the rule catches 11 and misses 9: 8 state no release in the URL (`webpack.js.org/plugins/…` for webpack 4, `postgresql.org/docs/current/…`, a mirror's copy) and 1 is a documentation row, which a scope judges. It flags 3 rows that were not judged a mismatch: 2 judged a match (a pandas 1.5 and an aws 6.28 page that the judges kept as relevant to a 2.0 and a 5.x question) and 1 not applicable. 17 rows agree with it as a match.
- **On the gated figures**, if the aggregate profiles B, C and D lose the flagged rows and the next-ranked rows move up: Q01 (D over A) moves from +47.4% to +47.8% and Q02 (C over B) from +0.1059 to +0.1053. Five of the six affected queries gain nDCG@10 (Q002 +0.03, Q010 +0.02, Q111 +0.05, Q117 +0.06, Q120 +0.04) and one loses (Q116 −0.02). No gate changes verdict.
- **What this is not.** A rerun of the comparison would recompute fusion and the shortlist without the removed rows; this moves the next-ranked rows up in the stored order. And it does not take F03's count to zero: 9 of the 20 judged mismatches state no release in their URL and stay in an answer, now counted as unverified in `coverage.documentation.versionRows` and warned as `version_rows_unverified`.

## What this note concludes

The quality figures describe the frozen-commit adapters and normalizer. For Context7 the change of `5f4f1fe` is identical to HEAD's behaviour on this corpus, and `730b623` moves no gate. For Ref the parse is identical wherever the collection's answers parsed at all, and the title of a block without a `page` field may differ (a residual named, not measured). The exact-version rule changes the rows an answer keeps for the 16 hard-version queries, and its measured effect on the gates is +0.4 points on Q01's relative improvement and −0.0006 on Q02; the rest of the ranking code (`rank.mjs`, `documentation.mjs`) is unchanged since the freeze.
