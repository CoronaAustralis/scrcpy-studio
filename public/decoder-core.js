export function nalUnits(bytes) {
  const starts = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) {
      const length = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
      if (length) { starts.push({ start: i, payload: i + length }); i += length - 1; }
    }
  }
  return starts.map((p, i) => bytes.subarray(p.payload, starts[i + 1]?.start ?? bytes.length));
}
export function codecFromConfig(bytes) {
  const sps = nalUnits(bytes).find(nal => (nal[0] & 31) === 7);
  if (!sps || sps.length < 4) throw new Error('H.264 SPS 配置缺失');
  return `avc1.${[...sps.subarray(1, 4)].map(n => n.toString(16).padStart(2, '0')).join('')}`;
}
export function unpackPacket(buffer) {
  if (buffer.byteLength < 16) throw new Error('视频包过短');
  const view = new DataView(buffer), flags = view.getBigUint64(4);
  if (view.getUint32(12) !== buffer.byteLength - 16) throw new Error('视频包长度错误');
  return { id: view.getUint32(0), config: !!(flags & (1n << 62n)), key: !!(flags & (1n << 61n)),
    timestamp: Number(flags & ((1n << 61n) - 1n)), data: new Uint8Array(buffer, 16) };
}
export function joinBytes(a, b) { const result = new Uint8Array(a.length + b.length); result.set(a); result.set(b, a.length); return result; }

export class LatestFrame {
  frame = null;
  replace(frame) { const replaced = !!this.frame; this.frame?.close(); this.frame = frame; return replaced; }
  take() { const frame = this.frame; this.frame = null; return frame; }
  clear() { this.frame?.close(); this.frame = null; }
}
