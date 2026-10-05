import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoParser, CONFIG, KEY, encodeControl, settingsFrom, DeliveryWindow } from '../server/protocol.mjs';
import { codecFromConfig, unpackPacket, LatestFrame } from '../public/decoder-core.js';

function packet(flags, payload) { const h = Buffer.alloc(12); h.writeBigUInt64BE(flags); h.writeUInt32BE(payload.length, 8); return Buffer.concat([h, payload]); }
function fixture() {
  const hello = Buffer.alloc(69); hello.write('Pixel test', 1); hello.write('h264', 65);
  const session = Buffer.alloc(12); session[0] = 0x80; session.writeUInt32BE(864, 4); session.writeUInt32BE(1920, 8);
  const config = packet(CONFIG, Buffer.from([0, 0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 1, 0x68, 0xff]));
  return Buffer.concat([hello, session, config, packet(KEY | 123456789n, Buffer.from([0, 0, 0, 1, 0x65, 42])), packet(123473456n, Buffer.from([0, 0, 1, 0x41, 11])), session]);
}
test('4.1 wire parser survives arbitrary TCP fragmentation, coalescing and rotation', () => {
  for (const size of [1, 2, 7, 12, 64, 69, 1000]) {
    const events = [], parser = new VideoParser(e => events.push(e)), wire = fixture();
    for (let i = 0; i < wire.length; i += size) parser.push(wire.subarray(i, i + size));
    assert.deepEqual(events.map(e => e.type), ['device', 'size', 'packet', 'packet', 'packet', 'size']);
    assert.equal(events[0].name, 'Pixel test'); assert.equal(events[1].height, 1920);
    assert.equal(events[2].config, true); assert.equal(events[3].key, true); assert.equal(events[4].key, false);
    assert.equal(parser.buffer.length, 0);
  }
});
test('browser packet retains microsecond PTS, config flags and true delta frame identity', () => {
  const events = []; new VideoParser(e => events.push(e)).push(fixture());
  for (const [index, expected] of [[2, [true, false, 0]], [3, [false, true, 123456789]], [4, [false, false, 123473456]]]) {
    const seq = Buffer.alloc(4); seq.writeUInt32BE(99);
    const wire = Uint8Array.from(Buffer.concat([seq, events[index].raw])).buffer;
    const result = unpackPacket(wire);
    assert.deepEqual([result.config, result.key, result.timestamp], expected); assert.equal(result.id, 99);
  }
  assert.equal(codecFromConfig(events[2].raw.subarray(12)), 'avc1.640028');
});
test('malformed stream lengths and codecs are rejected before allocation', () => {
  const b = fixture(); b.write('av01', 65); assert.throws(() => new VideoParser(() => {}).push(b), /Expected h264/);
  const bad = fixture().subarray(0, 93); bad.writeUInt32BE(0xffffffff, 89);
  assert.throws(() => new VideoParser(() => {}).push(bad), /length/);
  assert.throws(() => unpackPacket(new ArrayBuffer(10)), /过短/);
});
test('touch wire format matches official ControlMessageReader', () => {
  const b = encodeControl({ type: 'touch', action: 0, pointerId: 7, x: 250, y: 1000, width: 864, height: 1920 });
  assert.equal(b.length, 32); assert.equal(b[0], 2); assert.equal(b.readBigUInt64BE(2), 7n);
  assert.equal(b.readUInt32BE(10), 250); assert.equal(b.readUInt32BE(14), 1000);
  assert.equal(b.readUInt16BE(18), 864); assert.equal(b.readUInt16BE(20), 1920);
  assert.equal(b.readUInt16BE(22), 65535); assert.equal(b.readUInt32BE(24), 0);
  assert.throws(() => encodeControl({ type: 'touch', action: 0, x: -1, y: 0, width: 10, height: 10 }), /Invalid/);
});
test('scroll, key and Unicode clipboard records have correct byte lengths', () => {
  const b = encodeControl({ type: 'scroll', x: 5, y: 5, width: 10, height: 20, dx: -1, dy: 1 });
  assert.equal(b.length, 21); assert.equal(b.readInt16BE(13), -2048); assert.equal(b.readInt16BE(15), 2048);
  const key = encodeControl({ type: 'key', code: 66, action: 1 }); assert.equal(key.length, 14); assert.equal(key[1], 1); assert.equal(key.readUInt32BE(2), 66);
  const text = '你好 Android 👋'; const paste = encodeControl({ type: 'paste', text });
  assert.equal(paste[9], 1); assert.equal(paste.readUInt32BE(10), Buffer.byteLength(text)); assert.equal(paste.subarray(14).toString(), text);
});
test('settings validation rejects NaN, strings with commands and out-of-range numbers', () => {
  assert.deepEqual(settingsFrom(), { maxSize: 1920, bitrate: 8, fps: 60 });
  for (const value of [NaN, 0, -1, Infinity, '8;reboot']) assert.throws(() => settingsFrom({ bitrate: value }));
  assert.equal(settingsFrom({ maxSize: 0 }).maxSize, 0);
});
test('delivery window recovers on count, age and bytes without stale ACK corruption', () => {
  const w = new DeliveryWindow({ maxPending: 3, maxAge: 100, maxBytes: 50 });
  w.track(0); assert.equal(w.congested(0, 99), false); assert.equal(w.congested(0, 101), true);
  w.track(10); w.track(20); assert.equal(w.congested(0, 50), true);
  w.ack(2); assert.equal(w.pending.size, 1); assert.equal(w.congested(0, 50), false);
  w.ack(1); assert.equal(w.pending.size, 1); assert.equal(w.congested(51, 50), true);
});
test('latest-frame mailbox disposes old GPU surfaces and displays only the newest', () => {
  const closed = [], box = new LatestFrame();
  const a = { close: () => closed.push('a') }, b = { close: () => closed.push('b') }, c = { close: () => closed.push('c') };
  assert.equal(box.replace(a), false); assert.equal(box.replace(b), true); assert.deepEqual(closed, ['a']);
  assert.equal(box.take(), b); assert.equal(box.take(), null); b.close(); box.replace(c); box.clear(); assert.deepEqual(closed, ['a', 'b', 'c']);
});

test('default delivery budget tolerates a normal frame burst while retaining age protection', () => {
  const w = new DeliveryWindow();
  for (let i = 0; i < 24; i++) w.track(1000);
  assert.equal(w.congested(0, 1020), false);
  assert.equal(w.congested(0, 1300), true);
});
