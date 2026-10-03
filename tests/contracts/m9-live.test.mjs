import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liveRequests, validateLiveRequests, researchComplete, liveExitCode, liveWindowReady, liveEvidenceInWindow } from '../../scripts/m9/live-contract.mjs';
const manifest = JSON.parse(readFileSync(new URL('../../deploy/policies/capabilities.json', import.meta.url)));
const corpus = { targets: Array.from({ length: 20 }, (_, i) => ({ url: i === 0 ? 'https://nodejs.org/api/fs.html' : `https://example.com/${i}`, page_class: i === 19 ? 'lawful-difficult' : 'static' })) };
const plan = () => liveRequests(corpus, 'm9-research-fixed-key');
const steps = () => [
  { step: 'search', status: 200, json: { data: { web: [{}] } } },
  { step: 'map', status: 200, json: { links: [{}] } },
  { step: 'retrieve', status: 200, json: { success: true, data: { markdown: 'Node.js document' } } },
  { step: 'extract_submit', status: 200, json: { id: 'receipt' } },
  { step: 'poll/read', status: 200, json: { status: 'completed', data: { title: 'Node.js fs' } } }
];
test('every generated corpus and research request is admitted by the actual gateway contract', () => {
  validateLiveRequests(plan(), manifest);
  for (const r of plan().corpus) { assert.equal(r.body.maxAge, 0); assert.equal(r.body.storeInCache, false); }
  const extract = plan().research[3];
  assert.equal(extract.headers['x-idempotency-key'], 'm9-research-fixed-key');
  assert.equal('idempotencyKey' in extract.body, false);
});
test('the two original rejected request fields fail fixture admission before any dispatch', () => {
  for (const [section, index, field] of [['corpus', 0, 'cacheMode'], ['research', 2, 'cacheMode'], ['research', 3, 'idempotencyKey']]) {
    const p = plan(); p[section][index].body[field] = 'bypass';
    assert.throws(() => validateLiveRequests(p, manifest), /Unrecognized key/);
  }
  const p = plan(); delete p.research[3].headers; assert.throws(() => validateLiveRequests(p, manifest), /idempotency/);
  const m = structuredClone(manifest); m.routes = m.routes.filter(r => r.id !== 'extract.status'); assert.throws(() => validateLiveRequests(plan(), m), /poll route/);
});
test('stale review, dirty or mismatched source/contracts, closed/expired/oversized consent block dispatch', () => {
  const consent = { scope: 'M9 acceptance', source_commit: 'source', opened_at: '2026-10-03T22:00:00Z', expires_at: '2026-10-03T22:45:00Z' };
  const x = { consent, window: { state: 'OPEN', source_commit: 'source', started_utc: consent.opened_at, expires_at: consent.expires_at }, priorClosed: '2026-10-03T21:15:36Z', head: 'source', deployed: 'source', dirty: false, manifestMatches: true, validatorMatches: true, reviewComplete: true, reviewedFilesMatch: true, now: Date.parse('2026-10-03T22:01:00Z') };
  assert.equal(liveWindowReady(x), true);
  for (const mutate of [s => s.window.state = 'CLOSED', s => s.reviewComplete = false, s => s.reviewedFilesMatch = false, s => s.dirty = true, s => s.deployed = 'old', s => s.consent.source_commit = 'old', s => s.manifestMatches = false, s => s.validatorMatches = false, s => s.now = Date.parse(s.consent.expires_at), s => s.consent.expires_at = '2026-10-03T23:00:00Z', s => s.priorClosed = s.consent.opened_at]) { const s = structuredClone(x); mutate(s); assert.equal(liveWindowReady(s), false); }
});
test('live responses are tied to the exact audited window and bounded timestamps', () => {
  const window = { state: 'CLOSED', consent_sha256: 'c'.repeat(64), started_utc: '2026-10-03T22:00:00Z', required_work_finished_utc: '2026-10-03T22:05:00Z' };
  const raw = { window_consent_sha256: window.consent_sha256, results: [{ started_utc: '2026-10-03T22:01:00Z', completed_utc: '2026-10-03T22:02:00Z' }] }, record = { window_consent_sha256: window.consent_sha256, utc: '2026-10-03T22:04:00Z' };
  assert.equal(liveEvidenceInWindow(raw, record, window), true);
  assert.equal(liveEvidenceInWindow({ ...raw, steps: raw.results, results: undefined }, record, window), true);
  for (const mutate of [s => s.raw.window_consent_sha256 = 'old', s => s.record.window_consent_sha256 = 'old', s => s.record.utc = '2026-10-03T22:06:00Z', s => s.raw.results[0].started_utc = '2026-10-03T21:59:00Z', s => s.raw.results[0].completed_utc = '2026-10-03T22:06:00Z', s => delete s.raw.results[0].started_utc, s => s.window.state = 'OPEN']) { const s = structuredClone({ raw, record, window }); mutate(s); assert.equal(liveEvidenceInWindow(s.raw, s.record, s.window), false); }
});
test('400 responses, missing polls, failed jobs, empty results and incomplete corpus cannot report success', () => {
  assert.equal(liveExitCode(20, 18, 20, steps()), 0);
  for (const n of [0, 17]) assert.equal(liveExitCode(20, n, 20, steps()), 1);
  assert.equal(liveExitCode(19, 19, 20, steps()), 1);
  for (let i = 0; i < 5; i++) { const s = steps(); s[i].status = 400; assert.equal(researchComplete(s), false); }
  assert.equal(researchComplete(steps().slice(0, 4)), false);
  for (const mutate of [s => s[0].json.data.web = [], s => s[1].json.links = [], s => s[2].json.data.markdown = '', s => s[3].json.id = '', s => s[4].json.status = 'failed', s => s[4].json.data.title = null]) {
    const s = steps(); mutate(s); assert.equal(liveExitCode(20, 20, 20, s), 1);
  }
});
