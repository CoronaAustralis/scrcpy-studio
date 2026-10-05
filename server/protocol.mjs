export const MAX_PACKET = 16 * 1024 * 1024;
export const CONFIG = 1n << 62n;
export const KEY = 1n << 61n;
export const PTS_MASK = KEY - 1n;

// Official scrcpy 4.1: dummy byte, device name, codec, then session/packet records.
export class VideoParser {
  buffer = Buffer.alloc(0);
  stage = 'hello';
  constructor(emit) { this.emit = emit; }
  push(data) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    while (true) {
      if (this.stage === 'hello') {
        if (this.buffer.length < 69) return;
        if (this.buffer[0] !== 0) throw new Error('Invalid scrcpy handshake');
        const name = this.buffer.subarray(1, 65).toString('utf8').split('\0')[0];
        const codec = this.buffer.subarray(65, 69).toString('ascii');
        if (codec !== 'h264') throw new Error(`Expected h264, received ${JSON.stringify(codec)}`);
        this.buffer = this.buffer.subarray(69);
        this.stage = 'packets';
        this.emit({ type: 'device', name, codec });
      }
      if (this.buffer.length < 12) return;
      if (this.buffer[0] & 0x80) {
        const width = this.buffer.readUInt32BE(4), height = this.buffer.readUInt32BE(8);
        if (!width || !height || width > 16384 || height > 16384) throw new Error('Invalid session dimensions');
        this.buffer = this.buffer.subarray(12);
        this.emit({ type: 'size', width, height });
        continue;
      }
      const length = this.buffer.readUInt32BE(8);
      if (length < 1 || length > MAX_PACKET) throw new Error('Invalid video packet length');
      if (this.buffer.length < 12 + length) return;
      const raw = this.buffer.subarray(0, 12 + length);
      const flags = raw.readBigUInt64BE(0);
      this.buffer = this.buffer.subarray(12 + length);
      this.emit({ type: 'packet', raw, config: !!(flags & CONFIG), key: !!(flags & KEY) });
    }
  }
}

const integer = (n, min, max) => {
  if (!Number.isInteger(n) || n < min || n > max) throw new Error('Invalid control value');
  return n;
};
export function settingsFrom(input = {}) {
  return {
    maxSize: integer(Number(input.maxSize ?? 1920), 0, 4096),
    bitrate: integer(Number(input.bitrate ?? 8), 1, 80),
    fps: integer(Number(input.fps ?? 60), 15, 120),
  };
}
function position(b, offset, msg) {
  const w = integer(msg.width, 1, 16384), h = integer(msg.height, 1, 16384);
  b.writeUInt32BE(integer(msg.x, 0, w - 1), offset);
  b.writeUInt32BE(integer(msg.y, 0, h - 1), offset + 4);
  b.writeUInt16BE(w, offset + 8); b.writeUInt16BE(h, offset + 10);
}
export function encodeControl(msg) {
  if (msg.type === 'key') {
    const b = Buffer.alloc(14); b[0] = 0; b[1] = integer(msg.action, 0, 1);
    b.writeUInt32BE(integer(msg.code, 0, 400), 2); return b;
  }
  if (msg.type === 'touch') {
    const b = Buffer.alloc(32); b[0] = 2; b[1] = integer(msg.action, 0, 2);
    b.writeBigUInt64BE(BigInt(integer(msg.pointerId ?? 0, 0, 65535)), 2);
    position(b, 10, msg); b.writeUInt16BE(msg.action === 1 ? 0 : 65535, 22);
    // A real touch pointer (not scrcpy's reserved mouse pointer) has no mouse buttons.
    return b;
  }
  if (msg.type === 'scroll') {
    const b = Buffer.alloc(21); b[0] = 3; position(b, 1, msg);
    for (const [key, off] of [['dx', 13], ['dy', 15]]) {
      if (!Number.isFinite(msg[key])) throw new Error('Invalid scroll');
      b.writeInt16BE(Math.round(Math.max(-16, Math.min(15.99, msg[key])) * 2048), off);
    }
    return b;
  }
  if (msg.type === 'text') {
    if (typeof msg.text !== 'string' || Buffer.byteLength(msg.text) > 300) throw new Error('Text too long');
    const text = Buffer.from(msg.text), b = Buffer.alloc(5 + text.length);
    b[0] = 1; b.writeUInt32BE(text.length, 1); text.copy(b, 5); return b;
  }
  if (msg.type === 'paste') {
    if (typeof msg.text !== 'string' || Buffer.byteLength(msg.text) > 65536) throw new Error('Text too long');
    const text = Buffer.from(msg.text), b = Buffer.alloc(14 + text.length);
    b[0] = 9; b[9] = 1; b.writeUInt32BE(text.length, 10); text.copy(b, 14); return b;
  }
  if (msg.type === 'rotate') return Buffer.from([11]);
  if (msg.type === 'reset') return Buffer.from([17]);
  throw new Error('Unsupported control message');
}

// Bound browser delivery independently of the TCP send buffer. Never discard arbitrary
// delta frames and then continue decoding their dependants: recover at a fresh IDR.
export class DeliveryWindow {
  pending = new Map();
  sequence = 0;
  waitingKey = true;
  dropped = 0;
  constructor({ maxPending = 64, maxAge = 250, maxBytes = 2 * 1024 * 1024 } = {}) {
    Object.assign(this, { maxPending, maxAge, maxBytes });
  }
  ack(id) { for (const key of this.pending.keys()) if (key <= id) this.pending.delete(key); }
  congested(buffered, now = Date.now()) {
    const oldest = this.pending.values().next().value;
    return buffered > this.maxBytes || this.pending.size >= this.maxPending || (oldest !== undefined && now - oldest > this.maxAge);
  }
  track(now = Date.now()) { const id = ++this.sequence; this.pending.set(id, now); return id; }
}
