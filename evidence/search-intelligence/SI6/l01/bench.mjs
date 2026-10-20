// L01, the fixture half (spec §23.3, acceptance criterion L01): the search coordinator of the deployed retrieval image, on the Pi, against loopback
// transport fixtures that supply what live providers cannot repeat on demand: a stalled discovery provider, a stalled Jev, four searches at once,
// and cancellation. The coordinator, the adapters, the ranking and the deployed policy's timings are the release's own (12 s for discovery, 8 s for Jev,
// the 60 s request default); only the provider endpoints are fixtures, so these timings are fixture timings and are labelled so. Sent to a throwaway
// container (no network but loopback, read-only root, the service's uid, labelled fcpi.transient) on stdin. One JSON line per observation.
//   N=30 node --input-type=module -     (stdin: this file)
import { readFileSync } from "node:fs";
const { harness, request, answers } = await import("file:///srv/retrieval/test/si-helpers.mjs");
const N = Number(process.env.N ?? 30), ROUNDS = Number(process.env.ROUNDS ?? 8);
const only = (process.env.ONLY ?? "").split(",").filter(Boolean), want = (s) => !only.length || only.includes(s);
const emit = (o) => console.log(JSON.stringify({ utc: new Date().toISOString(), ...o }));
const never = () => new Promise(() => {});
// A Jev (OpenRouter Decisions) fixture that answers every question by its type, as the tests' own does.
const jev = (q, entry) => { const a = {}; for (const [k, qu] of Object.entries(entry.body.questions)) a[k] = qu.type === "score" ? { type: "score", score: 2 } : qu.type === "noul" ? { type: "noul", noul: 0.8 } : { type: "choice", choice: Object.keys(qu.criteria)[0] };
  return { status: 200, body: { model: "typesafe/jev-1.14-20261001", answers: a, usage: { input_tokens: 100, output_tokens: 10 } } }; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] : null; };
const cg = () => { for (const f of ["/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"]) { try { return Number(readFileSync(f, "utf8").trim()); } catch { /* next */ } } return null; };
let peakRss = 0; const rssTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 250);
const req = (n, tag) => request({ originalQuery: `l01 ${tag} query number ${n} ${Math.random().toString(36).slice(2, 8)}`, absoluteDeadlineMs: Date.now() + 60000 });
const summarize = (scenario, rows) => { const ms = rows.map((r) => r.ms); emit({ kind: "summary", scenario, n: rows.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: Math.max(...ms), min: Math.min(...ms), outcomes: Object.fromEntries([...new Set(rows.map((r) => r.outcome))].map((o) => [o, rows.filter((r) => r.outcome === o).length])),
  rankingModes: Object.fromEntries([...new Set(rows.map((r) => `${r.rankingMode}/${r.rankingReason}`))].map((o) => [o, rows.filter((r) => `${r.rankingMode}/${r.rankingReason}` === o).length])), deadlineBreaches: rows.filter((r) => r.ms > 60000).length }); };
const one = async (h, scenario, i, signal) => { const t0 = Date.now(); const r = await h.coordinator.search(req(i, scenario), { signal: signal ?? new AbortController().signal }); const ms = Date.now() - t0; const s = r.body?.search ?? {};
  const row = { kind: "search", scenario, i, ms, ok: r.ok ?? (r.status ? r.status < 400 : !!r.body), outcome: s.outcome ?? r.failure?.class ?? null, rankingMode: s.ranking?.mode ?? null, rankingReason: s.ranking?.reason ?? null, warnings: s.warnings ?? null, rows: r.body?.web?.length ?? null, serverTotalMs: s.timings?.totalMs ?? null };
  emit(row); return row; };

emit({ kind: "start", node: process.version, n: N, rounds: ROUNDS, cgroupPeakBefore: cg() });
const sequential = async (scenario, handlers) => { const h = await harness({ handlers }); const rows = []; try { for (let i = 1; i <= N; i++) rows.push(await one(h, scenario, i)); } finally { await h.close?.(); } summarize(scenario, rows); return rows; };
// One search at a time, cold (every query new), the three named scenarios.
// The breaker of a stalled provider opens after a few failures, so a run on one harness measures the sustained stall (the first searches pay the timeout, the rest skip it); the "each"
// scenarios give every search a fresh harness, so every search meets the stall with its breaker closed.
const fresh = async (scenario, handlers) => { const rows = []; for (let i = 1; i <= N; i++) { const h = await harness({ handlers }); try { rows.push(await one(h, scenario, i)); } finally { await h.close?.(); } } summarize(scenario, rows); return rows; };
if (want("fixture_baseline")) await sequential("fixture_baseline", { openrouter: jev });
if (want("fixture_discovery_stalled")) await sequential("fixture_discovery_stalled", { exa: never, openrouter: jev });
if (want("fixture_jev_stalled")) await sequential("fixture_jev_stalled", { openrouter: never });
if (want("fixture_discovery_stalled_each")) await fresh("fixture_discovery_stalled_each", { exa: never, openrouter: jev });
if (want("fixture_jev_stalled_each")) await fresh("fixture_jev_stalled_each", { openrouter: never });

// Four at once: deadline compliance, queueing, memory; each round's four are searched together.
if (want("fixture_concurrent4")) { const h = await harness({ handlers: { openrouter: jev } }); const rows = [];
  try { for (let r = 1; r <= ROUNDS; r++) rows.push(...await Promise.all([1, 2, 3, 4].map((k) => one(h, "fixture_concurrent4", r * 10 + k)))); } finally { await h.close?.(); }
  summarize("fixture_concurrent4", rows); }

// Cancellation: four at once with Jev stalled so they are in flight; two are cancelled early; afterwards nothing is left reserved or open, and the other two finish.
if (want("fixture_cancel")) { const leftovers = [];
  try { for (let r = 1; r <= 4; r++) { const h = await harness({ handlers: { openrouter: never } }); try { const acs = [0, 1, 2, 3].map(() => new AbortController()); setTimeout(() => { acs[0].abort(); acs[1].abort(); }, 1500);
      const done = await Promise.all(acs.map((ac, k) => one(h, "fixture_cancel", r * 10 + k, ac.signal).catch((e) => ({ ms: null, outcome: `threw:${e.code ?? e.message}` }))));
      await new Promise((res) => setTimeout(res, 1500));
      const reserved = [...(h.store.rows?.values?.() ?? [])].filter((x) => x.state === "RESERVED").length; leftovers.push({ round: r, cancelledOutcomes: done.slice(0, 2).map((x) => x.outcome), survivorOutcomes: done.slice(2).map((x) => x.outcome), reservedRowsLeft: reserved }); } finally { await h.close?.(); } }
  } finally { /* each round closed its own harness */ }
  emit({ kind: "cancel_summary", rounds: leftovers, reservedRowsLeft: leftovers.reduce((n, x) => n + x.reservedRowsLeft, 0) }); }

clearInterval(rssTimer);
emit({ kind: "done", peakRssMiB: Math.round(peakRss / 1048576), cgroupPeakBytes: cg() });
process.exit(0);
