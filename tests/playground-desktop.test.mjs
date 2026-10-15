import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import http from 'node:http';

const root = fileURLToPath(new URL('../', import.meta.url));

test('packaged runtime starts independently and closes sockets on parent EOF', { timeout: 15000 }, async t => {
  const isolated = await mkdtemp(join(tmpdir(), 'fcpi-desktop-'));
  t.after(() => rm(isolated, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(resolve(root, 'desktop/src-tauri/tauri.conf.json')));
  for (const [source, destination] of Object.entries(config.bundle.resources)) {
    const target = resolve(isolated, destination);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(root, 'desktop/src-tauri', source), target);
  }
  const child = spawn(process.execPath, [join(isolated, 'runtime/scripts/playground/desktop-server.mjs')], {
    cwd: isolated, stdio: ['pipe', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, 'line');
  const { url } = JSON.parse(line);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/LLM-DEMO\.html$/);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /window-controls/);
  assert.equal((await fetch(new URL('/scripts/m1/pi-target.conf', url))).status, 404);
  assert.equal((await fetch(url, { headers: { Origin: 'https://example.com' } })).status, 403);
  // Hold a partially sent request open: parent exit must not wait for its body timeout.
  const pending = http.request(new URL('/api/run', url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '100' }
  });
  pending.on('error', () => {});
  pending.flushHeaders();
  pending.write('{');
  child.stdin.end();
  const [code] = await exited;
  pending.destroy();
  assert.equal(code, 0, errors);
  await assert.rejects(fetch(url));
});

test('desktop runtime handles an explicit termination signal', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, [resolve(root, 'scripts/playground/desktop-server.mjs')], {
    cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const lines = createInterface({ input: child.stdout });
  const [line] = await once(lines, 'line');
  const { url } = JSON.parse(line);
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  await assert.rejects(fetch(url));
});
