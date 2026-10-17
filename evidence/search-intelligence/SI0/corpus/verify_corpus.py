#!/usr/bin/env python3
"""Check corpus-v1.json against the SI0 corpus requirements; print counts; exit 1 on any failure."""
import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone

path = sys.argv[1]
c = json.load(open(path, encoding="utf-8"))
Q = c["queries"]
errors = []

CATS = [x["key"] for x in c["categories"]]
REL = {"positive", "negative", "ambiguous_positive", "ambiguous_negative"}
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
HOST = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")


def check(cond, msg):
    if not cond:
        errors.append(msg)


def parse(ts):
    return datetime.strptime(ts.replace("Z", ""), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)


check(c.get("schema") == "fcpi.si-corpus/v1", "schema")
check(c.get("asOf") == "2026-10-17T00:00:00Z", "top-level asOf")
check(len(CATS) == 12 and len(set(CATS)) == 12, "12 unique categories")
check(len(Q) == 120, f"query count {len(Q)}")
ids = [q["id"] for q in Q]
check(len(set(ids)) == 120 and ids == [f"Q{i:03d}" for i in range(1, 121)], "ids Q001..Q120 unique and ordered")
check(len({q["query"] for q in Q}) == 120, "unique query texts")

for q in Q:
    i = q["id"]
    check(q["category"] in CATS, f"{i} category")
    check(q["split"] in ("tuning", "heldout"), f"{i} split")
    check(1 <= len(q["query"]) <= 500, f"{i} length {len(q['query'])}")
    check(q["asOf"] == "2026-10-17T00:00:00Z", f"{i} asOf")
    check(q["documentationRelevance"] in REL, f"{i} relevance")
    check(isinstance(q["documentationExplicit"], bool), f"{i} explicit bool")
    check(isinstance(q["expectNoMatch"], bool), f"{i} expectNoMatch bool")
    check(2 <= len(q["requiredEvidence"]) <= 4, f"{i} requiredEvidence count")
    vc = q["versionConstraint"]
    check(vc is None or (vc.get("library") and vc.get("version")), f"{i} versionConstraint shape")
    pos = int(i[1:]) - (CATS.index(q["category"])) * 10
    check(q["split"] == ("tuning" if pos in (3, 8) else "heldout"), f"{i} split rule")
    cons = q["constraints"]
    check(not (cons.get("includeDomains") and cons.get("excludeDomains")), f"{i} include+exclude both set")
    for k in ("includeDomains", "excludeDomains"):
        for h in cons.get(k, []):
            check(bool(HOST.match(h)), f"{i} hostname {h!r}")
    si = q["searchIntelligence"]
    if si is not None:
        check(si.get("documentation") in ("auto", "required", "off"), f"{i} si.documentation")
        check(len(si.get("libraries", [])) <= 4, f"{i} si.libraries > 4")
        check(not (set(si) & {"includeDomains", "excludeDomains"}), f"{i} domains inside si")
    for obj in (cons, si or {}):
        for k in ("publishedAfter", "publishedBefore"):
            if k in obj:
                check(bool(ISO.match(obj[k])), f"{i} {k} not ISO-8601 Z: {obj[k]}")
        if "publishedAfter" in obj and "publishedBefore" in obj and ISO.match(obj["publishedAfter"]) and ISO.match(obj["publishedBefore"]):
            check(parse(obj["publishedAfter"]) < parse(obj["publishedBefore"]), f"{i} publishedAfter >= publishedBefore")
        if "dateMode" in obj:
            check(obj["dateMode"] in ("freshness", "strict_publication"), f"{i} dateMode")

per_cat = Counter(q["category"] for q in Q)
per_cat_split = Counter((q["category"], q["split"]) for q in Q)
for k in CATS:
    check(per_cat[k] == 10, f"{k} has {per_cat[k]}")
    check(per_cat_split[(k, "tuning")] == 2 and per_cat_split[(k, "heldout")] == 8, f"{k} split counts")

held = [q for q in Q if q["split"] == "heldout"]
docs_pos_held = sum(q["documentationRelevance"] in ("positive", "ambiguous_positive") for q in held)
ver_held = sum(q["versionConstraint"] is not None for q in held)
check(docs_pos_held >= 32, f"heldout docs-positive {docs_pos_held} < 32")
check(ver_held >= 12, f"heldout version-constrained {ver_held} < 12")

print(f"queries={len(Q)} unique_ids={len(set(ids))} unique_texts={len({q['query'] for q in Q})}")
print("per category (tuning/heldout):")
for k in CATS:
    print(f"  {k}: {per_cat_split[(k, 'tuning')]}/{per_cat_split[(k, 'heldout')]}")
split = Counter(q["split"] for q in Q)
print(f"split: tuning={split['tuning']} heldout={split['heldout']}")
rel_held = Counter(q["documentationRelevance"] for q in held)
print(f"heldout docs-positive (positive+ambiguous_positive)={docs_pos_held} {dict(rel_held)}")
print(f"heldout docs-positive outside software_documentation={sum(q['documentationRelevance'] in ('positive','ambiguous_positive') and q['category']!='software_documentation' for q in held)}")
print(f"heldout version-constrained={ver_held} (all={sum(q['versionConstraint'] is not None for q in Q)})")
print(f"expectNoMatch={sum(q['expectNoMatch'] for q in Q)} time_window={sum('time_window' in q['secondaryTags'] for q in Q)} "
      f"code_fence={sum('code_fence' in q['secondaryTags'] for q in Q)} long_query(>128)={sum(len(q['query'])>128 for q in Q)} "
      f"restricted_domain={sum('restricted_domain' in q['secondaryTags'] for q in Q)} searchIntelligence_nonnull={sum(q['searchIntelligence'] is not None for q in Q)}")
print(f"query length min={min(len(q['query']) for q in Q)} max={max(len(q['query']) for q in Q)}")
if errors:
    print("FAIL")
    for e in errors:
        print("  -", e)
    sys.exit(1)
print("PASS")
