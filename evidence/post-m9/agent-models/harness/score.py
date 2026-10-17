#!/usr/bin/env python3 -I
# Scores full.jsonl against tasks.json: an answer is correct when every expected pattern appears in the answer (or the
# structured result matches); for the no-answer task, correct means no population figure was asserted. Prints per-arm totals
# and a per-task grid; writes score.json.
import json, re, sys, statistics
from collections import defaultdict
here = sys.argv[1]
tasks = {t["id"]: t for t in json.load(open(f"{here}/tasks.json"))}
runs = [json.loads(l) for l in open(f"{here}/" + (sys.argv[2] if len(sys.argv) > 2 else "full.jsonl"))]

def correct(r):
    e = tasks[r["task"]]["expect"]
    ans = r.get("answer") or ""
    if "all" in e:
        return all(re.search(p, ans, re.I) for p in e["all"])
    if "result" in e:
        res = r.get("result") or {}
        x = e["result"]
        return res.get("first_release_year") == x["first_release_year"] and x["author"].lower() in str(res.get("author", "")).lower() and x["license"].lower() in str(res.get("license", "")).lower()
    if e.get("noFabrication"):
        return not re.search(r"\b\d{2,3}(,\d{3})*\b(?!\s*(census|United))", ans.replace("2020", ""))
    return False

arms = defaultdict(list)
for r in runs:
    r["correct"] = correct(r)
    arms[r["arm"]].append(r)
out = {}
print(f"{'arm':12s} {'correct':>8s} {'completed':>9s} {'grounded':>8s} {'median s':>8s} {'mean $':>7s} {'total $':>7s}  stop codes")
for arm, rs in sorted(arms.items()):
    n = len(rs)
    codes = defaultdict(int)
    for r in rs: codes[r.get("code") or r.get("status") or "none"] += 1
    row = dict(n=n, correct=sum(r["correct"] for r in rs), completed=sum(r.get("status") == "completed" for r in rs),
               completedCorrect=sum(r.get("status") == "completed" and r["correct"] for r in rs),
               medianS=round(statistics.median(r["wallMs"] for r in rs) / 1000), meanUsd=round(sum(r["costMicroUsd"] for r in rs) / n / 1e6, 4),
               totalUsd=round(sum(r["costMicroUsd"] for r in rs) / 1e6, 3), codes=dict(codes))
    out[arm] = row
    print(f"{arm:12s} {row['correct']:>4d}/{n:<3d} {row['completed']:>5d}/{n:<3d} {row['completedCorrect']:>4d}/{n:<3d} {row['medianS']:>8d} {row['meanUsd']:>7.4f} {row['totalUsd']:>7.3f}  {dict(codes)}")
print()
grid = defaultdict(dict)
for r in runs: grid[r["task"]].setdefault(r["arm"], []).append(("✓" if r["correct"] else "✗") + ("c" if r.get("status") == "completed" else "p" if r.get("status") == "partial" else "f"))
print(f"{'task':22s} " + " ".join(f"{a:>12s}" for a in sorted(arms)))
for t in tasks:
    print(f"{t:22s} " + " ".join(f"{' '.join(grid[t].get(a, [])):>12s}" for a in sorted(arms)))
json.dump({"arms": out, "runs": [{k: r[k] for k in ("arm", "task", "rep", "status", "code", "correct", "wallMs", "costMicroUsd")} for r in runs]}, open(f"{here}/score-" + (sys.argv[2] if len(sys.argv) > 2 else "full.jsonl").replace(".jsonl", ".json"), "w"), indent=1)
