import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import http from 'node:http';

test('local server serves UI and refuses cross-origin control or missing tokens', async t => {
  const port = 18787, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Test server exited'); })]);
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /Scrcpy Studio/);
  assert.equal((await fetch(`${base}/api/devices`)).status, 403);
  assert.equal((await fetch(`${base}/api/info`, { headers: { Origin: 'https://example.com' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/info`, { headers: { Host: 'attacker.test' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.equal((await fetch(`${base}/server/index.mjs`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/adb`, { method:'POST' })).status, 403);
  const { token } = await (await fetch(`${base}/api/info`)).json();
  const headers = { 'X-Session-Token':token, 'Content-Type':'application/json' };
  assert.equal((await fetch(`${base}/api/adb`, { method:'POST', headers, body:JSON.stringify({ action:'shell' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/adb`, { method:'POST', headers, body:JSON.stringify({ action:'connect', target:'-s' }) })).status, 400);
  assert.equal((await fetch(`${base}/api/adb`, { method:'POST', headers, body:'{}'+' '.repeat(4096) })).status, 400);
  assert.equal((await fetch(`${base}/api/adb`, { method:'POST', headers:{ 'X-Session-Token':token }, body:'{}' })).status, 415);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/stream?token=bad`);
    socket.on('open', () => { socket.close(); reject(new Error('Invalid token accepted')); });
    socket.on('unexpected-response', (_req, res) => { try { assert.equal(res.statusCode, 403); res.resume(); resolve(); } catch (error) { reject(error); } });
    socket.on('error', () => {});
  });
});
