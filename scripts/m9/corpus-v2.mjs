// Versioned acceptance evidence only. This module does not change retrieval.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
export const base = 'evidence/M9/corpus-v2';
export const historyCommit = 'c72e89215b45049bf30905144f2ad7010dbd18bf';
export const digest = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const finiteTime = value => Number.isFinite(Date.parse(value));
const visibleBody = html => (html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '')
  .replace(/<!--[\s\S]*?-->|<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export function revisionIntegrity(oldText, text, oldFreeze, freeze, sources, inspectionText) {
  try {
    const inspection=JSON.parse(inspectionText);
    if(digest(inspectionText)!==freeze.source_inspection_sha256 || inspection.observations?.length!==2)return false;
    const old = JSON.parse(oldText), spec = JSON.parse(text);
    if (digest(oldText) !== oldFreeze.sha256 || freeze.prior_sha256 !== oldFreeze.sha256 ||
        spec.prior_sha256 !== oldFreeze.sha256 || digest(text) !== freeze.sha256 ||
        spec.schema !== 'fcpi.m9-corpus/v2' || spec.revision !== 2 || freeze.revision !== 2 ||
        spec.minimum_usable !== 18 || freeze.minimum_usable !== 18 || freeze.required_rate !== .9 ||
        old.targets?.length !== 20 || spec.targets?.length !== 20 || freeze.targets?.length !== 20 ||
        !finiteTime(freeze.frozen_at) || spec.frozen_at !== freeze.frozen_at || freeze.request_plan_sha256 !== digest(JSON.stringify(requestPlan(spec)))) return false;
    for (let i = 0; i < 20; i++) {
      const before = old.targets[i], after = spec.targets[i], row = freeze.targets[i];
      const changed = ['P01', 'P02'].includes(before.id);
      if (before.id !== `P${String(i + 1).padStart(2, '0')}` || before.max_attempts !== 3 || after.max_attempts !== 3) return false;
      if (!changed && !equal(before, after)) return false;
      if (changed) {
        const { required_text: ignored, ...fixed } = before;
        const { required_text: body, required_title: title, ...same } = after;
        const source = sources[before.id], html = source?.html ?? '', doc = source?.document;
        const observed=inspection.observations.find(x=>x.id===before.id), initial=source?.initial_document;
        if(!observed || digest(html)!==observed.source_sha256 || digest(doc?.markdown??'')!==observed.historical_markdown_sha256 ||
          digest(doc?.rawHtml??'')!==observed.historical_raw_html_sha256 || digest(initial?.markdown??'')!==observed.initial_profile_markdown_sha256 ||
          digest(initial?.metadata?.title??'')!==observed.initial_profile_title_sha256 || initial?.metadata?.title!==title || !new RegExp(body,'i').test(initial?.markdown??''))return false;
        if (!equal(fixed, same) || typeof body !== 'string' || !body || title !== before.required_text ||
            new RegExp(before.required_text, 'i').test(visibleBody(html)) ||
            html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] !== title ||
            !new RegExp(body, 'i').test(visibleBody(html)) || doc?.metadata?.title !== title ||
            typeof doc.markdown !== 'string' || !new RegExp(body, 'i').test(doc.markdown)) return false;
      }
      const criterion = { required_text: after.required_text, ...(after.required_title ? { required_title: after.required_title } : {}) };
      if (row.id !== after.id || row.domain !== new URL(after.url).hostname || row.page_class !== after.page_class ||
          row.max_attempts !== 3 || row.criteria_sha256 !== digest(JSON.stringify(criterion))) return false;
    }
    return new Set(spec.targets.map(t => new URL(t.url).hostname)).size >= 5;
  } catch { return false; }
}

export function requestPlan(spec) {
  return spec.targets.map(t => ({ url: t.url, formats: ['markdown'], maxAge: 0, storeInCache: false,
    ...(t.page_class === 'lawful-difficult' ? { proxy: 'auto' } : {}),
    // The existing M9-supported browser wait action renders the declared JS cases.
    // It changes no routing policy and adds no caller retry.
    ...(t.page_class === 'js' ? { onlyMainContent: false, actions: [{ type: 'wait', milliseconds: t.id === 'P08' ? 10000 : 1000 }] } : {}) }));
}

export function targetResult(target, response) {
  const markdown = response?.json?.data?.markdown, title = response?.json?.data?.metadata?.title;
  const criteria = (Array.isArray(target.required_text) ? target.required_text : [target.required_text]).map(value => ({
    kind: 'markdown_body', criterion_sha256: digest(value), passed: typeof markdown === 'string' && new RegExp(value, 'i').test(markdown)
  }));
  if (target.required_title) criteria.push({ kind: 'metadata_title', criterion_sha256: digest(target.required_title), passed: title === target.required_title });
  const attempts = response?.acquisition?.attempts_used;
  const usable = response?.status === 200 && response?.json?.success === true && typeof markdown === 'string' && markdown.trim().length > 0 &&
    criteria.length > 0 && criteria.every(c => c.passed) && Number.isInteger(attempts) && attempts >= 1 && attempts <= target.max_attempts;
  return { id: target.id, domain: new URL(target.url).hostname, page_class: target.page_class, status: response?.status ?? null, usable, criteria,
    content_sha256: digest(markdown ?? ''), metadata_title_sha256: typeof title === 'string' ? digest(title) : null,
    bytes: Buffer.byteLength(markdown ?? ''), elapsed_ms: response?.elapsed_ms ?? null,
    fcpi: { strategy: response?.acquisition?.final_strategy ?? null, attempts: attempts ?? null,
      proxy_bytes: response?.acquisition?.proxy_bytes ?? null, proxy_micro_usd: response?.acquisition?.proxy_micro_usd ?? null,
      enhanced_micro_usd: response?.acquisition?.enhanced_micro_usd ?? null },
    failure: response?.json?.code ?? response?.acquisition?.failure ?? (!usable ? 'CORPUS_ASSERTION_FAILED' : null) };
}

export function corpusResult(spec, raw) {
  const results = raw.results.map((item, i) => targetResult(spec.targets[i], item.response));
  return { schema: 'fcpi.public-corpus/v2', revision: 2, utc: raw.completed_utc, source_commit: raw.source_commit,
    corpus_sha256: raw.corpus_sha256, consent_sha256: raw.consent_sha256, raw_sha256: digest(JSON.stringify(raw)),
    evidence_mode: 'COMPLETE_NEW_20_TARGET_RUN', denominator: 20, minimum_usable: 18, completed: results.length,
    usable: results.filter(r => r.usable).length, results };
}

export function fullRunVerdict(spec, freeze, raw, record, window) {
  try {
    if (freeze.minimum_usable !== 18 || freeze.count !== 20 || raw.revision !== 2 || raw.corpus_sha256 !== freeze.sha256 ||
        window?.state !== 'CLOSED' || window.purpose !== 'M9 corpus revision 2' || window.corpus_sha256 !== freeze.sha256 ||
        window.source_commit !== raw.source_commit || window.consent?.source_commit !== raw.source_commit ||
        window.consent.scope !== 'M9 acceptance' || window.consent.purpose !== 'M9 corpus revision 2' || window.consent.corpus_sha256 !== freeze.sha256 ||
        window.consent.request_plan_authorized !== true || window.consent.request_plan_sha256 !== freeze.request_plan_sha256 || window.request_plan_sha256 !== freeze.request_plan_sha256 ||
        digest(JSON.stringify(window.consent)) !== window.consent_sha256 ||
        window.consent_sha256 !== raw.consent_sha256 || !finiteTime(window.started_utc) || !finiteTime(window.closed_utc) ||
        !finiteTime(window.expires_at) || window.expires_at !== window.consent.expires_at || window.started_utc !== window.consent.opened_at ||
        Date.parse(window.expires_at) <= Date.parse(window.started_utc) || Date.parse(window.expires_at) - Date.parse(window.started_utc) > 2700000 ||
        Date.parse(window.closed_utc) > Date.parse(window.expires_at) ||
        !finiteTime(raw.started_utc) || !finiteTime(raw.completed_utc) || !finiteTime(window.required_work_finished_utc) ||
        Date.parse(raw.completed_utc) < Date.parse(raw.started_utc) || Date.parse(raw.started_utc) < Date.parse(window.started_utc) ||
        Date.parse(raw.started_utc) <= Date.parse(freeze.frozen_at) || Date.parse(raw.completed_utc) > Date.parse(window.required_work_finished_utc) ||
        Date.parse(window.required_work_finished_utc) > Date.parse(window.closed_utc) ||
        Date.parse(window.closed_utc) - Date.parse(window.started_utc) > 2700000 || raw.results?.length !== 20) return false;
    const seen = new Set(), gateways = new Set(); let previous = Date.parse(raw.started_utc);
    for (let i = 0; i < 20; i++) {
      const item = raw.results[i], response = item.response, id = response?.acquisition?.logical_id;
      if (item.id !== spec.targets[i].id || !equal(item.request, requestPlan(spec)[i]) ||
          !finiteTime(item.dispatch_started_utc) || !finiteTime(response?.started_utc) || !finiteTime(response?.completed_utc) ||
          Date.parse(item.dispatch_started_utc) < previous || Date.parse(response.started_utc) < Date.parse(item.dispatch_started_utc) ||
          Date.parse(response.completed_utc) < Date.parse(response.started_utc) || Date.parse(response.completed_utc) > Date.parse(raw.completed_utc) ||
          !/^[0-9a-f-]{36}$/.test(response.gateway_request_id ?? '') || gateways.has(response.gateway_request_id) ||
          !id || seen.has(id) || raw.acquisitions_before.includes(id) || response.correlation !== 'UNIQUE_FRESH_ACQUISITION' ||
          !/^[0-9a-f]{32}$/.test(item.expected_url_hmac ?? '') || response.acquisition.url_hmac !== item.expected_url_hmac ||
          !Number.isInteger(response.acquisition.attempts_used) || response.acquisition.attempts_used < 1 || response.acquisition.attempts_used > 3 ||
          (response.status === 200 && response.json?.data?.metadata?.scrapeId !== id)) return false;
      seen.add(id); gateways.add(response.gateway_request_id); previous = Date.parse(response.completed_utc);
    }
    const expected = corpusResult(spec, raw);
    return equal(expected, record) && record.usable >= 18;
  } catch { return false; }
}

export function budgetAdmission(consent, usage) {
  if (!Array.isArray(usage) || consent.llm_micro_usd !== 0 || consent.new_llm_micro_usd !== 0) return false;
  return ['proxy', 'enhanced', 'parser'].every(category => {
    const rows = usage.filter(r => r.category === category);
    const used = rows.length === 0 ? 0 : rows.length === 1 ? rows[0].used : NaN;
    const cap = consent[category === 'parser' ? 'parser_credits' : category + '_micro_usd'];
    const increment = consent[category === 'parser' ? 'new_parser_credits' : 'new_' + category + '_micro_usd'];
    return [used, cap, increment].every(n => Number.isSafeInteger(n) && n >= 0) && cap >= used && cap - used <= increment;
  });
}

export function cloudContinuity(before, after) {
  const container = text => String(text).match(/^container=([0-9a-f]{12}) started_at=/m)?.[1];
  const count = (text, name) => { const xs = [...String(text).matchAll(new RegExp('(?:^| )' + name + '=(\\d+)(?= |$)', 'gm'))]; return xs.length === 1 ? Number(xs[0][1]) : NaN; };
  return !!container(before) && container(before) === container(after) && count(before, 'cloud_host') === 0 &&
    count(after, 'cloud_host') === 0 && count(after, 'acquisition') - count(before, 'acquisition') >= 20;
}

export function cleanupFresh(current, window) {
  return finiteTime(current?.utc) && finiteTime(window?.closed_utc) && Date.parse(current.utc) > Date.parse(window.closed_utc) &&
    current.checks?.validation_absent === true && current.checks?.zero_caps === true && current.checks?.paid === true && current.checks?.cloud === true;
}

export function historicalIntact() {
  const manifest = JSON.parse(readFileSync(base + '/history-preservation.json'));
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', historyCommit, '--', 'evidence/M9'], { encoding: 'utf8' }).trim().split('\n').sort();
  return manifest.repository_commit === historyCommit && names.length === 905 && equal(names, manifest.files.map(x => x.path).sort()) &&
    manifest.files.every(x => digest(readFileSync(x.path)) === x.sha256) &&
    execFileSync('git', ['diff', '--name-only', historyCommit, '--', ...names], { encoding: 'utf8' }).trim() === '';
}

// Exact new proof paths only; existing backend, policy, patch, ops and test bytes
// must remain unchanged for the earlier 37 gates to retain applicability.
export const proofPaths = ['scripts/m9/corpus-v2.mjs', 'scripts/m9/corpus-v2-live.mjs', 'scripts/m9/corpus-v2-verify.mjs',
  'tests/contracts/m9-corpus-v2.test.mjs', 'scripts/m9/collect.mjs', 'scripts/m9/redaction.mjs'];
export const unchangedImplementation = paths => paths.every(p => proofPaths.includes(p));
