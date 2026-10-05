import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { adb, launch } from './adb.mjs';
import { VideoParser, DeliveryWindow, encodeControl } from './protocol.mjs';

function firstByte(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const fail = error => { socket.destroy(); reject(error); };
    socket.setTimeout(1500, () => fail(new Error('等待设备视频连接超时')));
    socket.once('error', fail);
    socket.once('end', () => fail(new Error('设备视频连接尚未就绪')));
    socket.once('data', data => {
      socket.pause(); socket.setTimeout(0); socket.removeListener('error', fail);
      socket.on('error', () => {}); resolve({ socket, data });
    });
  });
}
function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(4000, () => socket.destroy(new Error('控制连接超时')));
    socket.once('error', reject);
    socket.once('connect', () => { socket.setTimeout(0); resolve(socket); });
  });
}
export class Session {
  closed = false;
  window = new DeliveryWindow();
  logs = '';
  constructor(ws, serial, settings, server) { Object.assign(this, { ws, serial, settings, server }); }
  send(value) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(value)); }
  async start() {
    const scid = (randomBytes(4).readUInt32BE() & 0x7fffffff).toString(16).padStart(8, '0');
    this.remote = `/data/local/tmp/scrcpy-studio-${scid}.jar`;
    this.send({ type: 'status', message: '正在推送官方 scrcpy 服务…' });
    await adb(['-s', this.serial, 'push', this.server.path, this.remote]);
    if (this.closed) return this.cleanup();
    this.port = Number(await adb(['-s', this.serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scid}`]));
    if (this.closed) return this.cleanup();
    const { maxSize, bitrate, fps } = this.settings;
    this.process = launch(this.serial, [
      `CLASSPATH=${this.remote}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', '4.1',
      `scid=${scid}`, 'tunnel_forward=true', 'audio=false', 'control=true', 'video_codec=h264',
      `max_size=${maxSize}`, `video_bit_rate=${bitrate * 1000000}`, `max_fps=${fps}`,
      'video_codec_options=i-frame-interval=1', 'clipboard_autosync=false', 'log_level=info',
    ]);
    for (const stream of [this.process.stdout, this.process.stderr]) stream.on('data', chunk => { this.logs = (this.logs + chunk).slice(-6000); });
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', code => { if (!this.closed) this.fail(new Error(`设备服务退出 (${code})。${this.logs}`)); });
    this.send({ type: 'status', message: '等待编码器与视频通道…' });
    let result;
    for (let attempt = 0; attempt < 35 && !this.closed; attempt++) {
      try { result = await firstByte(this.port); break; } catch { await delay(150); }
    }
    if (this.closed) { result?.socket.destroy(); return; }
    if (!result) throw new Error(`无法连接手机端服务。${this.logs}`);
    this.video = result.socket;
    this.video.setNoDelay(true);
    this.control = await connect(this.port);
    if (this.closed) return this.cleanup();
    this.control.setNoDelay(true);
    this.control.on('data', () => {}); // Drain acknowledgements; clipboard sync is explicitly disabled.
    for (const socket of [this.video, this.control]) {
      socket.on('error', error => this.fail(error));
      socket.on('close', () => { if (!this.closed) this.fail(new Error('设备连接已断开')); });
    }
    const parser = new VideoParser(event => this.onVideo(event));
    const feed = data => { try { parser.push(data); } catch (error) { this.fail(error); } };
    this.video.on('data', feed); feed(result.data); this.video.resume();
    this.send({ type: 'connected', settings: this.settings, serverVersion: '4.1' });
    this.interval = setInterval(() => {
      if (this.window.congested(this.ws.bufferedAmount)) this.recover();
      this.send({ type: 'transport', pending: this.window.pending.size, dropped: this.window.dropped });
    }, 1000);
  }
  onVideo(event) {
    if (this.closed) return;
    if (event.type !== 'packet') {
      if (event.type === 'size') { this.window.waitingKey = true; this.config = undefined; }
      this.send(event); return;
    }
    if (event.config) { this.config = Buffer.from(event.raw); return; }
    if (this.window.congested(this.ws.bufferedAmount)) { this.window.dropped++; this.recover(); return; }
    if (this.window.waitingKey) {
      if (!event.key || !this.config) { this.window.dropped++; return; }
      this.send({ type: 'resync' }); this.sendPacket(this.config); this.window.waitingKey = false;
    }
    this.sendPacket(event.raw);
  }
  sendPacket(raw) {
    if (this.ws.readyState !== 1) return;
    const header = Buffer.allocUnsafe(4); header.writeUInt32BE(this.window.track());
    this.ws.send(Buffer.concat([header, raw]), { binary: true });
  }
  recover() {
    this.window.waitingKey = true;
    // The encoder is configured with a one-second IDR interval. Wait for that
    // natural key frame instead of repeatedly tearing down MediaCodec under
    // congestion (some virtual Android encoders stall on RESET_VIDEO).
  }
  writeControl(data) {
    if (this.control && !this.control.destroyed) {
      if (this.control.writableLength > 65536) return this.fail(new Error('控制通道拥堵，请重新连接'));
      this.control.write(data);
    }
  }
  message(message) {
    if (message.type === 'ack') {
      if (Number.isInteger(message.id) && message.id >= 0 && message.id <= this.window.sequence) this.window.ack(message.id);
    } else if (message.type === 'resync') this.recover();
    else this.writeControl(encodeControl(message));
  }
  fail(error) { if (!this.closed) { this.send({ type: 'error', message: error.message }); this.ws.close(1011, 'Session ended'); void this.stop(); } }
  async cleanup() {
    this.video?.destroy(); this.control?.destroy(); this.process?.kill();
    if (this.port) { const port = this.port; this.port = undefined; await adb(['-s', this.serial, 'forward', '--remove', `tcp:${port}`]).catch(() => {}); }
    if (this.remote) await adb(['-s', this.serial, 'shell', 'rm', '-f', this.remote]).catch(() => {});
  }
  async stop() { this.closed = true; clearInterval(this.interval); await this.cleanup(); }
}
