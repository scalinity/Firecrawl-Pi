#!/usr/bin/env python3
"""L01, the live half (spec §23.3, acceptance criterion L01): cold searches through the deployed platform, one active at a time, measured ON the Pi
against the gateway's loopback publication, so no tunnel or forwarder is in the timing. Runs as a systemd unit (a dropped SSH session cannot stop it) and
paces itself under the platform's own 60-searches-an-hour admission, which it does not touch. One JSON line per search goes to the output file, and one per
sample of the stack's resident memory. The plan holds the request bodies and their scenario; no secret and no page text is written.
    python3 l01.py plan.json out.jsonl
"""
import http.client, json, sys, threading, time, subprocess

PLAN = json.load(open(sys.argv[1]))
OUT = open(sys.argv[2], "a", buffering=1)
TOKEN = open("/etc/firecrawl-pi/secrets/clients/m9codex.token").read().strip()
GAP = float(PLAN.get("gapSeconds", 62))


def emit(o):
    o["utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    OUT.write(json.dumps(o) + "\n")


def post(body, timeout=110):
    t0 = time.monotonic()
    c = http.client.HTTPConnection("127.0.0.1", 3380, timeout=timeout)
    try:
        c.request("POST", "/v2/search", json.dumps(body), {"content-type": "application/json", "authorization": "Bearer " + TOKEN})
        r = c.getresponse()
        raw = r.read()
        ms = (time.monotonic() - t0) * 1000
        try:
            j = json.loads(raw)
        except Exception:
            j = None
        return r.status, ms, j, len(raw), r.getheader("retry-after")
    except Exception as e:
        return 0, (time.monotonic() - t0) * 1000, {"error": str(e)[:120]}, 0, None
    finally:
        c.close()


def search_of(j):
    if not isinstance(j, dict):
        return {}
    return ((j.get("fcpi") or {}).get("search")) or (((j.get("data") or {}).get("fcpi") or {}).get("search")) or {}


def record(item, status, ms, j, size):
    s = search_of(j)
    cov = (s.get("coverage") or {})
    act = ((s.get("documentation") or {}).get("activation")) or {}
    web = j.get("web") if isinstance(j, dict) and isinstance(j.get("web"), list) else ((j or {}).get("data") or {}).get("web", []) if isinstance(j, dict) else []
    return {"kind": "search", "scenario": item["scenario"], "id": item["id"], "status": status, "clientMs": round(ms), "serverTotalMs": (s.get("timings") or {}).get("totalMs"),
            "outcome": s.get("outcome"), "cache": (s.get("cache") or {}).get("mode"), "ranking": (s.get("ranking") or {}).get("mode"), "rankingReason": (s.get("ranking") or {}).get("reason"),
            "rows": len(web) if isinstance(web, list) else None, "bytes": size, "warnings": s.get("warnings"), "activation": {"active": act.get("active"), "reason": act.get("reason"), "probability": act.get("uncertainty")},
            "docsRequested": (cov.get("documentation") or {}).get("requested"), "versions": (cov.get("documentation") or {}).get("versions"), "enrichment": ((s.get("documentation") or {}).get("enrichment")),
            "generalSuccessful": (cov.get("general") or {}).get("successful"), "error": (j or {}).get("code") if isinstance(j, dict) else None,
            # The public URLs of the rows (no page text), so a live answer can be checked against the judged labels; and what the search said about the requested versions.
            "urls": [w.get("url") for w in web[:10] if isinstance(w, dict)] if isinstance(web, list) else None,
            "versionRows": (cov.get("documentation") or {}).get("versionRows"),
            # Each returned row's own version constraint status (satisfied: a documentation scope or its URL confirmed the requested release; unverified: nothing could be checked), in the order of `urls`.
            "rowVersion": [next((c.get("status") for c in (((w.get("fcpi") or {}).get("search") or {}).get("constraintStatus") or []) if isinstance(c, dict) and c.get("constraint") == "version"), None) for w in web[:10] if isinstance(w, dict)] if isinstance(web, list) else None}


def sampler(stop):
    while not stop.is_set():
        mem = {}
        try:
            for line in subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.Name}}|{{.MemUsage}}"], capture_output=True, text=True, timeout=30).stdout.splitlines():
                n, u = line.split("|", 1)
                if n.startswith("fcpi-") and any(k in n for k in ("retrieval", "access-gateway", "mcp-gateway", "firecrawl-core", "nuq-postgres", "redis", "rabbitmq", "browser", "searxng")):
                    mem[n.replace("fcpi-", "").replace("-1", "")] = u.split("/")[0].strip()
        except Exception as e:
            mem = {"error": str(e)[:80]}
        avail = None
        for l in open("/proc/meminfo"):
            if l.startswith("MemAvailable:"):
                avail = int(l.split()[1]) // 1024
        emit({"kind": "mem", "mem": mem, "memAvailableMiB": avail})
        stop.wait(10)


stop = threading.Event()
threading.Thread(target=sampler, args=(stop,), daemon=True).start()
emit({"kind": "start", "items": len(PLAN["items"]), "gapSeconds": GAP})
last = 0.0
for item in PLAN["items"]:
    if item.get("group"):  # a round of simultaneous searches, for the four-concurrent look
        wait = GAP * len(item["group"]) - (time.monotonic() - last)
        if last and wait > 0:
            time.sleep(wait)
        last = time.monotonic()
        results = [None] * len(item["group"])

        def one(i, body):
            results[i] = post(body)
        ts = [threading.Thread(target=one, args=(i, b)) for i, b in enumerate(item["group"])]
        [t.start() for t in ts]
        [t.join() for t in ts]
        for i, r in enumerate(results):
            emit({**record({"scenario": item["scenario"], "id": f"{item['id']}.{i}"}, r[0], r[1], r[2], r[3]), "group": item["id"], "concurrent": len(item["group"])})
        continue
    wait = GAP - (time.monotonic() - last)
    if last and wait > 0:
        time.sleep(wait)
    for attempt in range(1, 4):
        last = time.monotonic()
        status, ms, j, size, retry = post(item["body"])
        if status == 429 and retry:  # the platform's own admission: wait as told, then ask again, and say so
            emit({"kind": "admission_wait", "id": item["id"], "retryAfter": retry})
            time.sleep(min(float(retry) + 1, 900))
            continue
        break
    emit({**record(item, status, ms, j, size), "attempt": attempt})
emit({"kind": "done"})
stop.set()
