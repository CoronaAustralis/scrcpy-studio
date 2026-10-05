import { unpackPacket, codecFromConfig, joinBytes, LatestFrame } from './decoder-core.js';

let canvas, context, socket, decoder, configBytes, decoderConfig, mode = 'prefer-hardware';
let generation = 0, waitingKey = true, configuring = false, suspended = false;
let renderRaf, renderTimer, pendingPackets = [], pendingBytes = 0;
let resets = 0, hiddenDrops = 0, lastRecovery = '无';
const supportedConfigs = new Map(), receivedAtByFrame = new WeakMap();
let received = 0, rendered = 0, dropped = 0, bytes = 0, lastStats = performance.now(), lastResync = 0;
let lastDrawMs = 0, maxDrawMs = 0, decoderPreference = '等待视频';
let desiredWidth = 0, desiredHeight = 0;
let firstFrameReported = false;
const latest = new LatestFrame(), submitted = new Map();
const report = message => postMessage(message);
const send = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
function cancelDraw() {
  if (renderRaf !== undefined) cancelAnimationFrame(renderRaf);
  if (renderTimer !== undefined) clearTimeout(renderTimer);
  renderRaf = renderTimer = undefined;
}
function clearPending() { pendingPackets = []; pendingBytes = 0; }
function releaseDecoder() {
  generation++; configuring = false; cancelDraw(); latest.clear(); submitted.clear(); clearPending();
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = null; waitingKey = true;
}
function resync(reason = '请求关键帧') {
  resets++; lastRecovery = reason;
  waitingKey = true;
  if (decoder?.state === 'configured') { decoder.reset(); decoder.configure(decoderConfig); }
  submitted.clear(); cancelDraw(); latest.clear(); clearPending();
  if (performance.now() - lastResync > 500) { lastResync = performance.now(); send({ type: 'resync' }); }
}
async function configure(data, fallback = false) {
  releaseDecoder(); configBytes = data.slice(); const current = generation; configuring = true;
  try {
    const codec = codecFromConfig(data);
    const base = { codec, optimizeForLatency: true };
    let config = { ...base, hardwareAcceleration: fallback ? 'no-preference' : mode };
    const cacheKey = `${codec}:${config.hardwareAcceleration}`;
    if (supportedConfigs.has(cacheKey)) config = supportedConfigs.get(cacheKey);
    else {
      let support = await VideoDecoder.isConfigSupported(config);
      if (!support.supported && mode === 'prefer-hardware') {
        config = { ...base, hardwareAcceleration: 'no-preference' };
        support = await VideoDecoder.isConfigSupported(config);
      }
      if (!support.supported) throw new Error(`浏览器不支持此 H.264 配置 (${codec})，尝试自动解码或较低分辨率`);
      if (supportedConfigs.size >= 16) supportedConfigs.clear();
      supportedConfigs.set(cacheKey, config);
    }
    if (current !== generation) return;
    decoderConfig = config;
    decoderPreference = config.hardwareAcceleration;
    decoder = new VideoDecoder({
      output: frame => {
        if (current !== generation) { frame.close(); return; }
        // Decode completion and presentation are separate queues. A delayed RAF
        // must never make an already decoded frame look like a stuck decoder.
        receivedAtByFrame.set(frame, submitted.get(frame.timestamp));
        submitted.delete(frame.timestamp);
        if (suspended) { frame.close(); return; }
        if (latest.replace(frame)) { dropped++; }
        if (renderRaf === undefined && renderTimer === undefined) scheduleDraw();
      },
      error: error => {
        if (current !== generation) return;
        if (config.hardwareAcceleration === 'prefer-hardware') {
          mode = 'no-preference';
          report({ type: 'notice', message: '硬件优先解码初始化失败，正在尝试自动解码' });
          void configure(configBytes, true).then(() => send({ type: 'resync' }));
        } else report({ type: 'error', message: `解码失败：${error.message}` });
      },
    });
    decoder.configure(config); configuring = false;
    report({ type: 'decoder', preference: decoderPreference, codec });
    // Preserve the whole bounded GOP during the asynchronous support probe.
    // Clearing its key frame on the next delta caused an endless resync loop.
    const pending = pendingPackets; clearPending();
    for (const packet of pending) decodePacket(packet);
    // The server sends config immediately before a key frame. Do not ask it to
    // start over just because that frame has not reached this event loop yet.
  } catch (error) {
    if (current === generation) { configuring = false; report({ type: 'error', message: error.message }); }
  }
}
function decodePacket(packet) {
  if (suspended) { hiddenDrops++; return; }
  if (configuring) {
    if (packet.key) clearPending();
    if (!packet.key && !pendingPackets.length) { dropped++; return; }
    pendingPackets.push(packet); pendingBytes += packet.data.byteLength;
    if (pendingPackets.length > 32 || pendingBytes > 4 * 1024 * 1024) {
      dropped += pendingPackets.length; clearPending();
      send({ type: 'resync' });
    }
    return;
  }
  if (!decoder || decoder.state !== 'configured') { dropped++; return; }
  if (waitingKey && !packet.key) { dropped++; return; }
  const oldest = submitted.values().next().value;
  const stalled = oldest !== undefined && performance.now() - oldest > 250;
  // TCP regularly delivers several frames together. Queue depth alone is not
  // evidence of sustained lag; allow bursts, but keep a hard resource ceiling.
  if ((stalled && (decoder.decodeQueueSize >= 12 || submitted.size >= 12)) || decoder.decodeQueueSize >= 48 || submitted.size >= 48) {
    resync('解码持续积压');
    if (!packet.key) { dropped++; return; }
  }
  let data = packet.data;
  if (packet.key) { data = joinBytes(configBytes, data); waitingKey = false; }
  submitted.set(packet.timestamp, packet.receivedAt ?? performance.now());
  try { decoder.decode(new EncodedVideoChunk({ type: packet.key ? 'key' : 'delta', timestamp: packet.timestamp, data })); }
  catch { dropped++; resync('解码提交失败'); }
}
function scheduleDraw() {
  if (typeof requestAnimationFrame === 'function') renderRaf = requestAnimationFrame(draw);
  // Worker RAF may stop during a visibility/compositor transition. The fallback
  // presents the newest frame, rather than retaining a permanently pending RAF.
  renderTimer = setTimeout(draw, renderRaf === undefined ? 0 : 32);
}
function draw() {
  cancelDraw();
  const frame = latest.take(); if (!frame) return;
  try {
    const width = frame.displayWidth, height = frame.displayHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width; canvas.height = height;
      report({ type: 'dimensions', width, height });
    }
    context.drawImage(frame, 0, 0, width, height);
    rendered++;
    const start = receivedAtByFrame.get(frame);
    if (start !== undefined) { lastDrawMs = performance.now() - start; maxDrawMs = Math.max(maxDrawMs, lastDrawMs); }
    if (!firstFrameReported) { firstFrameReported = true; report({ type: 'frame' }); }
  } finally { frame.close(); }
}
function stop() { socket?.close(); socket = null; releaseDecoder(); }
onmessage = async ({ data: message }) => {
  if (message.type === 'init') {
    canvas = message.canvas; context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context || typeof VideoDecoder === 'undefined') { report({ type: 'error', message: '需要支持 WebCodecs 和 OffscreenCanvas 的新版 Chrome / Edge，请从 localhost 打开' }); return; }
    mode = message.mode; suspended = false;
    socket = new WebSocket(message.url); socket.binaryType = 'arraybuffer';
    socket.onopen = () => send({ type: 'start', serial: message.serial, settings: message.settings });
    socket.onmessage = ({ data }) => {
      try {
        if (typeof data === 'string') {
          const event = JSON.parse(data);
          if (event.type === 'size') { desiredWidth = event.width; desiredHeight = event.height; releaseDecoder(); }
          if (event.type === 'resync') releaseDecoder();
          report(event); return;
        }
        bytes += data.byteLength;
        const packet = unpackPacket(data); packet.receivedAt = performance.now(); send({ type: 'ack', id: packet.id });
        if (packet.config) void configure(packet.data);
        else { received++; decodePacket(packet); }
      } catch (error) { report({ type: 'error', message: error.message }); stop(); }
    };
    socket.onclose = () => { releaseDecoder(); report({ type: 'disconnected' }); };
    socket.onerror = () => report({ type: 'error', message: '无法连接本地服务，请检查服务是否运行' });
  } else if (message.type === 'control') send(message.message);
  else if (message.type === 'visibility' && suspended !== message.hidden) {
    suspended = message.hidden;
    if (suspended) { cancelDraw(); latest.clear(); submitted.clear(); clearPending(); }
    else resync('页面恢复前台');
  }
  else if (message.type === 'stop') stop();
  else if (message.type === 'screenshot') {
    try { report({ type: 'screenshot', blob: await canvas.convertToBlob({ type: 'image/png' }) }); }
    catch (error) { report({ type: 'notice', message: error.message }); }
  }
};
setInterval(() => {
  const now = performance.now(), seconds = (now - lastStats) / 1000;
  report({ type: 'stats', fps: rendered / seconds, inputFps: received / seconds, mbps: bytes * 8 / seconds / 1e6,
    dropped, hiddenDrops, resets, lastRecovery, waitingKey, suspended, pendingDecode: submitted.size,
    queue: decoder?.state === 'configured' ? decoder.decodeQueueSize : 0,
    drawMs: rendered ? lastDrawMs : null, maxDrawMs: rendered ? maxDrawMs : null, preference: decoderPreference,
    width: canvas?.width || desiredWidth, height: canvas?.height || desiredHeight });
  received = rendered = bytes = maxDrawMs = 0; lastStats = now;
}, 1000);
