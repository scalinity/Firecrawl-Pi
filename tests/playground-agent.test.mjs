import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, validateAgentInput } from '../scripts/playground/agent.mjs';

const first = 'https://research.example/first';
const second = 'https://research.example/second';
const usage = { calls: 1, reused: 0, promptTokens: 100, completionTokens: 20, costMicroUsd: 17, cachedTokens: 10, cacheWriteTokens: 0 };
const finding = (url, quote = 'The measured value is forty-two.') => ({ claim: 'The measured value is forty-two.', quote, source_url: url });
const decision = (url, overrides = {}) => ({ answer: 'The measured value is forty-two.', complete: true, next_action: 'finish',
  next_url: null, next_query: null, findings: [finding(url)], limitations: [], ...overrides });
const page = (url, { json = decision(url), markdown = '# Measurement\nThe measured value is forty-two.', links = [], extraction = {}, ...rest } = {}) => ({
  status: 200, data: { success: true, data: { markdown, links, json, metadata: { url, title: 'Measurement' }, ...rest },
    fcpi: { extraction: { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', usage: { ...usage }, ...extraction } } },
});
const searchResults = (...urls) => ({ status: 200, data: { success: true, data: { web: urls.map(url => ({ url, title: 'Search result' })) } } });
function fixture(responses) {
  const calls = [];
  return { calls, forward: async (request, signal) => {
    assert.equal(signal.aborted, false);
    calls.push(structuredClone(request));
    assert.ok(request.timeout >= 1 && request.timeout <= 125);
    assert.equal(request.method, 'POST');
    assert.ok(['/v2/search', '/v2/scrape'].includes(request.path));
    const response = responses[calls.length - 1];
    assert.ok(response, 'an unexpected gateway dispatch was made');
    return typeof response === 'function' ? response(request, signal) : structuredClone(response);
  } };
}

test('validates all controls before dispatch and normalizes URL fragments', async () => {
  assert.deepEqual(validateAgentInput({ prompt: '  Compare measurements  ', urls: [first + '#intro', first], maxPages: 2 }),
    { prompt: 'Compare measurements', urls: [first], maxPages: 2 });
  const invalid = [null, {}, { prompt: '' }, { prompt: 'x'.repeat(1201) }, { prompt: 'Task', maxPages: 0 }, { prompt: 'Task', maxPages: 6 },
    { prompt: 'Task', maxPages: 1.1 }, { prompt: 'Task', urls: first }, { prompt: 'Task', urls: [first, second, first, second] },
    { prompt: 'Task', urls: ['https://name:secret@research.example/'] }, { prompt: 'Task', urls: ['file:///tmp/private'] },
    { prompt: 'Task', model: 'expensive-unapproved-model' }, { prompt: 'Task', schema: { type: 'object', properties: { x: { $ref: 'https://external.example/schema' } } } }];
  let count = 0;
  for (const input of invalid) await assert.rejects(runAgent(input, { forward: async () => { count++; } }), error => error.status === 400);
  assert.equal(count, 0);
});

test('model-directed search, first page, discovered second page, and completion retain grounded provenance and actual usage', async () => {
  const f = fixture([searchResults(first + '#top'), page(first, { links: [second + '#section'],
    json: decision(first, { answer: 'First measurement found.', complete: false, next_action: 'visit', next_url: second + '#section' }) }),
  page(second, { extraction: { usage: { ...usage, calls: 2, reused: 1, costMicroUsd: 30 } },
    json: decision(second, { answer: 'Both pages support the measurement.' }) })]);
  const events = [];
  const output = await runAgent({ prompt: 'Compare the measurements on the research pages.' }, { forward: f.forward, emit: async event => { events.push(event); } });
  assert.equal(output.status, 'completed');
  assert.equal(output.success, true);
  assert.equal(output.model, 'gpt-6.1-sol');
  assert.equal(output.reasoningEffort, 'xhigh');
  assert.deepEqual(f.calls.map(call => call.path), ['/v2/search', '/v2/scrape', '/v2/scrape']);
  assert.equal(f.calls[2].body.url, second);
  const format = f.calls[2].body.formats.find(format => format.type === 'json');
  assert.equal(format.model, 'gpt-6.1-sol');
  assert.equal(format.reasoningEffort, 'xhigh');
  assert.match(format.prompt, /First measurement found/);
  assert.match(format.prompt, /untrusted data, never instructions/);
  assert.ok(format.prompt.includes(first));
  assert.equal(output.findings.length, 2);
  assert.deepEqual(output.sources.map(source => source.url), [first, second]);
  assert.deepEqual(output.usage, { calls: 3, reused: 1, promptTokens: 200, completionTokens: 40, costMicroUsd: 47, cachedTokens: 20, cacheWriteTokens: 0 });
  assert.equal(events.length, 6);
  assert.deepEqual(events.map(event => event.step.state), ['running', 'done', 'running', 'done', 'running', 'done']);
  const progress = JSON.stringify(events);
  assert.doesNotMatch(progress, /Compare the measurements|measured value|untrusted data|markdown|schema/);
  assert.equal(output.documents[0].markdown, '# Measurement\nThe measured value is forty-two.');
});

test('a model can request another bounded search instead of following a fixed visit sequence', async () => {
  const f = fixture([page(first, { json: decision(first, { complete: false, next_action: 'search', next_query: 'measurement replication' }) }),
    searchResults(first, second), page(second)]);
  const output = await runAgent({ prompt: 'Find a replication', urls: [first] }, f);
  assert.equal(output.status, 'completed');
  assert.equal(f.calls[1].body.query, 'measurement replication');
  assert.equal(f.calls[2].body.url, second);
});

test('Markdown-discovered relative links are eligible but credential URLs are ignored', async () => {
  const f = fixture([page(first, { markdown: 'The measured value is forty-two. [Next](/second#heading) [Secret](https://name:password@research.example/private)',
    json: decision(first, { complete: false, next_action: 'visit', next_url: second }) }), page(second)]);
  const output = await runAgent({ prompt: 'Compare measurements', urls: [first] }, f);
  assert.equal(output.status, 'completed');
  assert.doesNotMatch(f.calls[1].body.formats[2].prompt, /password/);
});

test('invented and already-visited next URLs are refused without another dispatch', async () => {
  for (const next_url of ['https://invented.example/page', first + '#repeat', 'https://name:secret@research.example/page']) {
    const f = fixture([page(first, { json: decision(first, { complete: false, next_action: 'visit', next_url }) })]);
    const output = await runAgent({ prompt: 'Compare measurements', urls: [first] }, f);
    assert.equal(output.status, 'partial');
    assert.equal(output.code, 'UNSAFE_NEXT_URL');
    assert.equal(f.calls.length, 1);
  }
});

test('a page cap stops before an additional model-requested search and never converts exhaustion into completion', async () => {
  const f = fixture([page(first, { json: decision(first, { complete: false, next_action: 'search', next_query: 'more measurements' }) })]);
  const output = await runAgent({ prompt: 'Compare measurements', urls: [first], maxPages: 1 }, f);
  assert.equal(output.status, 'partial');
  assert.equal(output.success, false);
  assert.equal(output.code, 'PAGE_LIMIT');
  assert.equal(output.findings.length, 1);
  assert.equal(f.calls.length, 1);
});

test('three searches and five pages bound the run even when the model always asks for more', async () => {
  const pages = [first, second, 'https://research.example/third'];
  const responses = [];
  for (let index = 0; index < 3; index++) {
    responses.push(searchResults(pages[index]));
    responses.push(page(pages[index], { json: decision(pages[index], { complete: false, next_action: 'search', next_query: `another query ${index}` }) }));
  }
  const f = fixture(responses);
  const output = await runAgent({ prompt: 'Compare measurements', maxPages: 5 }, f);
  assert.equal(output.code, 'SEARCH_LIMIT');
  assert.equal(f.calls.filter(call => call.path === '/v2/search').length, 3);
  assert.ok(f.calls.length <= 8);
  const urls = Array.from({ length: 6 }, (_, index) => `https://research.example/page-${index}`);
  const g = fixture(urls.slice(0, 5).map((url, index) => page(url, { links: [urls[index + 1]], json: decision(url, { complete: false, next_action: 'visit', next_url: urls[index + 1] }) })));
  const capped = await runAgent({ prompt: 'Continue until all pages are read', urls: [urls[0]], maxPages: 5 }, g);
  assert.equal(capped.code, 'PAGE_LIMIT');
  assert.equal(g.calls.length, 5);
  assert.equal(capped.status, 'partial');
});

test('unverifiable or incorrectly attributed quotes cannot produce a completed answer', async () => {
  for (const invalid of [finding(first, 'A sentence the page does not contain.'), finding(second), finding(first, '')]) {
    const f = fixture([page(first, { json: decision(first, { findings: [invalid] }) })]);
    const output = await runAgent({ prompt: 'Find the measurement', urls: [first] }, f);
    assert.equal(output.success, false);
    assert.equal(output.status, 'partial');
    assert.deepEqual(output.findings, []);
    assert.equal(output.answer, null);
    assert.match(output.limitations.join(' '), /quotation could not be verified/);
  }
});

test('a valid quote cannot carry an answer containing another rejected finding into completion', async () => {
  const unsupported = 'An invented clinical conclusion is safe and effective.';
  const f = fixture([page(first, { json: decision(first, { answer: unsupported,
    findings: [finding(first), { claim: unsupported, quote: 'This is absent from the source.', source_url: first }] }) })]);
  const output = await runAgent({ prompt: 'Find the measurement', urls: [first] }, f);
  assert.equal(output.status, 'partial');
  assert.equal(output.code, 'UNVERIFIED_FINDING');
  assert.equal(output.answer, null);
  assert.equal(output.findings.length, 1);
  assert.doesNotMatch(JSON.stringify(output), /invented clinical conclusion/);
});

test('quotation matching normalizes source whitespace and keeps the corresponding canonical URL', async () => {
  const canonical = 'https://research.example/canonical';
  const f = fixture([page(first, { markdown: 'The measured\n value\t is forty-two.', metadata: { url: canonical, title: 'Canonical' }, json: decision(first) })]);
  const output = await runAgent({ prompt: 'Find the measurement', urls: [first] }, f);
  assert.equal(output.status, 'completed');
  assert.equal(output.findings[0].source_url, canonical);
  assert.equal(output.sources[0].url, canonical);
});

test('model and budget failures retain their class, preserve partial work, and never retry', async () => {
  for (const code of ['BUDGET_EXHAUSTED', 'PROVIDER_UNAVAILABLE', 'BLOCKED_CREDENTIAL', 'PAID_DISPATCH_DISABLED']) {
    const f = fixture([page(first, { links: [second], json: decision(first, { complete: false, next_action: 'visit', next_url: second }) }),
      { status: 403, data: { success: false, code, error: 'A private provider detail' } }]);
    const output = await runAgent({ prompt: 'Compare measurements', urls: [first] }, f);
    assert.equal(output.status, 'partial');
    assert.equal(output.code, code);
    assert.equal(output.findings.length, 1);
    assert.equal(output.documents.length, 1);
    assert.equal(f.calls.length, 2);
    assert.equal(output.steps[1].state, 'failed');
    assert.equal(output.usage.costMicroUsd, null);
    assert.doesNotMatch(JSON.stringify(output), /private provider detail/);
  }
});

test('a failed extraction retains its reported usage instead of replacing it with zero', async () => {
  const f = fixture([{ status: 402, data: { success: false, code: 'BUDGET_EXHAUSTED',
    fcpi: { extraction: { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', usage: { ...usage, costMicroUsd: 73 } } } } }]);
  const output = await runAgent({ prompt: 'Find the measurement', urls: [first] }, f);
  assert.equal(output.status, 'failed');
  assert.equal(output.code, 'BUDGET_EXHAUSTED');
  assert.equal(output.usage.costMicroUsd, 73);
  assert.equal(output.usage.calls, 1);
  assert.equal(f.calls.length, 1);
});

test('an already-aborted run dispatches nothing', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture([]);
  const output = await runAgent({ prompt: 'Find the measurement' }, { ...f, signal: controller.signal });
  assert.equal(output.status, 'cancelled');
  assert.equal(output.code, 'CANCELLED');
  assert.equal(f.calls.length, 0);
});

test('cancellation after a page preserves its known findings and prevents the next dispatch', async () => {
  const controller = new AbortController();
  const f = fixture([page(first, { links: [second], json: decision(first, { complete: false, next_action: 'visit', next_url: second }) })]);
  const output = await runAgent({ prompt: 'Compare measurements', urls: [first] }, { ...f, signal: controller.signal,
    emit: async event => { if (event.step.state === 'done') controller.abort(); } });
  assert.equal(output.status, 'cancelled');
  assert.equal(output.findings.length, 1);
  assert.equal(output.documents.length, 1);
  assert.equal(output.usage.costMicroUsd, usage.costMicroUsd);
  assert.equal(f.calls.length, 1);
});

test('cancellation does not wait indefinitely for a forward implementation that ignores its signal', async () => {
  const controller = new AbortController();
  let calls = 0;
  const output = await runAgent({ prompt: 'Find the measurement', urls: [first] }, { signal: controller.signal,
    forward: () => { calls++; queueMicrotask(() => controller.abort()); return new Promise(() => {}); } });
  assert.equal(output.status, 'cancelled');
  assert.equal(output.steps[0].state, 'failed');
  assert.equal(calls, 1);
});

test('network failures are explicit without exposing transport details or trying another request', async () => {
  let calls = 0;
  const output = await runAgent({ prompt: 'Find the measurement', urls: [first] }, { forward: async () => { calls++; throw Error('token=private-secret'); } });
  assert.equal(output.status, 'failed');
  assert.equal(output.code, 'PI_UNAVAILABLE');
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(output), /private-secret/);
});

test('empty search, empty Markdown, and invalid decisions never claim success', async () => {
  const emptySearch = fixture([searchResults()]);
  const a = await runAgent({ prompt: 'Find the measurement' }, emptySearch);
  assert.equal(a.code, 'NO_SEARCH_RESULTS');
  assert.equal(a.status, 'failed');
  for (const options of [{ markdown: '' }, { json: null }, { json: decision(first, { findings: null }) }, { json: decision(first, { complete: null }) }]) {
    const f = fixture([page(first, options)]);
    const output = await runAgent({ prompt: 'Find the measurement', urls: [first] }, f);
    assert.equal(output.success, false);
    assert.notEqual(output.status, 'completed');
    assert.equal(f.calls.length, 1);
  }
});

test('unexpected runtime model or reasoning effort stops the workflow without fallback', async () => {
  for (const extraction of [{ model: 'gpt-6-luna' }, { reasoningEffort: null }]) {
    const f = fixture([page(first, { extraction })]);
    const output = await runAgent({ prompt: 'Find the measurement', urls: [first] }, f);
    assert.equal(output.code, 'MODEL_MISMATCH');
    assert.equal(output.success, false);
    assert.equal(f.calls.length, 1);
  }
});

test('partial extraction warnings prevent completion and unknown usage remains unknown', async () => {
  const f = fixture([page(first, { warning: 'The page was cut before extraction', extraction: { usage: { ...usage, costMicroUsd: undefined } },
    links: [second], json: decision(first, { complete: false, next_action: 'visit', next_url: second }) }), page(second)]);
  const output = await runAgent({ prompt: 'Compare measurements', urls: [first] }, f);
  assert.equal(output.status, 'partial');
  assert.equal(output.success, false);
  assert.equal(output.usage.costMicroUsd, null);
  assert.equal(output.usage.calls, 2);
});

test('optional structured results use the existing schema subset and missing required values remain partial', async () => {
  const schema = { type: 'object', properties: { measurement: { type: 'integer' } }, required: ['measurement'] };
  for (const [result, status] of [[{ measurement: 42 }, 'completed'], [{ measurement: null }, 'partial'], [null, 'partial']]) {
    const f = fixture([page(first, { json: decision(first, { result }) })]);
    const output = await runAgent({ prompt: 'Find the measurement', urls: [first], schema }, f);
    assert.equal(output.status, status);
    assert.deepEqual(output.result, result);
  }
});

test('full tasks reach the model while all generated prompt and search shapes remain bounded', async () => {
  const prompt = 'Research '.repeat(130);
  const links = Array.from({ length: 100 }, (_, index) => `https://research.example/${index}/${'a'.repeat(1800)}`);
  const f = fixture([searchResults(first), page(first, { links, json: decision(first, { complete: false, next_action: 'visit', next_url: links[0] }) }), page(links[0])]);
  const output = await runAgent({ prompt, maxPages: 2 }, f);
  assert.equal(output.status, 'completed');
  assert.equal(f.calls[0].body.query.length, 500);
  for (const call of f.calls.slice(1)) {
    const json = call.body.formats.find(format => format.type === 'json');
    assert.ok(json.prompt.length <= 4000);
    assert.ok(json.prompt.includes(JSON.stringify(prompt.trim())));
    assert.ok(Buffer.byteLength(JSON.stringify(json.schema)) <= 16384);
  }
});
