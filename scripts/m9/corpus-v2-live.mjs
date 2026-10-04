// One complete new corpus batch. No research flow, target retries or old rescoring.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { homedir } from 'node:os';
import { base, digest, historicalIntact, revisionIntegrity, requestPlan, corpusResult, proofPaths, budgetAdmission,correlationId,correlationEvent,normalizationProof,canonicalTime,browserOptions } from './corpus-v2.mjs';
import { validateBody } from '../../services/access/src/validate.mjs';
import { codeDirty } from './collection.mjs';
import { sourceObservation } from './source-observation.mjs';

export function ready({ consent, window, head, deployed, dirty, reviewed, now }) {
  const start = Date.parse(consent?.opened_at), end = Date.parse(consent?.expires_at);
  return consent?.scope === 'M9 acceptance' && consent.purpose === 'M9 corpus revision 2' && window?.state === 'OPEN' &&
    consent.source_commit === head && window.source_commit === head && deployed === head && dirty === false && reviewed === true &&
    window.corpus_sha256 === consent.corpus_sha256 && window.consent_sha256 === digest(JSON.stringify(consent)) &&
    consent.request_plan_authorized === true && /^[0-9a-f]{64}$/.test(consent.request_plan_sha256 ?? '') && window.request_plan_sha256 === consent.request_plan_sha256 &&
    JSON.stringify(consent.browser_request_options)===JSON.stringify(browserOptions) &&
    window.started_utc === consent.opened_at && window.expires_at === consent.expires_at &&
    canonicalTime(consent.opened_at) && canonicalTime(consent.expires_at) && start <= now && end-now>=2520000 && end > start && end - start <= 2700000 &&
    new Date(start).toISOString().slice(0,7)===new Date(end).toISOString().slice(0,7) &&
    consent.new_llm_micro_usd === 0 && consent.llm_micro_usd === 0 && consent.new_parser_credits <= 3 &&
    ['new_proxy_micro_usd', 'new_enhanced_micro_usd', 'new_parser_credits'].every(k => Number.isSafeInteger(consent[k]) && consent[k] >= 0);
}
export const dispatchFits=(consent,now)=>Number.isFinite(Date.parse(consent?.expires_at)) && Date.parse(consent.expires_at)-now>=130000;

async function main() {
  const privateDir = homedir() + '/.local/share/firecrawl-pi/m9/corpus-v2';
  const j = p => JSON.parse(readFileSync(p));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const conf = Object.fromEntries(readFileSync('scripts/m1/pi-target.conf', 'utf8').split('\n').filter(x => /^PI_\w+=/.test(x))
    .map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1).replace('$HOME', homedir())]));
  const pi = (cmd, input) => execFileSync('ssh', ['-i', conf.PI_SSH_KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', conf.PI_SSH_TARGET, cmd],
    { input, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1048576, stdio: ['pipe', 'pipe', 'pipe'] });
  const oldText = readFileSync(homedir() + '/.local/share/firecrawl-pi/m9/corpus.json', 'utf8');
  const specText = readFileSync(privateDir + '/corpus.json', 'utf8'), spec = JSON.parse(specText), freeze = j(base + '/freeze.json');
  const previous = j(homedir() + '/.local/share/firecrawl-pi/m9/live/corpus-final-rechecks.json');
  const initial=j(homedir()+'/.local/share/firecrawl-pi/m9/live/history/20261003-first-real/corpus.json');
  const sources = Object.fromEntries(['P01', 'P02'].map(id => [id, { html: readFileSync(privateDir + '/' + id + '-source.html', 'utf8'),
    document: previous.results.find(r => r.id === id).response.json.data,initial_document:initial.results[Number(id.slice(1))-1].json.data }]));
  if (!historicalIntact() || !revisionIntegrity(oldText, specText, j('evidence/M9/work/corpus-freeze.json'), freeze, sources,readFileSync(base+'/source-inspection.json','utf8'))) throw Error('Historical evidence or justified revision changed');
  const manifest = j('deploy/policies/capabilities.json'), plan = requestPlan(spec);
  for (const body of plan) validateBody('scrape', body, manifest);
  if (!freeze.policies.every(x => digest(readFileSync(x.path)) === x.sha256)) throw Error('Frozen provider/routing/security policy changed');
  const head = git('rev-parse', 'HEAD'), before = sourceObservation();
  const consent = JSON.parse(pi('sudo -n cat /etc/firecrawl-pi/m9-validation/consent.json'));
  const window = j(base + '/live-window.json'), gate = j(base + '/review/gate.json');
  const reviewed = gate.state === 'REMEDIATION_COMPLETE' && gate.criterion_integrity === 'APPROVED_AFTER_REMEDIATION' &&
    gate.premise_sha256===digest(readFileSync(base+'/premise-decision.json')) &&
    gate.review_sha256 === digest(readFileSync(base + '/review/REVIEW.md')) && gate.freeze_sha256 === digest(readFileSync(base + '/freeze.json')) &&
    proofPaths.every(p => gate.files?.[p] === digest(readFileSync(p))) && gate.findings.every(f => ['FIXED', 'REJECTED'].includes(f.disposition));
  if (window.corpus_sha256 !== freeze.sha256 || window.request_plan_sha256 !== freeze.request_plan_sha256 || !before.clean || !ready({ consent, window, head, deployed: before.pi, dirty: codeDirty(git('status', '--porcelain=v1', '-z', '--untracked-files=all')), reviewed, now: Date.now() }))
    throw Error('Exact clean/deployed/reviewed revision and fresh owner window required');
  const status = () => JSON.parse(pi('sudo -n /opt/firecrawl-pi/scripts/fcpi status --json'));
  const statusBefore = status();
  if (!statusBefore.healthy || statusBefore.capabilities.providers.paidDispatch !== true) throw Error('Authorized healthy validation runtime required');
  const activeBudget = JSON.parse(pi('sudo -n cat /etc/firecrawl-pi/m9-validation/budget.json'));
  const activeRouting = JSON.parse(pi('sudo -n cat /etc/firecrawl-pi/m9-validation/egress.json'));
  if (activeRouting.attempts.maxPerPage !== 3 || activeBudget.parsing.maxPages !== 2 || activeBudget.validationExpiresAt !== consent.expires_at ||
      activeBudget.categories.llm.caps.day !== 0 || activeBudget.categories.llm.caps.month !== 0 ||
      Object.values(activeBudget.categories.proxy.caps).some(x => x !== consent.proxy_micro_usd) ||
      Object.values(activeBudget.categories.enhanced.caps).some(x => x !== consent.enhanced_micro_usd) ||
      activeBudget.categories.parser.caps.month !== consent.parser_credits ||
      activeBudget.rateCards.find(x => x.subject === 'llamaparse-cost-effective').microUsdPerCredit !== 0) throw Error('Authorized attempt, parser or spending policy differs');
  const origin = pi('sudo -n cat /etc/firecrawl-pi/secrets/gateway/served-origins').trim().split('\n').find(x => /^https:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?$/.test(x));
  if (!origin) throw Error('Private authenticated TLS origin absent');
  const token = execFileSync('security', ['find-generic-password', '-a', 'fcpi', '-s', 'fcpi mcp codex', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const sql = text => pi('sudo -n docker exec -i fcpi-nuq-postgres-1 psql -U postgres -d postgres -At -q -X -v ON_ERROR_STOP=1', text);
  const acquisitionRows = () => JSON.parse(sql("SELECT coalesce(json_agg(r),'[]') FROM (SELECT logical_id,url_hmac FROM fcpi_retrieval.acquisition ORDER BY logical_id) r;"));
  const acquisitionIds = () => acquisitionRows().map(x=>x.logical_id);
  const ledger = () => JSON.parse(sql("SELECT coalesce(json_agg(r ORDER BY r.call_key),'[]') FROM (SELECT call_key, logical_id, category, provider, unit, reserved, actual, state, usage FROM fcpi_retrieval.budget_reservation WHERE provider IN ('openai','decodo','zyte','llamaparse')) r;"));
  const monthUsage = () => JSON.parse(sql("SELECT coalesce(json_agg(r),'[]') FROM (SELECT category, (reserved+settled)::float8 AS used FROM fcpi_retrieval.budget_usage WHERE period='month' AND period_start=date_trunc('month',now() AT TIME ZONE 'UTC')::date) r;"));
  const usageBefore = monthUsage();
  if (!budgetAdmission(consent, usageBefore)) throw Error('Absolute monthly caps exceed fresh incremental authorization');
  // Compute target bindings on the Pi. Its HMAC key never leaves the container.
  const oracle = 'import {readFileSync} from "node:fs"; import {createHmac} from "node:crypto"; const secret=readFileSync("/run/secrets/retrieval_browser_token","utf8").trim(); const key=createHmac("sha256",secret).update("fcpi.retrieval.url-hmac.v1").digest(); console.log(JSON.stringify(JSON.parse(readFileSync(0,"utf8")).map(url=>createHmac("sha256",key).update(url).digest("hex").slice(0,32))));';
  const bindings = JSON.parse(pi("sudo -n docker exec -i fcpi-retrieval-service-1 node --input-type=module -e '" + oracle + "'", JSON.stringify(spec.targets.map(t => t.url))));
  if (bindings.length !== 20 || bindings.some(x => !/^[0-9a-f]{32}$/.test(x))) throw Error('Exact target bindings unavailable');
  const priorIds=initial.results.map(r=>r.acquisition?.logical_id??r.json?.data?.metadata?.scrapeId);
  const stored=acquisitionRows();
  if(!normalizationProof(priorIds,bindings,stored))throw Error('Zero-cost historical URL-normalization preflight failed');
  const audit = () => pi('sudo -n bash /opt/firecrawl-pi/scripts/m7/pi-retrieval-log-scan.sh');
  const raw = { revision: 2, source_commit: head, corpus_sha256: freeze.sha256, consent_sha256: window.consent_sha256,
    started_utc: new Date().toISOString(), before, status_before: statusBefore, acquisitions_before: acquisitionIds(),
    ledger_before: ledger(), month_usage_before: usageBefore, normalization_preflight:{ids:priorIds,bindings,stored:stored.filter(r=>priorIds.includes(r.logical_id))},cloud_before: audit(), results: [] };
  const privatePath = privateDir + '/run.json'; mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  writeFileSync(privatePath, JSON.stringify(raw), { mode: 0o600, flag: 'wx' });
  const save = () => writeFileSync(privatePath, JSON.stringify(raw), { mode: 0o600 });
  const call = body => new Promise((resolve, reject) => {
    const started = Date.now(), data = Buffer.from(JSON.stringify(body)), left = Date.parse(consent.expires_at) - started;
    if (!dispatchFits(consent,started)) return reject(Error('Insufficient authorized time for request deadline and cleanup margin'));
    const req = request(origin + '/v2/scrape', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': data.length }, timeout: Math.min(115000, left) }, res => {
      const parts = []; let bytes = 0;
      res.on('data', b => { bytes += b.length; if (bytes > 64 * 1048576) req.destroy(Error('Response exceeds bound')); else parts.push(b); });
      res.on('error', () => reject(Error('Gateway response failed')));
      res.on('end', () => { let json; try { json = JSON.parse(Buffer.concat(parts)); } catch { json = { success: false, code: 'INVALID_JSON' }; }
        resolve({ status: res.statusCode, gateway_request_id: res.headers['x-request-id'], json, elapsed_ms: Date.now() - started,
          started_utc: new Date(started).toISOString(), completed_utc: new Date().toISOString() }); });
    });
    const hardDeadline=setTimeout(()=>req.destroy(Error('Gateway absolute deadline')),Math.min(115000,left));
    req.on('close',()=>clearTimeout(hardDeadline));
    req.on('error', () => reject(Error('Private gateway request failed'))); req.on('timeout', () => req.destroy(Error('Gateway timeout'))); req.end(data);
  });
  const seen = new Set(raw.acquisitions_before);
  for (let i = 0; i < 20; i++) {
    const item = { id: spec.targets[i].id, request: plan[i], expected_url_hmac: bindings[i], dispatch_started_utc: new Date().toISOString() };
    raw.results.push(item); save(); // Intent survives interruption; this batch cannot be run twice.
    try { item.response = await call(item.request); } catch (e) { item.dispatch_error = e.message; save(); throw Error('Recorded request incomplete; do not restart this revision batch'); }
    save();
    const response = item.response, supplied = response.json?.data?.metadata?.scrapeId;
    const fresh = acquisitionRows().filter(row => !seen.has(row.logical_id));
    const id = correlationId(supplied,fresh,item.expected_url_hmac);
    if (id) {
      for (let poll = 0; poll < 5; poll++) {
        if (poll) await new Promise(r => setTimeout(r, 2000));
        const since = new Date(Date.parse(response.started_utc) - 120000).toISOString();
        const events = pi(`sudo -n docker logs --since '${since}' fcpi-retrieval-service-1 2>/dev/null | jq -Rc 'fromjson? | select(.event=="acquisition" and .purpose=="page") | {logical_id,url_hmac,attempts_used,initial_strategy,final_strategy,strategies,failure,proxy_bytes,proxy_micro_usd,enhanced_micro_usd,ms}'`).trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
        const matched = correlationEvent(id,events,item.expected_url_hmac);
        if (matched) { response.acquisition = matched; response.correlation = 'UNIQUE_FRESH_ACQUISITION'; break; }
      }
    }
    fresh.forEach(row => seen.add(row.logical_id)); save();
    console.log(JSON.stringify({ id: item.id, status: response.status, correlated: !!response.acquisition }));
    await new Promise(r => setTimeout(r, 1200));
  }
  raw.ledger_after = ledger(); raw.month_usage_after = monthUsage(); raw.cloud_after = audit(); raw.after = sourceObservation(); raw.status_after = status();
  raw.completed_utc = new Date().toISOString(); save();
  const record = corpusResult(spec, raw);
  writeFileSync(base + '/corpus.json', JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  const complete = raw.results.every(x => x.response.correlation === 'UNIQUE_FRESH_ACQUISITION' && Number.isInteger(x.response.acquisition?.attempts_used) &&
    x.response.acquisition.attempts_used >= 1 && x.response.acquisition.attempts_used <= 3) && raw.after.clean === true && historicalIntact();
  const exit = complete && record.usable >= 18 ? 0 : 1;
  writeFileSync(base + '/run-receipt.json', JSON.stringify({ source_commit: head, raw_sha256: digest(JSON.stringify(raw)), before: raw.before, after: raw.after,
    started_utc: raw.started_utc, completed_utc: raw.completed_utc, denominator: 20, completed: record.completed, usable: record.usable,
    expected: 'At least 18 of all 20 fresh targets, with complete fresh correlation', exit_code: exit }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ completed: record.completed, usable: record.usable, denominator: 20 }));
  process.exitCode = exit;
}

if (process.argv[1]?.endsWith('/corpus-v2-live.mjs')) main().catch(error => {
  const dir = homedir() + '/.local/share/firecrawl-pi/m9/corpus-v2'; mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(dir + '/driver-error.json', JSON.stringify({ utc: new Date().toISOString(), error: error.message }), { mode: 0o600 });
  console.error('M9 revised driver refused or stopped; private diagnostic retained.'); process.exitCode = 1;
});
