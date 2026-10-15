// Local UI: credentials stay on the Pi; requests use the project's existing SSH target.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadManifest } from '../../services/access/client.mjs';
import { validateBody, checkUrl } from '../../services/access/src/validate.mjs';
import { validateAgentInput, runAgent } from './agent.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = loadManifest();
const routes = Object.fromEntries(manifest.routes.map(r => [r.id, r]));
const bad = message => Object.assign(Error(message), { status: 400 });
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const assets = new Map([
  ['/assets/marked.js', resolve(root,'scripts/playground/vendor/marked.js')],
  ['/assets/dompurify.js', resolve(root,'scripts/playground/vendor/dompurify.js')]
]);

// Fixed code, JSON on stdin. Never interpolate request input into a remote shell command.
// Refuse redirects so the gateway credential can only reach its loopback origin.
const remote = String.raw`
import json, sys, os, threading, urllib.request, urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None
try:
    q = json.loads(sys.stdin.readline())
    # Keep stdin open for this request's lifetime. SSH disconnect turns it into EOF;
    # exiting closes urllib's socket so the gateway can cancel remaining extraction.
    def watch_connection():
        sys.stdin.read(1)
        os._exit(0)
    threading.Thread(target=watch_connection, daemon=True).start()
    with open('/etc/firecrawl-pi/secrets/clients/' + q['client'] + '.token') as f:
        token = f.read().strip()
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}
    if q.get('key'): headers['x-idempotency-key'] = q['key']
    data = None
    if q.get('body') is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(q['body']).encode()
    req = urllib.request.Request('http://127.0.0.1:3380' + q['path'], data=data,
                                 headers=headers, method=q['method'])
    try:
        response = urllib.request.build_opener(NoRedirect).open(req, timeout=q['timeout'])
    except urllib.error.HTTPError as e:
        response = e
    with response:
        raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024: raise ValueError('response limit')
        sys.stdout.buffer.write((json.dumps({'status': response.status, 'data': json.loads(raw)},
                                ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
except Exception:
    print(json.dumps({'status': 503, 'data': {'success': False, 'code': 'PI_UNAVAILABLE',
          'error': 'The Pi gateway did not return a readable response. No automatic retry was made.'}}))
`;
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

export function sshForward() {
  const [target, key] = execFileSync('bash', ['-c',
    'source "$1"; printf "%s\\n%s\\n" "$PI_SSH_TARGET" "$PI_SSH_KEY"',
    'fcpi-playground', resolve(root, 'scripts/m1/pi-target.conf')],
    { encoding: 'utf8', timeout: 5000 }).trim().split('\n');
  const client = process.env.FCPI_PLAYGROUND_CLIENT ?? 'm9codex';
  if (!target || !key || !/^[a-z0-9_-]{1,40}$/.test(client)) throw Error('Invalid playground SSH configuration');
  return (request, signal) => new Promise((resolveResult, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? Error('Disconnected'));
    const child = spawn('ssh', ['-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8', target, 'sudo -n python3 -c ' + quote(remote)],
      { stdio: ['pipe', 'pipe', 'ignore'] });
    let text = '', bytes = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolveResult(result);
    };
    const abort = () => finish(Error('Disconnected'));
    const timer = setTimeout(() => finish(Error('Pi timeout')), (request.timeout + 10) * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 9 * 1024 * 1024) return finish(Error('Pi response too large'));
      text += chunk;
    });
    child.on('error', finish);
    child.stdin.on('error', () => finish(Error('Pi connection closed')));
    child.on('close', code => {
      if (code !== 0) return finish(Error('Pi connection failed'));
      try {
        const value = JSON.parse(text);
        if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599) throw Error();
        finish(null, value);
      } catch { finish(Error('Pi response invalid')); }
    });
    if (!settled) child.stdin.write(JSON.stringify({ ...request, client }) + '\n');
  });
}

export function prepareRequest(endpoint, input) {
  if (!object(input)) throw bad('A JSON object is required.');
  let id, body, key;
  if (endpoint === '/api/status') id = 'platform.status';
  else if (endpoint === '/api/crawl-status' || endpoint === '/api/crawl-cancel') {
    if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id)) throw bad('Enter a valid crawl job ID.');
    id = endpoint.endsWith('cancel') ? 'crawl.cancel' : 'crawl.status';
  } else if (endpoint === '/api/run') {
    if (!['scrape', 'search', 'map', 'crawl'].includes(input.operation)) throw bad('Choose Scrape, Search, Map, or Crawl.');
    if (typeof input.input !== 'string' || !input.input.trim() || input.input.length > 2048) throw bad('Enter a URL or query of at most 2048 characters.');
    if (input.llm !== undefined && typeof input.llm !== 'boolean') throw bad('LLM extraction must be on or off.');
    if (input.llm && input.operation !== 'scrape') throw bad('LLM extraction is available on Scrape.');
    const limit = input.limit ?? (input.operation === 'crawl' ? 3 : 5);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw bad('The result/page limit must be from 1 to 10.');
    if (input.operation !== 'search') {
      const why = checkUrl(input.input);
      if (why) throw bad('URL ' + why + '.');
    }
    const url = input.input.trim();
    if (input.operation === 'scrape') {
      body = { url, formats: ['markdown'], onlyMainContent: true };
      if (input.llm) {
        if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw bad('Enter instructions for the model.');
        if (!object(input.schema)) throw bad('Enter a JSON Schema object.');
        body.formats.push({ type: 'json', prompt: input.prompt.trim(), schema: input.schema });
      }
    } else if (input.operation === 'search') body = { query: url, limit };
    else if (input.operation === 'map') body = { url, limit };
    else body = { url, limit, scrapeOptions: { formats: ['markdown'], onlyMainContent: true } };
    id = input.operation === 'crawl' ? 'crawl.submit' : input.operation;
    validateBody(routes[id].body, body, manifest);
    if (input.operation === 'crawl') {
      if (typeof input.key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(input.key)) throw bad('A crawl submission key is required.');
      key = input.key;
    }
  } else throw Object.assign(Error('Not found'), { status: 404 });
  const route = routes[id];
  return { method: route.method, path: route.path.replace('{id}', input.id ?? '') +
    (id === 'crawl.status' ? '?limit=10' : ''), body, key, timeout: id === 'platform.status' ? 15 : 125 };
}

export async function startServer({ port = 8767, forward = sshForward() } = {}) {
  let active = 0, activeAgents = 0;
  const server = createServer(async (req, res) => {
    const expected = new Set([`localhost:${server.address().port}`, `127.0.0.1:${server.address().port}`]);
    const headers = type => ({ 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    const send = (status, data, type = 'application/json') => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.end();
      res.writeHead(status, headers(type));
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    if (!expected.has(req.headers.host)) return send(403, { error: 'Use localhost to open the playground.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'Cross-origin requests are refused.' });
    const endpoint = req.url;
    if (req.method === 'GET' && ['/', '/LLM-DEMO.html'].includes(endpoint)) return send(200, readFileSync(resolve(root, 'LLM-DEMO.html')), 'text/html');
    if (req.method === 'GET' && assets.has(endpoint)) return send(200, readFileSync(assets.get(endpoint)), 'text/javascript');
    if (req.method === 'GET' && endpoint === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (req.method !== 'POST' || !['/api/run', '/api/agent', '/api/status', '/api/crawl-status', '/api/crawl-cancel'].includes(endpoint)) return send(404, { error: 'Not found' });
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return send(415, { error: 'Use application/json.' });
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    try {
      let bytes = 0, chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) return send(413, { error: 'Request is too large (32 KiB maximum).' });
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw bad('Invalid JSON.'); }
      const isAgent = endpoint === '/api/agent';
      const request = isAgent ? validateAgentInput(input) : prepareRequest(endpoint, input);
      if (active >= 3) return send(429, { error: 'The playground is busy. Wait for the current request.' });
      if (isAgent && activeAgents) return send(429, { error: 'An Agent run is already active. Wait for it to finish or cancel it.' });
      controller.signal.throwIfAborted();
      active++;
      const started = performance.now();
      try {
        if (isAgent) {
          activeAgents++;
          const steps = new Map();
          const deadline = setTimeout(() => controller.abort(), 360000);
          const finishAgent = payload => {
            if (res.destroyed || res.writableEnded) return;
            res.end(JSON.stringify({ type: 'result', result: { status: 200, data: payload,
              elapsedMs: Math.round(performance.now() - started), request: {
                method: 'WORKFLOW', path: 'fcpi search → scrape + JSON', body: request } } }) + '\n');
          };
          try {
            // Headers acknowledge a synchronous stream, never a durable job receipt.
            res.writeHead(200, headers('application/x-ndjson'));
            res.flushHeaders();
            const emit = async event => {
              controller.signal.throwIfAborted();
              if (res.destroyed || res.writableEnded) throw Error('Disconnected');
              if (event?.type !== 'step' || !object(event.step)) throw Error('Invalid progress event');
              steps.set(event.step.id, event.step);
              if (res.write(JSON.stringify(event) + '\n')) return;
              await new Promise((resolveDrain, rejectDrain) => {
                const cleanup = () => {
                  res.removeListener('drain', drained);
                  res.removeListener('close', stopped);
                  controller.signal.removeEventListener('abort', stopped);
                };
                const drained = () => { cleanup(); resolveDrain(); };
                const stopped = () => { cleanup(); rejectDrain(Error('Stream closed')); };
                res.once('drain', drained);
                res.once('close', stopped);
                controller.signal.addEventListener('abort', stopped, { once: true });
                if (res.destroyed || controller.signal.aborted) stopped();
              });
            };
            const result = await runAgent(request, {
              signal: controller.signal, emit,
              forward: (next, signal) => {
                controller.signal.throwIfAborted();
                return forward(next, signal ?? controller.signal);
              }
            });
            finishAgent(result);
          } catch {
            const cancelled = controller.signal.aborted;
            const message = cancelled ? 'The Agent run was cancelled or reached its six-minute limit. Work already sent may have consumed budget.' :
              'The Agent run could not finish. No automatic retry was made.';
            finishAgent({ success: false, status: cancelled ? 'cancelled' : 'failed', answer: '',
              findings: [], sources: [], documents: [], steps: [...steps.values()], usage: null, model: null,
              reasoningEffort: null, code: cancelled ? 'AGENT_CANCELLED' : 'AGENT_FAILED', limitations: [message] });
          } finally {
            clearTimeout(deadline);
            activeAgents--;
          }
          return;
        }
        const result = await forward(request, controller.signal);
        send(result.status, { ...result, elapsedMs: Math.round(performance.now() - started),
          request: { method: request.method, path: request.path, ...(request.body ? { body: request.body } : {}),
            ...(request.key ? { key: request.key } : {}) } });
      } finally { active--; }
    } catch (error) {
      send(error.status ?? 503, { error: error.status ? error.message :
        'Cannot reach the Pi. Check its connection and SSH access. No automatic retry was made.' });
    } finally {
      res.removeListener('close', disconnected);
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const server = await startServer({ port: Number(process.env.FCPI_PLAYGROUND_PORT ?? 8767) });
  console.log(`Firecrawl Pi playground: http://localhost:${server.address().port}/LLM-DEMO.html`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
