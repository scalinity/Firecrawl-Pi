import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startServer, prepareRequest } from '../scripts/playground/server.mjs';

const calls = [];
const server = await startServer({ port: 0, forward: async request => {
  calls.push(request);
  return { status: 200, data: { success: true, data: { markdown: '<script>untrusted</script>', json: { title: 'Example' } } } };
} });
const origin = 'http://127.0.0.1:' + server.address().port;
after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
const post = (path, body, headers = {}) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('serves only the playground; repository files and cross-origin callers cannot use the bridge', async () => {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Live playground/);
  assert.equal((await fetch(origin + '/scripts/m1/pi-target.conf')).status, 404);
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
