import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../server/session.mjs';

function harness() {
  const sent = [], closed = [], controls = [];
  const ws = { readyState:1, bufferedAmount:0, send:value => sent.push(value), close:(...args) => closed.push(args) };
  const session = new Session(ws, 'test-device', {}, {});
  session.control = { destroyed:false, writableLength:0, write:value => controls.push(value) };
  return { session, ws, sent, closed, controls };
}
const config = { type:'packet', config:true, raw:Buffer.from('config') };
const delta = { type:'packet', key:false, raw:Buffer.from('delta') };
const key = { type:'packet', key:true, raw:Buffer.from('key') };

test('visibility does not pause video or invalidate the current GOP', () => {
  const h = harness(); h.session.onVideo(config); h.session.onVideo(key);
  h.session.window.ack(h.session.window.sequence);
  h.session.message({ type:'visibility', hidden:true }); h.session.onVideo(delta);
  h.session.message({ type:'visibility', hidden:false }); h.session.onVideo(delta);
  assert.equal(h.sent.filter(Buffer.isBuffer).length,4);
  assert.equal(h.session.window.waitingKey,false);
  assert.equal(h.session.window.dropped,0); assert.equal(h.closed.length,0);
});

test('backpressure drops dependants and recovers on a key frame without reconnecting', () => {
  const h = harness(); h.session.onVideo(config); h.session.onVideo(key);
  h.ws.bufferedAmount = 3 * 1024 * 1024; h.session.onVideo(delta);
  assert.equal(h.session.window.waitingKey,true);
  h.ws.bufferedAmount = 0; h.session.window.ack(h.session.window.sequence);
  h.session.onVideo(delta); assert.equal(h.session.window.dropped,2);
  h.session.message({ type:'key', code:3, action:0 }); assert.equal(h.controls.length,1);
  h.session.onVideo(key); assert.equal(h.session.window.waitingKey,false);
  assert.equal(h.sent.filter(Buffer.isBuffer).length,4); assert.equal(h.closed.length,0);
});

test('late final-frame ACK and visibility preserve a synchronized static screen', () => {
  const h = harness(); h.session.onVideo(config); h.session.onVideo(key);
  for (const id of h.session.window.pending.keys()) h.session.window.pending.set(id,0);
  h.session.message({ type:'visibility', hidden:true });
  h.session.message({ type:'ack', id:h.session.window.sequence });
  h.session.message({ type:'visibility', hidden:false });
  assert.equal(h.session.window.waitingKey,false);
  h.session.onVideo(delta);
  assert.equal(h.session.window.dropped,0); assert.equal(h.closed.length,0);
});
