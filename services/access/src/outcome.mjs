// A finished job's outcome as a caller needs it (spec §16.3): the receipt's state beside the native status, which
// says "completed" for a job some of whose pages failed, and those pages grouped by why they failed. A page the
// retrieval service refused carries its typed class in the core's error ("Retrieval failed: CLASS. detail", and
// " Retry after N s." when it may be retried later, spec §9.2); any other failure is grouped by the core's own code.
// A retry time is stated as the instant it falls due, so it does not go stale while the answer is read. The gateway's
// own notes about the record (ids "fcpi:…": errors truncated or lost, an incomplete archive) stand for many pages or an
// unknown number, so they are reported as notes, never counted as failed pages (review R14).
const RETRIEVAL = /^Retrieval failed: ([A-Z][A-Z0-9_]*)\. ?([\s\S]*?)(?: Retry after (\d+) s\.)?$/;
const MAX_DETAIL = 300, MAX_URLS = 3;

export function jobOutcome(job) {
  const all = Array.isArray(job.errors?.errors) ? job.errors.errors : [];
  const isNote = (e) => typeof e?.id === "string" && e.id.startsWith("fcpi:");
  const errors = all.filter((e) => !isNote(e));
  const notes = all.filter(isNote).map((e) => ({ code: e.code ?? null, detail: typeof e.error === "string" ? e.error.slice(0, MAX_DETAIL) : null }));
  const robots = Array.isArray(job.errors?.robotsBlocked) ? job.errors.robotsBlocked.length : 0;
  const groups = new Map();
  for (const e of errors) {
    const m = typeof e?.error === "string" ? RETRIEVAL.exec(e.error) : null;
    const cls = m ? m[1] : typeof e?.code === "string" && e.code ? e.code : "ERROR";
    let g = groups.get(cls);
    if (!g) {
      const detail = m ? m[2] : typeof e?.error === "string" ? e.error : null;
      g = { class: cls, count: 0, detail: detail ? detail.slice(0, MAX_DETAIL) : null, retryAt: null, urls: [] };
      groups.set(cls, g);
    }
    g.count += 1;
    if (g.urls.length < MAX_URLS && typeof e?.url === "string") g.urls.push(e.url);
    const at = m?.[3] ? Date.parse(e.timestamp) + Number(m[3]) * 1000 : NaN;
    if (Number.isFinite(at) && (!g.retryAt || at > Date.parse(g.retryAt))) g.retryAt = new Date(at).toISOString();
  }
  const failures = [...groups.values()].sort((a, b) => b.count - a.count || (a.class < b.class ? -1 : 1))
    .map(({ retryAt, ...g }) => ({ ...g, ...(retryAt ? { retryAt } : {}) }));
  return { state: job.state, failed: errors.length, ...(robots ? { robotsBlocked: robots } : {}), ...(failures.length ? { failures } : {}), ...(notes.length ? { notes } : {}) };
}
