import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { startServer, prepareRequest, sshForward } from '../scripts/playground/server.mjs';

const calls = [];
const server = await startServer({ port: 0, forward: async request => {
  calls.push(request);
  return { status: 200, data: { success: true, data: { markdown: '<script>untrusted</script>', json: { title: 'Example' } } } };
} });
const origin = 'http://127.0.0.1:' + server.address().port;
after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const agentInput = { prompt: 'Find a supported fact.', urls: ['https://example.com/'], maxPages: 1 };
const agentResponse = (extra = {}) => ({ status: 200, data: { success: true, data: {
  markdown: 'The source states a verified fact.', metadata: { url: 'https://example.com/', title: 'Source' }, links: [],
  json: { answer: 'A verified fact.', complete: true, next_action: 'finish', next_url: null,
    next_query: null, findings: [{ claim: 'A verified fact.', quote: 'a verified fact',
      source_url: 'https://example.com/' }], limitations: [], ...extra }
}, fcpi: { extraction: { model: 'claude-opus-5-5', reasoningEffort: 'high', usage: { calls: 1, reused: 0,
  promptTokens: 100, completionTokens: 25, costMicroUsd: 2, cachedTokens: 0, cacheWriteTokens: 0 } } } } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const closeServer = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
const agentPost = (base, body = agentInput, headers = {}) => fetch(base + '/api/agent', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function* ndjson(response) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, boundary);
      pending = pending.slice(boundary + 1);
      if (line) yield JSON.parse(line);
    }
  }
  pending += decoder.decode();
  assert.equal(pending, '', 'the stream ends on a complete NDJSON line');
}

test('serves only the playground; repository files and cross-origin callers cannot use the bridge', async () => {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Live playground/);
  assert.equal((await fetch(origin + '/scripts/m1/pi-target.conf')).status, 404);
  for (const path of ['/assets/marked.js','/assets/dompurify.js']) {
    const asset=await fetch(origin+path);
    assert.equal(asset.status,200);
    assert.match(asset.headers.get('content-type'),/^text\/javascript/);
  }
  assert.equal((await fetch(origin+'/assets/versions.json')).status,404);
  assert.equal((await fetch(origin+'/assets/../server.mjs')).status,404);
  const count = calls.length;
  assert.equal((await post('/api/status', {}, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('/api/status', {}, { origin: 'null' })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = request(origin + '/api/status', { method: 'POST', headers: { host: 'untrusted.example', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(badHost, 403);
  assert.equal((await post('/api/status', {}, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(calls.length, count);
});

test('LLM requires an explicit boolean switch on scrape and a valid bounded schema', async () => {
  const base = { operation: 'scrape', input: 'https://example.com' };
  assert.deepEqual(prepareRequest('/api/run', base).body.formats, ['markdown']);
  const result = await post('/api/run', { ...base, llm: true, prompt: 'Find title', schema: { type: 'object', properties: { title: { type: 'string' } } } });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.request.body.formats[1].type, 'json');
  assert.equal(body.data.data.json.title, 'Example');
  for (const input of [{ ...base, llm: 'true' }, { ...base, llm: true }, { operation: 'search', input: 'test', llm: true }, { ...base, input: 'https://name:password@example.com' }]) {
    assert.equal((await post('/api/run', input)).status, 400);
  }
});

test('browser input cannot select arbitrary gateway routes, headers or crawl paths', async () => {
  const count = calls.length;
  for (const body of [{ operation: 'constructor', input: 'test' }, { operation: 'crawl', input: 'https://example.com', limit: 100 }, { operation: 'crawl', input: 'https://example.com', key: 'bad\nheader' }]) {
    assert.equal((await post('/api/run', body)).status, 400);
  }
  assert.equal((await post('/api/crawl-status', { id: '../../platform/v1/status' })).status, 400);
  assert.equal((await post('/api/arbitrary', {})).status, 404);
  assert.equal(calls.length, count);
  const r = prepareRequest('/api/run', { operation: 'crawl', input: 'https://example.com', key: 'stable-submission-key', limit: 2, headers: { authorization: 'untrusted' } });
  assert.equal(r.key, 'stable-submission-key');
  assert.equal(r.body.limit, 2);
  assert.equal(r.headers, undefined);
  assert.equal(prepareRequest('/api/crawl-cancel', { id: '12345678-1234-1234-1234-123456789012' }).method, 'DELETE');
});

test('oversized and malformed bodies fail before gateway dispatch', async () => {
  const count = calls.length;
  assert.equal((await post('/api/run', { input: 'x'.repeat(40000) })).status, 413);
  const r = await fetch(origin + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid' });
  assert.equal(r.status, 400);
  assert.equal(calls.length, count);
});

test('gateway outages are visible and do not trigger retries or expose errors', async () => {
  let attempts = 0;
  const failed = await startServer({ port: 0, forward: async () => { attempts++; throw Error('private connection detail'); } });
  try {
    const r = await fetch('http://127.0.0.1:' + failed.address().port + '/api/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503);
    const body = await r.text();
    assert.doesNotMatch(body, /private connection detail/);
    assert.match(body, /No automatic retry/);
    assert.equal(attempts, 1);
  } finally { failed.closeAllConnections(); await new Promise(resolve => failed.close(resolve)); }
});

test('SSH forwarding preserves UTF-8 characters split across stdout chunks', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fcpi-playground-ssh-'));
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  });
  // Only this stand-in runs: no SSH connection or remote request is made.
  await writeFile(join(directory, 'ssh'), `#!${process.execPath}
const lines = require('node:readline').createInterface({input:process.stdin});
lines.once('line', () => {
  const bytes = Buffer.from(JSON.stringify({status:200,data:{text:'A café 🧠 fact'}}));
  const offset = bytes.indexOf(Buffer.from('🧠')) + 1;
  process.stdout.write(bytes.subarray(0, offset));
  setTimeout(() => process.stdout.end(bytes.subarray(offset), () => process.exit(0)), 25);
});
`, { mode: 0o700 });
  process.env.PATH = directory + delimiter + originalPath;
  const forward = sshForward();
  const result = await forward({ method: 'GET', path: '/platform/v1/status', timeout: 1 });
  assert.equal(result.data.text, 'A café 🧠 fact');
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(forward({ method: 'GET', path: '/platform/v1/status', timeout: 1 }, cancelled.signal), { name: 'AbortError' });
});

test('Agent rejects invalid input, origin, Host, media type, and oversized bodies before streaming or dispatch', { timeout: 5000 }, async t => {
  let dispatches = 0;
  const guarded = await startServer({ port: 0, forward: async () => { dispatches++; return agentResponse(); } });
  t.after(() => closeServer(guarded));
  const base = 'http://127.0.0.1:' + guarded.address().port;
  for (const body of [{}, { ...agentInput, maxPages: 6 }, { ...agentInput, urls: 'https://example.com/' },
    { ...agentInput, urls: ['https://name:password@example.com/'] }]) {
    const response = await agentPost(base, body);
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal((await response.json()).type, undefined, 'validation does not acknowledge an Agent stream');
  }
  for (const origin of ['https://untrusted.example', 'null']) {
    assert.equal((await agentPost(base, agentInput, { origin })).status, 403);
  }
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(base + '/api/agent', { method: 'POST', headers: { host: 'untrusted.example', 'content-type': 'application/json' } },
      res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify(agentInput));
  });
  assert.equal(hostStatus, 403);
  assert.equal((await agentPost(base, agentInput, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await agentPost(base, { ...agentInput, prompt: 'x'.repeat(40000) })).status, 413);
  const malformed = await fetch(base + '/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid' });
  assert.equal(malformed.status, 400);
  assert.match(malformed.headers.get('content-type'), /^application\/json/);
  assert.equal(dispatches, 0);
});

test('remote Python forwards a large UTF-8 response without ASCII expansion', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fcpi-playground-unicode-'));
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(directory, { recursive: true, force: true });
  });
  const python = [
    'import sys, shlex, json, io, builtins, urllib.request',
    'command = shlex.split(sys.argv[1])',
    'assert command[:4] == ["sudo", "-n", "python3", "-c"]',
    'raw = json.dumps({"text": "汉" * 1800000}, ensure_ascii=False).encode("utf-8")',
    'assert len(raw) < 8 * 1024 * 1024',
    'real_open = builtins.open',
    'builtins.open = lambda p, *a, **k: io.StringIO("synthetic-fixture-token") if p.startswith("/etc/firecrawl-pi/secrets/clients/") else real_open(p, *a, **k)',
    'class Response(io.BytesIO):',
    '    status = 200',
    'class Opener:',
    '    def open(self, *args, **kwargs): return Response(raw)',
    'urllib.request.build_opener = lambda *args: Opener()',
    'exec(command[4])'
  ].join('\n');
  await writeFile(join(directory, 'ssh'), '#!' + process.execPath + '\n' +
    "const {spawn}=require('node:child_process');\n" +
    "const child=spawn('python3',['-c'," + JSON.stringify(python) + ",process.argv.at(-1)],{stdio:'inherit'});\n" +
    "child.on('exit',code=>process.exit(code??1));\n", { mode: 0o700 });
  process.env.PATH = directory + delimiter + originalPath;
  const result = await sshForward()({ method: 'GET', path: '/platform/v1/status', timeout: 3 });
  assert.equal(result.status, 200);
  assert.equal(result.data.text.length, 1800000);
  assert.equal(result.data.text, '汉'.repeat(1800000));
});

test('Agent streams progress before completion and returns the workflow wrapper without a durable job claim', { timeout: 5000 }, async t => {
  const dispatched = deferred(), release = deferred();
  const requests = [];
  const streaming = await startServer({ port: 0, forward: async request => {
    requests.push(request);
    dispatched.resolve();
    await release.promise;
    return agentResponse();
  } });
  t.after(() => { release.resolve(); return closeServer(streaming); });
  const response = await agentPost('http://127.0.0.1:' + streaming.address().port);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson; charset=utf-8$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const stream = ndjson(response);
  const first = (await stream.next()).value;
  assert.equal(first.type, 'step');
  assert.equal(first.step.state, 'running');
  assert.equal(first.step.tool, 'scrape');
  assert.equal(first.step.markdown, undefined);
  assert.equal(first.step.prompt, undefined);
  await dispatched.promise;
  release.resolve();
  const remaining = [];
  for await (const event of stream) remaining.push(event);
  assert.ok(remaining.some(event => event.type === 'step' && event.step.state === 'done'));
  const last = remaining.at(-1);
  assert.equal(last.type, 'result');
  assert.equal(last.result.status, 200);
  assert.equal(last.result.data.status, 'completed');
  assert.equal(last.result.data.success, true);
  assert.equal(last.result.request.method, 'WORKFLOW');
  assert.equal(last.result.request.path, 'fcpi search → scrape + JSON');
  assert.deepEqual(last.result.request.body, agentInput);
  assert.equal(last.result.data.id, undefined);
  assert.ok(Number.isInteger(last.result.elapsedMs));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v2/scrape');
});

test('only one Agent streams at once while ordinary requests retain capacity', { timeout: 5000 }, async t => {
  const dispatched = deferred(), release = deferred();
  let agentCalls = 0;
  const limited = await startServer({ port: 0, forward: async request => {
    if (request.path !== '/v2/scrape') return { status: 200, data: { success: true } };
    agentCalls++;
    dispatched.resolve();
    await release.promise;
    return agentResponse();
  } });
  t.after(() => { release.resolve(); return closeServer(limited); });
  const base = 'http://127.0.0.1:' + limited.address().port;
  const first = await agentPost(base);
  await dispatched.promise;
  const denied = await agentPost(base);
  assert.equal(denied.status, 429);
  assert.match(denied.headers.get('content-type'), /^application\/json/);
  assert.match((await denied.json()).error, /Agent run is already active/);
  const health = await fetch(base + '/api/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(health.status, 200);
  assert.equal(agentCalls, 1);
  release.resolve();
  await first.text();
  const next = await agentPost(base);
  assert.equal(next.status, 200);
  await next.text();
  assert.equal(agentCalls, 2, 'the Agent slot is released after completion');
});

test('Agent shares the existing three-request capacity limit', { timeout: 5000 }, async t => {
  const release = deferred(), busy = deferred();
  let activeCalls = 0;
  const limited = await startServer({ port: 0, forward: async () => {
    activeCalls++;
    if (activeCalls === 3) busy.resolve();
    await release.promise;
    return { status: 200, data: { success: true } };
  } });
  t.after(() => { release.resolve(); return closeServer(limited); });
  const base = 'http://127.0.0.1:' + limited.address().port;
  const pending = Array.from({ length: 3 }, () => fetch(base + '/api/status', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  await busy.promise;
  const denied = await agentPost(base);
  assert.equal(denied.status, 429);
  assert.match(denied.headers.get('content-type'), /^application\/json/);
  assert.equal(activeCalls, 3);
  release.resolve();
  for (const response of await Promise.all(pending)) await response.text();
});

test('disconnect aborts the in-flight signal and prevents a subsequent Agent dispatch', { timeout: 5000 }, async t => {
  const dispatched = deferred(), aborted = deferred();
  let dispatches = 0;
  const cancellable = await startServer({ port: 0, forward: async (_request, signal) => {
    dispatches++;
    dispatched.resolve();
    // A late response still asks for another page: cancellation must defeat it.
    return await new Promise(resolve => signal.addEventListener('abort', () => {
      const response = agentResponse({ complete: false, next_action: 'visit', next_url: 'https://example.org/', next_query: null });
      response.data.data.links = ['https://example.org/'];
      resolve(response);
      aborted.resolve();
    }, { once: true }));
  } });
  t.after(() => closeServer(cancellable));
  const response = await agentPost('http://127.0.0.1:' + cancellable.address().port, { ...agentInput, maxPages: 2 });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /"state":"running"/);
  await dispatched.promise;
  await reader.cancel();
  await aborted.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatches, 1);
});

test('errors after stream headers become a safe failed result and do not retry or break later responses', { timeout: 5000 }, async t => {
  let attempts = 0;
  const failed = await startServer({ port: 0, forward: async request => {
    if (request.path !== '/v2/scrape') return { status: 200, data: { success: true } };
    attempts++;
    throw Error('private SSH token and filesystem detail');
  } });
  t.after(() => closeServer(failed));
  const base = 'http://127.0.0.1:' + failed.address().port;
  const response = await agentPost(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
  const body = await response.text();
  assert.doesNotMatch(body, /private SSH token and filesystem detail/);
  const events = body.trim().split('\n').map(line => JSON.parse(line));
  const last = events.at(-1);
  assert.equal(last.type, 'result');
  assert.equal(last.result.data.success, false);
  assert.equal(last.result.data.status, 'failed');
  assert.ok(last.result.data.steps.some(step => step.state === 'failed'));
  assert.equal(attempts, 1);
  const health = await fetch(base + '/api/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(health.status, 200);
});
