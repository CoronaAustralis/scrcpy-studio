import http from 'node:http';
import https from 'node:https';
import { tlsOptions } from './tls.mjs';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { devices, locateServer } from './adb.mjs';
import { settingsFrom } from './protocol.mjs';
import { Session } from './session.mjs';
import { createAccessPolicy } from './access.mjs';
import { performAdbAction, validateAdbAction } from './adb-management.mjs';

const port = Number(process.env.PORT || 8787);
const token = randomBytes(32).toString('hex');
const sessions = new Map();
const host = process.env.HOST || '0.0.0.0';
const access = createAccessPolicy({ username: process.env.STUDIO_USER, password: process.env.STUDIO_PASSWORD });
let adbBusy = false;
async function stopSessions(selector) {
  await Promise.all([...sessions.values()].filter(s => selector === 'all' || s.serial === selector || (selector === 'network' && /:|\._adb-tls-connect\._tcp/.test(s.serial))).map(async s => {
    s.ws.close(1000, 'ADB management');
    await s.stop();
    if (sessions.get(s.serial) === s) sessions.delete(s.serial);
  }));
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new Error('请求体超过 4 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const publicRoot = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/style.css', ['style.css', 'text/css']],
  ...['app.js', 'decoder-worker.js', 'decoder-core.js'].map(name => [`/${name}`, [name, 'text/javascript']]),
]);
function authorized(value) { const b = Buffer.from(value || ''); const a = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); }
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
const tls = tlsOptions();
const handleRequest = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; worker-src 'self'; frame-ancestors 'none'");
  if (!access.allows(req)) return json(res, 403, { error: 'Host or Origin not allowed' });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });
  if (!access.authenticated(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Scrcpy Studio", charset="UTF-8"');
    return json(res, 401, { error: 'Authentication required' });
  }
  if (url.pathname === '/api/adb' && req.method === 'POST') {
    if (!authorized(req.headers['x-session-token'])) return json(res, 403, { error: 'Invalid session token' });
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { error: 'Expected application/json' });
    let action;
    try { action = validateAdbAction(await readJson(req)); } catch (error) { return json(res, 400, { error: error.message }); }
    if (adbBusy) return json(res, 409, { error: '另一个 ADB 操作正在进行' });
    adbBusy = true;
    try { return json(res, 200, await performAdbAction(action, { stopSessions })); }
    catch (error) { return json(res, 502, { error: error.message }); }
    finally { adbBusy = false; }
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
  try {
    if (url.pathname === '/api/info') {
      let scrcpy, serverError;
      try { scrcpy = await locateServer(); } catch (error) { serverError = error.message; }
      return json(res, 200, { token, scrcpy, serverError });
    }
    if (url.pathname === '/api/devices') {
      if (!authorized(req.headers['x-session-token'])) return json(res, 403, { error: 'Invalid session token' });
      return json(res, 200, { devices: await devices() });
    }
    const asset = assets.get(url.pathname);
    if (!asset) return json(res, 404, { error: 'Not found' });
    const data = await readFile(new URL(asset[0], publicRoot));
    res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(data);
  } catch (error) { json(res, 500, { error: error.message }); }
};
const server = tls ? https.createServer(tls, handleRequest) : http.createServer(handleRequest);
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 128 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (!access.allows(req) || url.pathname !== '/stream' || !authorized(url.searchParams.get('token'))) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    let session, starting = false;
    ws.on('error', () => {});
    ws.on('close', () => {
      if (session) { void session.stop(); if (sessions.get(session.serial) === session) sessions.delete(session.serial); }
    });
    ws.on('message', async (raw, binary) => {
      try {
        if (binary) throw new Error('Expected JSON control message');
        const message = JSON.parse(raw.toString());
        if (message.type === 'start') {
          if (adbBusy) throw new Error('ADB 操作进行中，请稍后重试');
          if (starting) throw new Error('Session already started');
          starting = true;
          const settings = settingsFrom(message.settings);
          const found = (await devices()).find(d => d.serial === message.serial && d.state === 'device');
          if (!found) throw new Error('设备不在线或未授权，请检查 adb devices');
          const scrcpy = await locateServer();
          if (adbBusy) throw new Error('ADB 操作进行中，请稍后重试');
          if (ws.readyState !== 1) return;
          if (sessions.has(found.serial)) throw new Error('此设备已在另一个页面连接，请先断开');
          session = new Session(ws, found.serial, settings, scrcpy); sessions.set(found.serial, session);
          await session.start();
        } else if (session) session.message(message);
      } catch (error) {
        if (session) session.fail(error);
        else { ws.send(JSON.stringify({ type: 'error', message: error.message })); ws.close(1008, 'Invalid request'); }
      }
    });
  });
});
server.listen(port, host, () => console.log(`Scrcpy Studio → ${tls ? 'https' : 'http'}://${host}:${port}\nOfficial scrcpy 4.1 · WebCodecs`));
async function shutdown() { await Promise.all([...sessions.values()].map(s => s.stop())); for (const ws of wss.clients) ws.terminate(); server.close(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
