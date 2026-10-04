// Versioned acceptance beside the immutable 17/20 record. Earlier gates retain
// their actual source and hashes; only unchanged implementation may reuse them.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { base, digest, historyCommit, historicalIntact, unchangedImplementation, proofPaths, revisionIntegrity, fullRunVerdict, cloudContinuity, budgetAdmission, cleanupFresh, fixturesComplete } from './corpus-v2.mjs';
import { codeDirty } from './collection.mjs';
const git = (...args) => {const text=execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});return args.includes('-z')?text:text.trim();};
const json = path => existsSync(path) ? JSON.parse(readFileSync(path)) : null;
const head = git('rev-parse', 'HEAD'), privateDir = homedir() + '/.local/share/firecrawl-pi/m9/corpus-v2';
function sameExecution(source) {
  return typeof source==='string' && /^[0-9a-f]{40}$/.test(source) && git('diff','--name-only',source,head,'--','services','deploy','scripts','tests','patches')==='';
}
const prior = json('evidence/M9/acceptance.json');
const history = historicalIntact();
const delta = git('diff', '--name-only', prior.source_commit, head, '--', 'services', 'deploy', 'scripts', 'tests', 'patches').split('\n').filter(Boolean);
const applicable = history && unchangedImplementation(delta);
const results = prior.results.map(row => ({ ...row, evidence_mode: 'UNCHANGED_IMPLEMENTATION_REUSE', execution_source: prior.source_commit,
  state: row.test_id === 'M9-CORPUS' ? 'NOT_RUN' : applicable ? row.state : 'FAIL' }));
const replace = (id, state, details = {}) => { const row = results.find(x => x.test_id === id); delete row.finding_count; Object.assign(row, { state,evidence_mode:'FRESH_REVISION_2',execution_source:head, ...details }); };
const freeze = json(base + '/freeze.json'), specText = readFileSync(privateDir + '/corpus.json', 'utf8'), spec = JSON.parse(specText);
const old = json(homedir() + '/.local/share/firecrawl-pi/m9/live/corpus-final-rechecks.json');
const initial=json(homedir()+'/.local/share/firecrawl-pi/m9/live/history/20261003-first-real/corpus.json');
const sources = Object.fromEntries(['P01', 'P02'].map(id => [id, { html: readFileSync(privateDir + '/' + id + '-source.html', 'utf8'),
  document: old.results.find(r => r.id === id).response.json.data,initial_document:initial.results[Number(id.slice(1))-1].json.data }]));
const integrity = revisionIntegrity(readFileSync(homedir() + '/.local/share/firecrawl-pi/m9/corpus.json', 'utf8'), specText,
  json('evidence/M9/work/corpus-freeze.json'), freeze, sources,readFileSync(base+'/source-inspection.json','utf8')) && freeze.policies.every(x => digest(readFileSync(x.path)) === x.sha256);
const gate = json(base + '/review/gate.json');
const review = gate?.state === 'REMEDIATION_COMPLETE' && gate.criterion_integrity === 'APPROVED_AFTER_REMEDIATION' &&
  gate.premise_sha256===digest(readFileSync(base+'/premise-decision.json')) &&
  gate.review_sha256 === digest(readFileSync(base + '/review/REVIEW.md')) && gate.freeze_sha256 === digest(readFileSync(base + '/freeze.json')) &&
  gate.findings.every(x => ['FIXED', 'REJECTED'].includes(x.disposition)) && proofPaths.every(p => gate.files?.[p] === digest(readFileSync(p)));
replace('M9-REVIEW', applicable && review ? 'PASS' : 'NOT_RUN', { execution_source:gate?.source_commit??null,revision_review: base + '/review/REVIEW.md' });
const tests = json(base + '/fixtures.json'), testPath = base + '/fixtures.txt';
const fixtures = tests && sameExecution(tests.source_commit) && existsSync(testPath) && fixturesComplete(tests,readFileSync(testPath,'utf8'),tests.source_commit);
replace('M9-RESOURCE-EVALUATOR-TESTS', fixtures ? 'PASS' : 'NOT_RUN', { execution_source:tests?.source_commit??null,current_fixture_record: base + '/fixtures.json' });
const current = json(base + '/current/versions.json');
const raw = json(privateDir + '/run.json'), record = json(base + '/corpus.json'), window = json(base + '/live-window.json');
replace('M9-CURRENT', sameExecution(current?.source_commit) && Object.keys(current.checks ?? {}).length >= 17 && Object.values(current.checks).every(x => x === true) &&
  (!raw || cleanupFresh(current, window)) ? 'PASS' : 'NOT_RUN', { execution_source:current?.source_commit??null,current_version_record: base + '/current/versions.json' });
const corpus = raw && sameExecution(raw.source_commit) && raw.before?.clean === true && raw.after?.clean === true &&
  [raw.before, raw.after].every(x => x.local === raw.source_commit && x.pi === raw.source_commit) && fullRunVerdict(spec, freeze, raw, record, window);
replace('M9-CORPUS', corpus ? 'PASS' : raw ? 'FAIL' : 'NOT_RUN', { evidence_mode: 'COMPLETE_NEW_20_TARGET_RUN',
  execution_source: raw?.source_commit ?? null, revision: 2, usable: record?.usable ?? null, denominator: 20, minimum_usable: 18 });
const cloud = raw && cloudContinuity(raw.cloud_before, raw.cloud_after);
let costs = null, budget = false;
if (raw?.ledger_before && raw.ledger_after && window?.consent) {
  const keys = new Set(raw.ledger_before.map(r => r.call_key)), ids = new Set(raw.results.map(r => r.response?.acquisition?.logical_id));
  const rows = raw.ledger_after.filter(r => !keys.has(r.call_key));
  costs = { openai_micro_usd: 0, decodo_micro_usd: 0, zyte_micro_usd: 0, parser_free_credits: 0, uncertain: [] };
  budget = budgetAdmission(window.consent, raw.month_usage_before) && rows.every(r => ids.has(r.logical_id) && ['SETTLED', 'RELEASED', 'UNCERTAIN'].includes(r.state));
  for (const r of rows) {
    const amount = Number(r.state === 'RELEASED' ? 0 : r.state === 'SETTLED' ? r.actual : r.reserved);
    if (!Number.isSafeInteger(amount) || amount < 0) budget = false;
    if (r.provider === 'llamaparse') costs.parser_free_credits += amount;
    else if (Object.hasOwn(costs, r.provider + '_micro_usd')) costs[r.provider + '_micro_usd'] += amount;
    else budget = false;
    if (r.state === 'UNCERTAIN') costs.uncertain.push({ call_key: r.call_key, reserved: amount });
  }
  budget &&= costs.openai_micro_usd === 0 && costs.decodo_micro_usd <= window.consent.new_proxy_micro_usd &&
    costs.zyte_micro_usd <= window.consent.new_enhanced_micro_usd && costs.parser_free_credits <= window.consent.new_parser_credits &&
    cleanupFresh(current, window);
}
results.push({ test_id: 'M9-V2-HISTORY', state: history ? 'PASS' : 'FAIL', immutable_commit: historyCommit, files: 905 });
results.push({ test_id: 'M9-V2-REVISION', state: integrity ? 'PASS' : 'FAIL' });
results.push({ test_id: 'M9-V2-APPLICABILITY', state: applicable ? 'PASS' : 'FAIL', changed_proof_paths: delta });
results.push({ test_id: 'M9-V2-CLOUD', state: cloud ? 'PASS' : raw ? 'FAIL' : 'NOT_RUN' });
results.push({ test_id: 'M9-V2-USAGE', state: budget ? 'PASS' : raw ? 'FAIL' : 'NOT_RUN', costs, invoices: null });
// Run last, after writing every other artifact. Default historical outputs stay untouched.
const scan = spawnSync(process.execPath, ['scripts/m9/redaction.mjs', '--corpus-v2'], { encoding: 'utf8', maxBuffer: 8 * 1048576 });
const redaction = json(base + '/redaction.json');
const cleanScan = scan.status === 0 && redaction?.source_commit === head && redaction.state === 'PASS' && redaction.positive_controls >= 4 &&
  redaction.live_secret_hashes >= 48 && redaction.inputs.every(x => digest(readFileSync(x.path)) === x.sha256);
replace('M9-REDACTION', cleanScan ? 'PASS' : 'FAIL', { current_scan: base + '/redaction.json' });
const dirty = codeDirty(git('status', '--porcelain=v1', '-z', '--untracked-files=all'));
const accepted = !dirty && results.every(x => x.state === 'PASS');
const paths = [base + '/freeze.json', base + '/premise-decision.json', base + '/history-preservation.json', base + '/corpus.json', base + '/live-window.json',
  base + '/review/REVIEW.md', base + '/review/gate.json', base + '/fixtures.json', base + '/fixtures.txt', base + '/current/versions.json', 'patches/series.json', 'deploy/versions.lock.json'];
const out = { schema: 'fcpi.m9-acceptance/v3', utc: new Date().toISOString(), source_commit: head, state: accepted ? 'ACCEPTED' : 'BLOCKED',
  code_dirty: dirty, exit_code: accepted ? 0 : 1, historical_acceptance: { path: 'evidence/M9/acceptance.json', sha256: digest(readFileSync('evidence/M9/acceptance.json')), execution_source: prior.source_commit },
  results, inputs: paths.filter(existsSync).map(path => ({ path, sha256: digest(readFileSync(path)) })), limitations: prior.limitations };
writeFileSync(base + '/acceptance.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ state: out.state, checks: results.length, passing: results.filter(r => r.state === 'PASS').length, corpus: record?.usable ?? 'NOT_RUN' }));
process.exitCode = out.exit_code;
