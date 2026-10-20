// Turns the live run's observations (l01-live.jsonl, written by l01.py on the Pi) into the figures the acceptance criteria ask for, from the
// plan that drove it (plan.json) and the frozen corpus. Reads files, prints one JSON object; it judges nothing.
//   node analyze-live.mjs l01-live.jsonl > live-summary.json
//
//   L01  per scenario: requests, answered, cold, p50/p95/max of the client's time against the 23 s target and the 60 s request deadline;
//        resident memory of the stack's containers and the host's available memory during the run.
//   F03  the 16 held-out hard library@version queries: each requested version's verdict (confirmed / no_match / unconfirmed) and the warnings,
//        with the corpus's expectNoMatch queries checked for a verdict of "confirmed" (they must have none).
//   F01  the four classifier-dependent queries: how often documentation activated across the cold run and the repeats, and why.
//   S4   how often the bounded Ref read was attempted, selected and read.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const lines = (f) => readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const live = lines(process.argv[2]);
const plan = JSON.parse(readFileSync(join(here, "plan.json"), "utf8")).items;
const corpus = JSON.parse(readFileSync(join(here, "../../SI0/corpus/corpus-v1.json"), "utf8")).queries;
const planOf = new Map(plan.filter((i) => !i.group).map((i) => [i.id, i]));
const queryOf = new Map(corpus.map((q) => [q.id, q]));

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)] : null; };
const stats = (xs) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.length ? Math.max(...xs) : null });
const count = (xs) => Object.fromEntries([...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length]));
const TARGET = 23000, DEADLINE = 60000;
const searches = live.filter((r) => r.kind === "search");

// ---- L01, live ----------------------------------------------------------------------------------------------------------------
const l01 = {};
for (const sc of [...new Set(searches.map((r) => r.scenario))]) {
  const rows = searches.filter((r) => r.scenario === sc), ok = rows.filter((r) => r.status === 200), cold = ok.filter((r) => r.cache === "miss");
  l01[sc] = { requested: rows.length, answered_200: ok.length, not_200: rows.filter((r) => r.status !== 200).map((r) => ({ id: r.id, status: r.status, error: r.error })), cold: cold.length, not_cold: ok.length - cold.length,
    client_ms: stats(cold.map((r) => r.clientMs)), server_total_ms: stats(cold.map((r) => r.serverTotalMs).filter(Number.isFinite)),
    over_target_23s: cold.filter((r) => r.clientMs > TARGET).length, over_deadline_60s: cold.filter((r) => r.clientMs > DEADLINE).length,
    outcomes: count(ok.map((r) => r.outcome)), ranking: count(ok.map((r) => `${r.ranking}/${r.rankingReason}`)), general_successful: count(ok.map((r) => r.generalSuccessful)),
    warnings: count(ok.flatMap((r) => r.warnings ?? [])), admission_waits_before: live.filter((r) => r.kind === "admission_wait").length };
}
const mem = live.filter((r) => r.kind === "mem" && r.mem && !r.mem.error), peak = {};
const mib = (v) => (/GiB/.test(v) ? parseFloat(v) * 1024 : parseFloat(v));
for (const m of mem) for (const [k, v] of Object.entries(m.mem)) peak[k] = Math.max(peak[k] ?? 0, Math.round(mib(v)));
const memory = mem.length ? { samples: mem.length, peak_mib_by_container: peak, host_available_mib: { min: Math.min(...mem.map((m) => m.memAvailableMiB)), max: Math.max(...mem.map((m) => m.memAvailableMiB)) } } : null;

// ---- F03 ----------------------------------------------------------------------------------------------------------------------
const hard = searches.filter((r) => r.scenario === "cold_docs" && planOf.get(r.id)?.hardVersion);
const perQuery = hard.map((r) => {
  const q = queryOf.get(r.id), requested = (q?.searchIntelligence?.libraries ?? []).filter((l) => l.version && !/^latest$/i.test(l.version)).map((l) => `${l.name}@${l.version}`);
  return { id: r.id, status: r.status, outcome: r.outcome, requested, expectNoMatch: q?.expectNoMatch === true, verdicts: (r.versions ?? []).map((v) => ({ library: v.library, version: v.version, verdict: v.verdict })),
    warnings: (r.warnings ?? []).filter((w) => /^exact_version_/.test(w)) };
});
const entries = perQuery.flatMap((q) => q.verdicts.map((v) => ({ ...v, id: q.id, expectNoMatch: q.expectNoMatch })));
const f03 = { hard_version_queries_in_plan: plan.filter((i) => i.hardVersion).length, answered: hard.filter((r) => r.status === 200).length, requested_versions: entries.length,
  verdicts: count(entries.map((e) => e.verdict)), confirmed_coverage: entries.length ? +(entries.filter((e) => e.verdict === "confirmed").length / entries.length).toFixed(4) : null,
  unknown_rate: entries.length ? +(entries.filter((e) => e.verdict === "unconfirmed").length / entries.length).toFixed(4) : null,
  queries_without_a_report: perQuery.filter((q) => q.requested.length && !q.verdicts.length).map((q) => q.id),
  confirmed_on_expect_no_match: entries.filter((e) => e.expectNoMatch && e.verdict === "confirmed").map((e) => `${e.id} ${e.library}@${e.version}`),
  warning_counts: count(perQuery.flatMap((q) => q.warnings)), per_query: perQuery };

// ---- F01 ----------------------------------------------------------------------------------------------------------------------
const cls = ["Q081", "Q085", "Q094", "Q096"];
const act = searches.filter((r) => (r.scenario === "cold_docs" && cls.includes(r.id)) || (r.scenario === "activation_repeat" && cls.includes(String(r.id).split("@")[0])));
const f01 = Object.fromEntries(cls.map((id) => { const rs = act.filter((r) => String(r.id).split("@")[0] === id);
  return [id, { observations: rs.length, active: rs.filter((r) => r.activation?.active === true).length, inactive: rs.filter((r) => r.activation?.active === false).length, reasons: count(rs.map((r) => r.activation?.reason)),
    probabilities: rs.map((r) => r.activation?.probability).filter((p) => p !== null && p !== undefined) }]; }));

// ---- S4 -----------------------------------------------------------------------------------------------------------------------
const docs = searches.filter((r) => ["cold_docs", "activation_repeat"].includes(r.scenario) && r.status === 200);
const s4 = { documentation_searches: docs.length, with_enrichment_record: docs.filter((r) => r.enrichment).length,
  enrichments: docs.filter((r) => r.enrichment).map((r) => ({ id: r.id, ...r.enrichment })).slice(0, 40) };

console.log(JSON.stringify({ target_ms: TARGET, request_deadline_ms: DEADLINE, label: "live: the deployed platform on the Pi, one search active at a time except the concurrent4_live rounds", l01, memory, f03, f01, s4 }, null, 1));
