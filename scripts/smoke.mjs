// Opt-in, real-device transport test. Close browser streams before running.
// Alternates Home/Recents to provide changing frames, then returns Home.
import { WebSocket } from 'ws';
import assert from 'node:assert/strict';
const base = process.env.STUDIO_URL || 'http://127.0.0.1:8787';
const { token } = await (await fetch(`${base}/api/info`)).json();
const { devices } = await (await fetch(`${base}/api/devices`, { headers: { 'X-Session-Token': token } })).json();
const device = devices.find(d => d.state === 'device' && (!process.env.DEVICE_SERIAL || d.serial === process.env.DEVICE_SERIAL));
if (!device) throw new Error('No authorized device available');
let frames = 0, keys = 0, configs = 0, lastId = 0, stalled = false, resumed = false, dropped = 0, size, animation;
const socket = new WebSocket(`${base.replace('http:', 'ws:')}/stream?token=${token}`, { origin: base });
const timers = [];
try {
  await new Promise((resolve, reject) => {
    timers.push(setTimeout(() => reject(new Error(`Device smoke test timed out: ${JSON.stringify({ frames, keys, configs, dropped, stalled, resumed, size })}`)), 25000));
    socket.on('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'start', serial: device.serial, settings: { maxSize: 1920, bitrate: 8, fps: 60 } })));
    socket.on('message', (raw, binary) => {
      try {
        if (!binary) {
          const event = JSON.parse(raw);
          if (event.type === 'error') throw new Error(event.message);
          if (event.type === 'size') size = `${event.width}x${event.height}`;
          if (event.type === 'connected' && !animation) {
            let recent = true;
            animation = setInterval(() => {
              const code = recent ? 187 : 3; recent = !recent;
              for (const action of [0, 1]) socket.send(JSON.stringify({ type: 'key', code, action }));
            }, 450);
          }
          if (event.type === 'transport') dropped = event.dropped;
          if (process.env.DEBUG_SMOKE) console.log(event);
          return;
        }
        const id = raw.readUInt32BE(0), flags = raw.readBigUInt64BE(4);
        assert(id > lastId); lastId = id;
        assert.equal(raw.readUInt32BE(12), raw.length - 16);
        if (flags & (1n << 62n)) configs++; else frames++;
        if (flags & (1n << 61n)) keys++;
        if (!stalled || resumed) socket.send(JSON.stringify({ type: 'ack', id }));
        if (frames >= 10 && !stalled) {
          stalled = true;
          timers.push(setTimeout(() => { resumed = true; socket.send(JSON.stringify({ type: 'ack', id: lastId })); }, 1800));
        }
        if (resumed && configs >= 2 && keys >= 2 && frames >= 22 && dropped > 0) resolve();
      } catch (error) { reject(error); }
    });
    socket.on('close', () => reject(new Error('Socket closed before recovery completed')));
  });
  console.log(JSON.stringify({ device: device.model, size, frames, keys, configs, transportDropped: dropped, backpressureRecovery: 'PASS' }, null, 2));
} finally {
  timers.forEach(clearTimeout); clearInterval(animation);
  if (socket.readyState === WebSocket.OPEN) for (const action of [0, 1]) socket.send(JSON.stringify({ type: 'key', code: 3, action }));
  socket.close();
}
