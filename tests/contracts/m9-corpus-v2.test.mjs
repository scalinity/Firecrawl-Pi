import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { revisionIntegrity, requestPlan, targetResult, corpusResult, fullRunVerdict, digest, unchangedImplementation, cloudContinuity, budgetAdmission } from '../../scripts/m9/corpus-v2.mjs';
import { ready } from '../../scripts/m9/corpus-v2-live.mjs';
import { validateBody } from '../../services/access/src/validate.mjs';
const source = 'a'.repeat(40), iso = n => new Date(Date.parse('2026-10-04T01:00:00Z') + n * 1000).toISOString();
function fixture() {
  const original = { schema: 'fcpi.m9-corpus/v1', frozen_at: iso(-100), targets: Array.from({ length: 20 }, (_, i) => ({
    id: `P${String(i + 1).padStart(2, '0')}`, page_class: i === 18 ? 'lawful-difficult' : [6, 7].includes(i) ? 'js' : 'static',
    url: `https://public${i % 5}.test/${i}`, required_text: i < 2 ? 'Sample identity' : `content-${i}`, max_attempts: 3 })) };
  const oldText = JSON.stringify(original), oldFreeze = { sha256: digest(oldText) };
  const spec = { ...structuredClone(original), schema: 'fcpi.m9-corpus/v2', revision: 2, minimum_usable: 18, prior_sha256: oldFreeze.sha256, frozen_at: iso(-50) };
  for (const t of spec.targets.slice(0, 2)) { t.required_text = 'Complete source purpose statement\\.'; t.required_title = 'Sample identity'; }
  const text = JSON.stringify(spec), freeze = { revision: 2, count: 20, frozen_at: spec.frozen_at, sha256: digest(text), prior_sha256: oldFreeze.sha256,
    minimum_usable: 18, required_rate: .9, targets: spec.targets.map(t => ({ id: t.id, domain: new URL(t.url).hostname, page_class: t.page_class,
      max_attempts: 3, criteria_sha256: digest(JSON.stringify({ required_text: t.required_text, ...(t.required_title ? { required_title: t.required_title } : {}) })) })) };
  const sources = Object.fromEntries(['P01', 'P02'].map(id => [id, { html: '<html><head><title>Sample identity</title></head><body><p>Complete source purpose statement.</p></body></html>',
    document: { metadata: { title: 'Sample identity' }, markdown: 'Complete source purpose statement.' } }]));
  const consent = { source_commit: source, scope: 'M9 acceptance', purpose: 'M9 corpus revision 2', corpus_sha256: freeze.sha256,
    opened_at: iso(0), expires_at: iso(2700), llm_micro_usd: 0, new_llm_micro_usd: 0, new_proxy_micro_usd: 40200, new_enhanced_micro_usd: 1270, new_parser_credits: 3 };
  const window = { state: 'CLOSED', purpose: consent.purpose, source_commit: source, corpus_sha256: freeze.sha256, consent,
    consent_sha256: digest(JSON.stringify(consent)), started_utc: iso(0), expires_at: iso(2700), required_work_finished_utc: iso(25), closed_utc: iso(26) };
  const raw = { revision: 2, source_commit: source, corpus_sha256: freeze.sha256, consent_sha256: window.consent_sha256,
    started_utc: iso(.1), completed_utc: iso(25), acquisitions_before: ['old-acquisition'], results: spec.targets.map((t, i) => ({
      id: t.id, request: requestPlan(spec)[i], expected_url_hmac: digest(t.url).slice(0,32), dispatch_started_utc: iso(i + 1), response: { status: i === 18 ? 500 : 200,
        gateway_request_id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, started_utc: iso(i + 1.01), completed_utc: iso(i + 1.02), elapsed_ms: 10,
        json: i === 18 ? { success: false, code: 'BLOCKED_PUBLIC_CONTENT' } : { success: true, data: { markdown: i < 2 ? 'Complete source purpose statement.' : t.required_text,
          metadata: { title: t.required_title ?? 'Synthetic title', scrapeId: 'fresh-' + t.id } } }, correlation: 'UNIQUE_FRESH_ACQUISITION',
        acquisition: { logical_id: 'fresh-' + t.id, url_hmac: digest(t.url).slice(0,32), attempts_used: i === 18 ? 3 : 1, final_strategy: 'direct_http', proxy_bytes: 0, proxy_micro_usd: 0, enhanced_micro_usd: 0 } } })) };
  return { original, oldText, oldFreeze, spec, text, freeze, sources, consent, window, raw, record: corpusResult(spec, raw) };
}
const revision = f => revisionIntegrity(f.oldText, f.text, f.oldFreeze, f.freeze, f.sources);
const verdict = f => fullRunVerdict(f.spec, f.freeze, f.raw, f.record, f.window);
const rebuild = f => { f.record = corpusResult(f.spec, f.raw); return f; };

test('revision requires independent visible body and correctly separated title for both cases', () => assert.equal(revision(fixture()), true));
test('18 other rows, P19, threshold and attempts cannot change', () => {
  for (const change of [f => f.spec.targets[18].required_text = 'easier', f => f.spec.targets.pop(), f => f.spec.targets[2].required_text = 'other',
    f => f.spec.minimum_usable = 17, f => f.spec.targets[0].max_attempts = 4, f => f.spec.targets.reverse()]) {
    const f = fixture(); change(f); f.text = JSON.stringify(f.spec); f.freeze.sha256 = digest(f.text); assert.equal(revision(f), false);
  }
});
test('identity text already present in the source body disproves the premise correction', () => {
  for (const id of ['P01', 'P02']) { const f = fixture(); f.sources[id].html = f.sources[id].html.replace('<p>', '<p>Sample identity '); assert.equal(revision(f), false); }
});
test('source title alone, script-only purpose or missing historical body cannot justify correction', () => {
  for (const change of [f => f.sources.P01.html = '<title>Sample identity</title><body></body>',
    f => f.sources.P02.html = '<title>Sample identity</title><body><script>Complete source purpose statement.</script></body>',
    f => f.sources.P01.document.markdown = '', f => f.sources.P02.document.metadata.title = 'wrong']) {
    const f = fixture(); change(f); assert.equal(revision(f), false);
  }
});
test('new body content AND exact metadata identity are required; metadata never replaces body', () => {
  const f = fixture(), t = f.spec.targets[0]; assert.equal(targetResult(t, f.raw.results[0].response).usable, true);
  for (const change of [r => r.json.data.markdown = '', r => r.json.data.markdown = 'Sample identity', r => r.json.data.metadata.title = 'Other identity',
    r => delete r.json.data.metadata.title, r => r.json.success = false, r => r.status = 403, r => r.acquisition.attempts_used = 0,
    r => r.acquisition.attempts_used = 4, r => r.acquisition.attempts_used = null]) {
    const r = structuredClone(f.raw.results[0].response); change(r); assert.equal(targetResult(t, r).usable, false);
  }
});
test('all 20 request bodies pass actual gateway validation; native formats and routing remain selected', () => {
  const f = fixture(), manifest = JSON.parse(readFileSync('deploy/policies/capabilities.json'));
  for (const body of requestPlan(f.spec)) validateBody('scrape', body, manifest);
  assert.equal(requestPlan(f.spec)[18].proxy, 'auto'); assert.equal(requestPlan(f.spec)[0].actions, undefined);
  assert.equal(requestPlan(f.spec)[7].actions[0].milliseconds, 10000);
});
test('19/20 including the unchanged real-type P19 failure passes; no success is fabricated', () => {
  const f = fixture(); assert.equal(f.record.usable, 19); assert.equal(f.record.results[18].usable, false); assert.equal(verdict(f), true);
});
test('18/20 passes and 17/20 still fails the exact same threshold', () => {
  const f = fixture(); f.raw.results[2].response.json.data.markdown = 'missing'; rebuild(f); assert.equal(f.record.usable, 18); assert.equal(verdict(f), true);
  f.raw.results[3].response.json.data.markdown = 'missing'; rebuild(f); assert.equal(f.record.usable, 17); assert.equal(verdict(f), false);
});
test('old rows, duplicate or mixed acquisition IDs cannot be presented as a complete new run', () => {
  for (const change of [f => f.raw.acquisitions_before.push(f.raw.results[0].response.acquisition.logical_id),
    f => f.raw.results[0].response.acquisition.logical_id = f.raw.results[1].response.acquisition.logical_id,
    f => f.raw.results[0].response.json.data.metadata.scrapeId = 'other', f => f.raw.results[0].response.gateway_request_id = f.raw.results[1].response.gateway_request_id,
    f => delete f.raw.results[0].response.correlation, f => f.raw.results.pop(), f => f.raw.results[0].id = 'P02']) {
    const f = fixture(); change(f); rebuild(f); assert.equal(verdict(f), false);
  }
});
test('failed requests cannot borrow an unrelated fresh acquisition with a different target binding', () => {
  for (const change of [f => f.raw.results[18].response.acquisition.url_hmac = 'f'.repeat(32), f => delete f.raw.results[18].expected_url_hmac]) {
    const f = fixture(); change(f); rebuild(f); assert.equal(verdict(f), false);
  }
});
test('actual log-scan format binds both zero-Cloud counts to the same running container', () => {
  const scan = (id, count, cloud=0) => `container=${id} started_at=${iso(0)}\nlines=50 acquisition=${count} cloud_host=${cloud}\n`;
  const id = 'abcdef012345'; assert.equal(cloudContinuity(scan(id, 2), scan(id,22)), true);
  for (const after of [scan('012345abcdef',22), scan(id,21), scan(id,22,1), 'container='+id]) assert.equal(cloudContinuity(scan(id,2),after),false);
});
test('absolute monthly caps may not authorize more than the new incremental owner grant', () => {
  const c = {...fixture().consent, proxy_micro_usd: 57717, enhanced_micro_usd: 7620, parser_credits: 18};
  const u = [{category:'proxy',used:17517},{category:'enhanced',used:6350},{category:'parser',used:15}];
  assert.equal(budgetAdmission(c,u),true);
  for (const bad of [[],[...u,u[0]],u.map(r=>({...r,used:r.used-1})),u.map(r=>({...r,used:NaN}))]) assert.equal(budgetAdmission(c,bad),false);
});
test('frozen request plan and all per-page attempt bounds are checked even for failed rows', () => {
  for (const change of [f => f.raw.results[18].response.acquisition.attempts_used = 4, f => f.raw.results[18].response.acquisition.attempts_used = 0,
    f => f.raw.results[0].request.maxAge = 86400, f => f.raw.results[0].request.formats = ['json']]) {
    const f = fixture(); change(f); rebuild(f); assert.equal(verdict(f), false);
  }
});
test('missing/nonfinite times, reordered dispatch and expired windows fail closed', () => {
  for (const change of [f => delete f.window.required_work_finished_utc, f => f.window.closed_utc = 'invalid', f => f.window.expires_at = iso(20),
    f => f.raw.results[0].response.started_utc = iso(-10), f => f.raw.results[3].dispatch_started_utc = iso(1),
    f => delete f.raw.results[18].response.completed_utc, f => f.raw.completed_utc = iso(5)]) {
    const f = fixture(); change(f); rebuild(f); assert.equal(verdict(f), false);
  }
});
test('false public grades, different consent/source or a rescored historical record fail', () => {
  for (const change of [f => f.record.usable = 20, f => f.record.evidence_mode = 'RESCORED_OLD_RUN', f => f.raw.source_commit = 'b'.repeat(40),
    f => f.window.consent.source_commit = 'b'.repeat(40), f => f.window.consent.purpose = 'old grant', f => f.window.consent_sha256 = '0'.repeat(64)]) {
    const f = fixture(); change(f); assert.equal(verdict(f), false);
  }
});
test('driver requires fresh, exact reviewed/deployed authorization with zero model spending', () => {
  const f = fixture(), args = { consent: f.consent, window: { ...f.window, state: 'OPEN' }, head: source, deployed: source, dirty: false, reviewed: true, now: Date.parse(iso(10)) };
  assert.equal(ready(args), true);
  for (const change of [{ deployed: 'b'.repeat(40) }, { dirty: true }, { reviewed: false }, { now: Date.parse(iso(2700)) }, { window: f.window },
    { consent: { ...f.consent, new_llm_micro_usd: 1 } }, { consent: { ...f.consent, new_parser_credits: 6 } }]) assert.equal(ready({ ...args, ...change }), false);
});
test('old gate applicability allows only the exact revision proof files, never runtime/security/routing changes', () => {
  assert.equal(unchangedImplementation(['scripts/m9/corpus-v2.mjs']), true);
  for (const path of ['services/retrieval/src/acquire.mjs', 'deploy/policies/egress.json', 'patches/0010-enhanced-route-browser-extras-and-owner.patch',
    'scripts/ops/tick.sh', 'tests/contracts/m2-scan.test.mjs', 'scripts/m9/incident-agent.sh']) assert.equal(unchangedImplementation([path]), false);
});
