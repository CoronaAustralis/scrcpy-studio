import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import https from 'node:https';
import { WebSocket } from 'ws';
import { certificateHosts, tlsOptions } from '../server/tls.mjs';

test('certificate host validation and explicit certificate settings', () => {
  assert.deepEqual(certificateHosts('192.168.1.20,screen.example.com,::1'), ['IP:192.168.1.20','DNS:screen.example.com','IP:::1']);
  for (const host of ['https://example.com','example.com:8787','host\nDNS:evil','*.example.com','-bad']) assert.throws(() => certificateHosts(host));
  assert.equal(tlsOptions({}), undefined);
  assert.throws(() => tlsOptions({ TLS_CERT:'missing' }), /一起/);
});

test('generated CA supports verified HTTPS and WSS, reuse, host changes and custom certificates', async t => {
  mkdirSync('artifacts', { recursive:true });
  const dir = mkdtempSync('artifacts/tls-test-');
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const env = { HTTPS:'true', TLS_DIR:dir, TLS_HOSTS:'localhost,127.0.0.1,192.168.1.20' };
  const options = tlsOptions(env), ca = readFileSync(`${dir}/ca.crt`);
  assert.ok(new X509Certificate(options.cert).checkIP('192.168.1.20'));
  assert.deepEqual(tlsOptions(env).cert, options.cert);
  assert.deepEqual(tlsOptions({ TLS_CERT:`${dir}/server.crt`, TLS_KEY:`${dir}/server.key` }).cert, options.cert);
  const port = 18789;
  const child = spawn(process.execPath, ['server/index.mjs'], { env:{ ...process.env, ...env, TLS_CERT:'', TLS_KEY:'', HOST:'127.0.0.1', PORT:String(port), STUDIO_PASSWORD:'' }, windowsHide:true, stdio:['ignore','pipe','pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  const [startup] = await Promise.race([once(child.stdout,'data'), exited.then(() => { throw new Error('TLS server exited'); })]);
  assert.match(startup.toString(), /https:/);
  const get = (pathname, authority = ca) => new Promise((resolve,reject) => {
    https.get({ hostname:'127.0.0.1', port, path:pathname, ca:authority }, res => {
      let body = ''; res.on('data', part => body += part); res.on('end', () => resolve({ status:res.statusCode, body }));
    }).on('error',reject);
  });
  assert.equal((await get('/')).status,200);
  await assert.rejects(get('/', []));
  const info = JSON.parse((await get('/api/info')).body);
  await new Promise((resolve,reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}/stream?token=${info.token}`, { ca, origin:`https://127.0.0.1:${port}` });
    socket.on('open', () => socket.close()); socket.on('close',resolve); socket.on('error',reject);
  });
  const changed = tlsOptions({ ...env, TLS_HOSTS:'localhost,127.0.0.1,192.168.1.21' });
  assert.ok(new X509Certificate(changed.cert).checkIP('192.168.1.21'));
  assert.deepEqual(readFileSync(`${dir}/ca.crt`),ca);
});
