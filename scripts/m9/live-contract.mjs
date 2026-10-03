// The requests used by live acceptance are also checked against the deployed
// gateway contract before any provider window is used. No I/O or dispatch here.
import { validateBody } from '../../services/access/src/validate.mjs';

export function liveRequests(corpus, key) {
  const url = corpus.targets.find(t => new URL(t.url).hostname === 'nodejs.org')?.url;
  if (!url) throw Error('Frozen research target absent');
  const scrape = target => ({ kind: 'scrape', method: 'POST', path: '/v2/scrape', body: {
    url: target.url, formats: ['markdown'], maxAge: 0, storeInCache: false,
    ...(target.page_class === 'lawful-difficult' ? { proxy: 'auto' } : {})
  }});
  return {
    corpus: corpus.targets.map(scrape),
    research: [
      { step: 'search', kind: 'search', method: 'POST', path: '/v2/search', body: { query: 'Node.js filesystem API', limit: 3 } },
      { step: 'map', kind: 'map', method: 'POST', path: '/v2/map', body: { url, limit: 5 } },
      { step: 'retrieve', ...scrape({ url }) },
      { step: 'extract_submit', kind: 'extract', method: 'POST', path: '/v2/extract', headers: { 'x-idempotency-key': key }, body: {
        urls: [url], prompt: 'Extract the title of this Node.js API document. Leave missing data null.',
        schema: { type: 'object', properties: { title: { type: ['string', 'null'] } }, required: ['title'] }
      }}
    ]
  };
}

export function validateLiveRequests(plan, manifest) {
  for (const r of [...plan.corpus, ...plan.research]) {
    const route = manifest.routes.find(x => x.method === r.method && x.path === r.path && x.body === r.kind);
    if (!route || route.method !== r.method || route.path !== r.path) throw Error('Live request route differs from gateway contract');
    validateBody(r.kind, r.body, manifest);
    if (r.kind === 'extract' && !/^[A-Za-z0-9._:-]{8,128}$/.test(r.headers?.['x-idempotency-key'] ?? '')) throw Error('Live extract idempotency header absent');
  }
  if (!manifest.routes.some(r => r.method === 'GET' && r.path === '/v2/extract/{id}' && r.kind === 'extract')) throw Error('Live extract poll route absent');
}

export function liveWindowReady({ consent, window, priorClosed, head, deployed, dirty, manifestMatches, validatorMatches, reviewComplete, reviewedFilesMatch, now }) {
  const start = Date.parse(consent?.opened_at), end = Date.parse(consent?.expires_at);
  return window?.state === 'OPEN' && consent?.scope === 'M9 acceptance' && consent.source_commit === head &&
    window.source_commit === head && deployed === head && dirty === false && manifestMatches === true && validatorMatches === true &&
    reviewComplete === true && reviewedFilesMatch === true && window.started_utc === consent.opened_at && window.expires_at === consent.expires_at &&
    Number.isFinite(start) && start <= now && now < end && end - start > 0 && end - start <= 2700000 &&
    (!priorClosed || start > Date.parse(priorClosed));
}

export function liveEvidenceInWindow(raw, record, window) {
  const start = Date.parse(window?.started_utc), finished = Date.parse(window?.required_work_finished_utc), utc = Date.parse(record?.utc);
  const responses = raw?.results ?? raw?.steps;
  return window?.state === 'CLOSED' && typeof window.consent_sha256 === 'string' &&
    raw?.window_consent_sha256 === window.consent_sha256 && record?.window_consent_sha256 === window.consent_sha256 &&
    Number.isFinite(start) && finished >= start && utc >= start && utc <= finished &&
    Array.isArray(responses) && responses.length > 0 && responses.every(r => {
      const began = Date.parse(r.started_utc), end = Date.parse(r.completed_utc);
      return began >= start && end >= began && end <= finished;
    });
}

export function researchComplete(steps) {
  const names = ['search', 'map', 'retrieve', 'extract_submit', 'poll/read'];
  if (steps.length !== names.length || !steps.every((s, i) => s.step === names[i] && s.status >= 200 && s.status < 300)) return false;
  const [search, map, retrieve, submitted, poll] = steps;
  return (search.json?.data?.web ?? search.json?.data ?? []).length > 0 && map.json?.links?.length > 0 &&
    retrieve.json?.success === true && retrieve.json?.data?.markdown?.length > 0 &&
    typeof submitted.json?.id === 'string' && submitted.json.id.length > 0 &&
    poll.json?.status === 'completed' && typeof poll.json?.data?.title === 'string' && poll.json.data.title.length > 0;
}

export function liveExitCode(completed, usable, denominator, steps) {
  return denominator === 20 && completed === denominator && usable / denominator >= .9 && researchComplete(steps) ? 0 : 1;
}
