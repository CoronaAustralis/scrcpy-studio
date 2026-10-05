import test from 'node:test';
import assert from 'node:assert/strict';
import { endpoint, validateAdbAction, performAdbAction } from '../server/adb-management.mjs';
import { createAccessPolicy } from '../server/access.mjs';

test('ADB endpoint validation and action allowlist', () => {
  assert.equal(endpoint('192.168.1.20'), '192.168.1.20:5555');
  assert.equal(endpoint('[::1]:1234'), '[::1]:1234');
  assert.equal(endpoint('adb-test._adb-tls-connect._tcp', { disconnect:true }), 'adb-test._adb-tls-connect._tcp');
  for (const value of ['-s', 'host;whoami', 'http://host', 'host:0', 'host:65536', '[bad]:5555', 'host\nother']) assert.throws(() => endpoint(value));
  assert.throws(() => endpoint('host', { requirePort:true }));
  assert.throws(() => validateAdbAction({ action:'shell', target:'reboot' }));
  assert.throws(() => validateAdbAction({ action:'pair', target:'host:1234', code:'123' }));
});
test('pairing uses stdin and hides codes in both success and error output', async () => {
  const request = { action:'pair', target:'host:1234', code:'123456' };
  const result = await performAdbAction(request, { run:async (args, options) => {
    assert.deepEqual(args, ['pair', 'host:1234']); assert.equal(options.input, '123456\n'); return 'Paired 123456';
  } });
  assert.doesNotMatch(result.message, /123456/);
  await assert.rejects(performAdbAction(request, { run:async () => { throw new Error('failed 123456'); } }), error => !error.message.includes('123456'));
});
test('restart and disconnect stop matching sessions before changing ADB', async () => {
  for (const [input, expected] of [
    [{ action:'restart' }, ['stop:all', 'kill-server', 'start-server']],
    [{ action:'disconnect-all' }, ['stop:network', 'disconnect']],
    [{ action:'disconnect', target:'host' }, ['stop:host:5555', 'disconnect host:5555']],
  ]) {
    const calls = [];
    await performAdbAction(input, { stopSessions:async selector => calls.push(`stop:${selector}`), run:async args => { calls.push(args.join(' ')); return ''; } });
    assert.deepEqual(calls, expected);
  }
  await assert.rejects(performAdbAction({ action:'connect', target:'host' }, { run:async () => 'failed to connect' }), /failed/);
});
test('access policy accepts LAN and domain authorities while rejecting cross-origin requests', () => {
  const policy = createAccessPolicy({ password:'secret' });
  const allows = headers => policy.allows({ headers });
  assert.ok(allows({ host:'localhost:9000', origin:'http://localhost:9000' }));
  assert.ok(allows({ host:'screen.example.com', origin:'https://screen.example.com' }));
  assert.ok(allows({ host:'screen.example.com', origin:'http://screen.example.com' }));
  assert.ok(allows({ host:'192.168.1.20:8787', origin:'http://192.168.1.20:8787' }));
  assert.ok(allows({ host:'192.168.1.20:7000', origin:'https://192.168.1.20:7000' }));
  assert.ok(allows({ host:'[::1]:9000', origin:'http://[::1]:9000' }));
  assert.ok(allows({ host:'screen.example.com' }));
  assert.ok(!allows({ host:'screen.example.com', origin:'https://evil.example.com' }));
  assert.ok(!allows({ host:'screen.example.com:9000', origin:'https://screen.example.com' }));
  for (const host of ['bad/host', 'user@host', 'host,other', 'host:99999', '']) assert.ok(!allows({ host }));
  for (const origin of ['null', 'file://screen.example.com', 'https://screen.example.com/path']) assert.ok(!allows({ host:'screen.example.com', origin }));
  assert.ok(!allows({ host:'localhost:8787', 'sec-fetch-site':'cross-site' }));
  assert.ok(!policy.authenticated({ headers:{} }));
  assert.ok(policy.authenticated({ headers:{ authorization:`Basic ${Buffer.from('admin:secret').toString('base64')}` } }));
  assert.ok(!policy.authenticated({ headers:{ authorization:`Basic ${Buffer.from('admin:wrong').toString('base64')}` } }));
  assert.ok(createAccessPolicy().authenticated({ headers:{} }));
  assert.ok(createAccessPolicy({ password:'' }).authenticated({ headers:{} }));
});
