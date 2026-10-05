import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { setImmediate as tick } from 'node:timers/promises';
import * as core from '../public/decoder-core.js';

const source = readFileSync(new URL('../public/decoder-worker.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
function harness() {
  const reports = [], sent = [], decoders = [], renders = [], scheduled = [], sockets = [];
  let now = 2000;
  class Decoder {
    static async isConfigSupported(config) { return { supported: true, config }; }
    state = 'unconfigured'; decodeQueueSize = 0; chunks = []; resets = 0;
    constructor(callbacks) { this.callbacks = callbacks; decoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { this.chunks.push(chunk); }
    reset() { this.resets++; this.decodeQueueSize = 0; this.state = 'unconfigured'; }
    close() { this.state = 'closed'; }
  }
  class Socket {
    static OPEN = 1; readyState = 1;
    constructor() { sockets.push(this); }
    send(value) { sent.push(JSON.parse(value)); } close() { this.readyState = 3; }
  }
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: frame => renders.push(frame) }) };
  const context = vm.createContext({ ...core, VideoDecoder: Decoder, WebSocket: Socket, EncodedVideoChunk: class { constructor(v) { Object.assign(this, v); } },
    performance: { now: () => now }, postMessage: m => reports.push(m), setInterval: () => {}, requestAnimationFrame: fn => { scheduled.push(fn); return scheduled.length; },
    cancelAnimationFrame: id => { scheduled[id - 1] = () => {}; }, setTimeout: fn => { scheduled.push(fn); return scheduled.length; }, clearTimeout: id => { scheduled[id - 1] = () => {}; }, onmessage: null });
  vm.runInContext(source, context);
  context.onmessage({ data: { type: 'init', canvas, url: 'ws://test', mode: 'prefer-hardware', settings: {} } });
  let seq = 0;
  function packet({ config = false, key = false, timestamp = 1000, data = [0, 0, 0, 1, 0x41] } = {}) {
    const b = new ArrayBuffer(16 + data.length), v = new DataView(b); v.setUint32(0, ++seq);
    v.setBigUint64(4, config ? 1n << 62n : BigInt(timestamp) | (key ? 1n << 61n : 0n)); v.setUint32(12, data.length); new Uint8Array(b, 16).set(data);
    sockets[0].onmessage({ data: b });
  }
  const configure = () => packet({ config: true, data: [0, 0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 1, 0x68, 1] });
  return { context, reports, sent, decoders, renders, scheduled, packet, configure, sockets, advance: ms => now += ms };
}
test('worker preserves key/delta identity and timestamp while preferring hardware', async () => {
  const h = harness(); h.configure(); await tick();
  h.packet({ key: true, timestamp: 123456, data: [0, 0, 0, 1, 0x65] }); h.packet({ timestamp: 140122 });
  const d = h.decoders.at(-1);
  assert.equal(d.config.hardwareAcceleration, 'prefer-hardware'); assert.equal(d.config.optimizeForLatency, true);
  assert.deepEqual(d.chunks.map(c => [c.type, c.timestamp]), [['key', 123456], ['delta', 140122]]);
  assert.equal(d.chunks[0].data.length, 18); assert.equal(d.chunks[1].data.length, 5);
});
test('sustained decoder overload discards dependants until a new key frame', async () => {
  const h = harness(); h.configure(); await tick(); const d = h.decoders.at(-1);
  h.packet({ key: true }); d.decodeQueueSize = 12; h.advance(300); h.packet({ timestamp: 2000 });
  assert.equal(d.resets, 1); h.packet({ timestamp: 3000 }); assert.equal(d.chunks.length, 1);
  h.packet({ key: true, timestamp: 4000 }); assert.equal(d.chunks.length, 2); assert.equal(d.chunks[1].type, 'key');
  assert(h.sent.some(m => m.type === 'resync'));
});

test('configuration retains key frame AND following deltas while support probe is pending', async () => {
  const h = harness(); h.configure();
  h.packet({ key: true, timestamp: 1000 }); h.packet({ timestamp: 2000 }); h.packet({ timestamp: 3000 });
  await tick();
  assert.deepEqual(h.decoders.at(-1).chunks.map(c => c.timestamp), [1000, 2000, 3000]);
  assert.equal(h.sent.filter(m => m.type === 'resync').length, 0);
});
test('normal TCP burst of eight frames must not reset a healthy decoder', async () => {
  const h = harness(); h.configure(); await tick(); const d = h.decoders.at(-1);
  for (let i = 0; i < 8; i++) { d.decodeQueueSize = i; h.packet({ key: i === 0, timestamp: 1000 + i * 16667 }); }
  assert.equal(d.resets, 0); assert.equal(d.chunks.length, 8);
});
test('delayed RAF is not treated as stalled video decoding', async () => {
  const h = harness(); h.configure(); await tick(); const d = h.decoders.at(-1);
  h.packet({ key: true, timestamp: 1000 });
  d.callbacks.output({ timestamp: 1000, displayWidth: 1080, displayHeight: 1920, close() {} });
  h.advance(1000); h.packet({ timestamp: 2000 });
  assert.equal(d.resets, 0); assert.equal(d.chunks.length, 2);
});
test('duplicate visible notifications do not reset the active stream', async () => {
  const h = harness(); h.configure(); await tick(); const d = h.decoders.at(-1);
  h.packet({ key: true }); h.context.onmessage({ data: { type: 'visibility', hidden: false } });
  h.packet({ timestamp: 2000 }); assert.equal(d.resets, 0); assert.equal(d.chunks.length, 2);
});
test('worker closes superseded frames, renders newest only and releases on stop', async () => {
  const h = harness(); h.configure(); await tick(); const d = h.decoders.at(-1), closed = [];
  const frame = timestamp => ({ timestamp, displayWidth: 1080, displayHeight: 1920, close: () => closed.push(timestamp) });
  d.callbacks.output(frame(1)); d.callbacks.output(frame(2)); assert.deepEqual(closed, [1]);
  assert.equal(h.scheduled.length, 2); h.scheduled[0](); assert.equal(h.renders[0].timestamp, 2); assert.deepEqual(closed, [1, 2]);
  d.callbacks.output(frame(3)); h.context.onmessage({ data: { type: 'stop' } });
  assert.equal(d.state, 'closed'); assert.deepEqual(closed, [1, 2, 3]);
});
test('visibility resume requests a clean key frame and does not replay hidden frames', async () => {
  const h = harness(); h.configure(); await tick(); const d = h.decoders.at(-1);
  h.context.onmessage({ data: { type: 'visibility', hidden: true } }); h.packet({ key: true }); assert.equal(d.chunks.length, 0);
  h.context.onmessage({ data: { type: 'visibility', hidden: false } }); h.packet({ timestamp: 3000 }); assert.equal(d.chunks.length, 0);
  h.packet({ key: true, timestamp: 4000 }); assert.equal(d.chunks.length, 1);
});
test('stale async configure cannot resurrect a closed decoder', async () => {
  const h = harness(); h.configure(); h.context.onmessage({ data: { type: 'stop' } }); await tick();
  assert.equal(h.decoders.length, 0);
});

test('resync reuses support result without losing the next burst to another async probe', async () => {
  const h = harness(); h.configure(); await tick();
  h.sockets[0].onmessage({ data: JSON.stringify({ type: 'resync' }) });
  h.configure(); h.packet({ key: true, timestamp: 1000 }); h.packet({ timestamp: 2000 });
  assert.deepEqual(h.decoders.at(-1).chunks.map(c => c.timestamp), [1000, 2000]);
});
test('a cancelled RAF during stream replacement cannot block all subsequent renders', async () => {
  const h = harness(); h.configure(); await tick(); const closed = [];
  const frame = timestamp => ({ timestamp, displayWidth: 1080, displayHeight: 1920, close: () => closed.push(timestamp) });
  h.decoders.at(-1).callbacks.output(frame(1));
  h.sockets[0].onmessage({ data: JSON.stringify({ type: 'resync' }) }); h.configure();
  h.decoders.at(-1).callbacks.output(frame(2));
  h.scheduled.at(-1)();
  assert.equal(h.renders.at(-1).timestamp, 2); assert.deepEqual(closed, [1, 2]);
});
test('two minutes of decoded frames with intermittent late presentation do not cause resync', async () => {
  const h = harness(); h.configure(); await tick(); const d = h.decoders.at(-1);
  for (let i = 0; i < 7200; i++) {
    const timestamp = i * 16667;
    h.packet({ key: i % 60 === 0, timestamp });
    d.callbacks.output({ timestamp, displayWidth: 1080, displayHeight: 1920, close() {} });
    h.advance(17);
    if (i % 12 === 0) h.scheduled.at(-1)();
  }
  assert.equal(d.resets, 0); assert.equal(d.chunks.length, 7200);
});
