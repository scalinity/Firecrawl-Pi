// Turns the raw L01 observations (the live run's l01-live.jsonl and the fixture benchmark's l01-fixture.jsonl) into the figures the criterion asks for:
// per named scenario the count, p50, p95, max against the 23 s target and the 60 s request deadline, with the cold/served-from-cache split, resident
// memory, and what the four-concurrent and cancellation runs showed. Reads two files, writes one JSON summary and prints a table; no judgment here.
//   node analyze.mjs live.jsonl fixture.jsonl > summary.json
import { readFileSync } from "node:fs";
const lines = (f) => { try { return readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const live = lines(process.argv[2]), fx = lines(process.argv[3]);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] : null; };
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.length ? Math.max(...xs) : null, mean: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null });
const TARGET = 23000, DEADLINE = 60000;
const out = { target_ms: TARGET, request_deadline_ms: DEADLINE, live: {}, fixture: {}, memory: {} };
for (const sc of [...new Set(live.filter((r) => r.kind === "search").map((r) => r.scenario))]) {
  const rows = live.filter((r) => r.kind === "search" && r.scenario === sc), ok = rows.filter((r) => r.status === 200);
  const cold = ok.filter((r) => r.cache === "miss"), client = cold.map((r) => r.clientMs), server = cold.map((r) => r.serverTotalMs).filter(Number.isFinite);
  out.live[sc] = { requested: rows.length, answered_200: ok.length, not_200: rows.filter((r) => r.status !== 200).map((r) => ({ id: r.id, status: r.status, error: r.error })), cold: cold.length, not_cold: ok.length - cold.length, client_ms: stats(client), server_total_ms: stats(server),
    over_target: client.filter((x) => x > TARGET).length, over_deadline: client.filter((x) => x > DEADLINE).length, outcomes: Object.fromEntries([...new Set(ok.map((r) => r.outcome))].map((o) => [o, ok.filter((r) => r.outcome === o).length])),
    ranking: Object.fromEntries([...new Set(ok.map((r) => `${r.ranking}/${r.rankingReason}`))].map((o) => [o, ok.filter((r) => `${r.ranking}/${r.rankingReason}` === o).length])), warnings: Object.fromEntries([...new Set(ok.flatMap((r) => r.warnings ?? []))].map((w) => [w, ok.filter((r) => (r.warnings ?? []).includes(w)).length])) };
}
for (const sc of [...new Set(fx.filter((r) => r.kind === "summary").map((r) => r.scenario))]) { const s = fx.find((r) => r.kind === "summary" && r.scenario === sc); out.fixture[sc] = { n: s.n, p50: s.p50, p95: s.p95, max: s.max, min: s.min, outcomes: s.outcomes, ranking: s.rankingModes, deadline_breaches: s.deadlineBreaches, over_target: fx.filter((r) => r.kind === "search" && r.scenario === sc && r.ms > TARGET).length }; }
const cancel = fx.find((r) => r.kind === "cancel_summary"); if (cancel) out.fixture.fixture_cancel = { rounds: cancel.rounds, reserved_rows_left: cancel.reservedRowsLeft };
const done = fx.find((r) => r.kind === "done"); if (done) out.memory.fixture_process = { peak_rss_mib: done.peakRssMiB, cgroup_peak_bytes: done.cgroupPeakBytes };
const hostMem = fx.filter((r) => r.kind === "host").map((r) => r.memAvailableMiB); if (hostMem.length) out.memory.host_available_mib_during_fixture = { min: Math.min(...hostMem), max: Math.max(...hostMem), samples: hostMem.length };
const mem = live.filter((r) => r.kind === "mem" && r.mem && !r.mem.error); if (mem.length) { const peak = {}; for (const m of mem) for (const [k, v] of Object.entries(m.mem)) { const mib = /GiB/.test(v) ? parseFloat(v) * 1024 : parseFloat(v); peak[k] = Math.max(peak[k] ?? 0, Math.round(mib)); }
  out.memory.live_peak_mib = peak; out.memory.host_available_mib_during_live = { min: Math.min(...mem.map((m) => m.memAvailableMiB)), max: Math.max(...mem.map((m) => m.memAvailableMiB)), samples: mem.length }; }
console.log(JSON.stringify(out, null, 1));
