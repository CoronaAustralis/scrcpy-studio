const $ = id => document.getElementById(id);
let token, selected, deviceList = [], worker, active = false, busy = false, dimensions = { width: 0, height: 0 };
let framesShown = false, toastTimer, timeout, serverDrops = 0, clientDrops = 0, history = [], lastModel = '', hasError = false;
const controls = [...document.querySelectorAll('[data-key]'), $('rotate'), $('paste'), $('screenshot')];
function toast(message, error = false) {
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, error ? 15000 : 4500);
}
function status(text, live = false) { $('status').querySelector('span').textContent = text; $('status').classList.toggle('live', live); }
function setButtons() {
  $('connect').disabled = !selected;
  $('connect').textContent = busy ? '取消连接' : active ? '断开连接' : '↗  开始投屏';
  $('connect').classList.toggle('disconnect', active);
  $('apply').disabled = !active || busy;
  controls.forEach(button => button.disabled = !active || !framesShown);
  document.body.classList.toggle('busy', busy);
}
function settings() { return { maxSize: Number($('max-size').value), bitrate: Number($('bitrate').value), fps: Number($('max-fps').value) }; }
function saveSettings() {
  try { localStorage.setItem('scrcpy-studio.v1', JSON.stringify({ ...settings(), decoder: $('decoder').value })); } catch { /* Private mode may disallow storage. */ }
}
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('scrcpy-studio.v1'));
    if (!saved) return;
    for (const [key, id] of [['maxSize', 'max-size'], ['fps', 'max-fps'], ['decoder', 'decoder']]) {
      if ([...$(id).options].some(option => option.value === String(saved[key]))) $(id).value = String(saved[key]);
    }
    if (Number.isInteger(saved.bitrate) && saved.bitrate >= 2 && saved.bitrate <= 40) $('bitrate').value = saved.bitrate;
  } catch { /* Ignore obsolete or invalid preferences. */ }
}
function updateSettings() {
  $('bitrate-value').textContent = `${$('bitrate').value} Mbps`;
  const presets = { smooth: [1280, 4, 60], balanced: [1920, 8, 60], sharp: [0, 16, 60] };
  const s = settings();
  document.querySelectorAll('[data-preset]').forEach(b => b.classList.toggle('selected', JSON.stringify(presets[b.dataset.preset]) === JSON.stringify([s.maxSize, s.bitrate, s.fps])));
  $('apply-note').textContent = active ? '应用时会短暂重连，当前画面不随窗口降质' : '下次连接时使用以上设置';
  saveSettings();
}
document.querySelectorAll('[data-preset]').forEach(button => button.onclick = () => {
  const preset = { smooth: [1280, 4], balanced: [1920, 8], sharp: [0, 16] }[button.dataset.preset];
  $('max-size').value = preset[0]; $('bitrate').value = preset[1]; $('max-fps').value = '60'; updateSettings();
});
for (const id of ['max-size', 'max-fps', 'bitrate', 'decoder']) $(id).addEventListener('input', updateSettings);
async function refresh() {
  $('refresh').disabled = true;
  try {
    const res = await fetch('/api/devices', { headers: { 'X-Session-Token': token } }); const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    deviceList = data.devices; $('devices').replaceChildren();
    if (!deviceList.some(d => d.serial === selected && d.state === 'device')) selected = deviceList.find(d => d.state === 'device')?.serial;
    $('device-count').textContent = deviceList.filter(d => d.state === 'device').length;
    if (!deviceList.length) {
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = '未发现设备。点击 ADB 管理连接网络设备，或连接已开启调试的 USB 设备。'; $('devices').append(p);
    }
    for (const device of deviceList) {
      const button = document.createElement('button'); button.className = 'device-card'; button.classList.toggle('selected', device.serial === selected);
      button.disabled = device.state !== 'device'; button.title = device.serial;
      const icon = document.createElement('span'); icon.className = 'device-symbol'; icon.textContent = '▯';
      const info = document.createElement('span'), name = document.createElement('strong'), detail = document.createElement('small');
      name.textContent = device.model; detail.textContent = device.state === 'device' ? `${device.transport} · 已就绪` : `${device.state} · 请在设备上授权`;
      info.append(name, detail); const dot = document.createElement('i'); dot.className = 'local-dot'; button.append(icon, info, dot);
      button.onclick = () => { if (active || busy) disconnect(); selected = device.serial; renderSelection(); setButtons(); };
      $('devices').append(button);
    }
    setButtons(); renderAdbDevices();
  } catch (error) { toast(`设备检查失败：${error.message}`, true); }
  finally { $('refresh').disabled = false; }
}
function renderSelection() { [...$('devices').children].forEach((button, i) => button.classList.toggle('selected', deviceList[i]?.serial === selected)); }
function control(message) { if (worker && active) worker.postMessage({ type: 'control', message }); }
function key(code) { control({ type: 'key', code, action: 0 }); control({ type: 'key', code, action: 1 }); }
function createCanvas() {
  const canvas = document.createElement('canvas'); canvas.id = 'screen'; canvas.tabIndex = 0; canvas.hidden = true;
  canvas.setAttribute('aria-label', 'Android 设备屏幕，可点击、拖动和滚动操控'); $('screen').replaceWith(canvas); bindInput(canvas); return canvas;
}
function disconnect(message = '已断开连接') {
  clearTimeout(timeout); worker?.postMessage({ type: 'stop' }); worker?.terminate(); worker = null;
  active = busy = framesShown = false; pointers.clear(); dimensions = { width: 0, height: 0 };
  $('screen').hidden = true; $('empty').hidden = false; $('empty-message').textContent = message;
  $('viewer').classList.remove('streaming'); $('screen-area').classList.remove('native-area'); status('未连接');
  $('view-hint').textContent = '连接后可直接点击、滑动与输入';
  for (const id of ['fps', 'mbps', 'latency', 'queue', 'dropped', 'pending', 'input-fps', 'recoveries', 'hidden-drops', 'sync-state']) $(id).textContent = '—';
  $('decoder-status').textContent = '尚未连接'; history = []; chart(); setButtons(); updateSettings();
  $('chart-label').textContent = '等待画面'; $('resolution').textContent = 'H.264 / 实时画面';
}
function start() {
  if (!selected || busy) return;
  if (!window.isSecureContext || !('VideoDecoder' in window) || !HTMLCanvasElement.prototype.transferControlToOffscreen) {
    toast('请使用新版 Chrome / Edge，通过 localhost、127.0.0.1 或 HTTPS 访问。当前环境不支持 WebCodecs。', true); return;
  }
  hasError = false; serverDrops = clientDrops = 0; active = busy = true; framesShown = false;
  status('正在连接'); $('empty').hidden = false; $('empty-message').textContent = '正在连接设备…'; setButtons();
  lastModel = deviceList.find(d => d.serial === selected)?.model || selected; $('viewer-title').textContent = lastModel;
  const canvas = createCanvas(), offscreen = canvas.transferControlToOffscreen();
  worker = new Worker('/decoder-worker.js?v=0.2.0', { type: 'module' });
  worker.onmessage = ({ data }) => onWorkerMessage(data);
  worker.onerror = event => { toast(`播放器错误：${event.message}`, true); disconnect('播放器启动失败，请查看错误提示'); };
  worker.postMessage({ type: 'init', canvas: offscreen, url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream?token=${encodeURIComponent(token)}`, serial: selected, settings: settings(), mode: $('decoder').value }, [offscreen]);
  timeout = setTimeout(() => { toast('等待首帧超时，请检查设备是否解锁、编码器是否可用，或切换自动解码。', true); disconnect('尚未收到可显示的画面，请重试。'); }, 35000);
  updateSettings();
}
function onWorkerMessage(event) {
  if (event.type === 'status') $('empty-message').textContent = event.message;
  else if (event.type === 'connected') { $('server-version').textContent = event.serverVersion; }
  else if (event.type === 'dimensions') {
    dimensions = { width: event.width, height: event.height };
    $('resolution').textContent = `${event.width} × ${event.height} / H.264`;
    // The DOM canvas is transferred: CSS must use the actual video aspect ratio.
    $('screen').style.aspectRatio = `${event.width} / ${event.height}`;
  } else if (event.type === 'frame') {
    if (!framesShown) {
      framesShown = true; busy = false; clearTimeout(timeout); $('screen').hidden = false; $('empty').hidden = true;
      $('viewer').classList.add('streaming'); status('正在投屏', true); setButtons();
      $('view-hint').textContent = '点击控制 · 拖动滑动 · 滚轮翻页'; $('screen').focus({ preventScroll: true });
    }
  } else if (event.type === 'decoder') {
    $('decoder-status').textContent = ({ 'prefer-hardware': '硬件优先（已请求）', 'no-preference': '浏览器自动', 'prefer-software': '软件优先（已请求）' })[event.preference];
    $('decoder-status').title = `${event.codec} · 浏览器 API 不提供实际硬解状态保证`;
  } else if (event.type === 'stats') {
    if (!framesShown) return;
    $('fps').textContent = event.fps.toFixed(0); $('mbps').textContent = event.mbps.toFixed(2);
    $('latency').textContent = event.drawMs === null ? '—' : event.drawMs.toFixed(1); $('queue').textContent = event.queue;
    clientDrops = event.dropped; $('dropped').textContent = clientDrops + serverDrops;
    $('input-fps').textContent = event.inputFps.toFixed(0);
    $('recoveries').textContent = event.resets;
    $('recoveries').title = `最近原因：${event.lastRecovery}`;
    $('hidden-drops').textContent = event.hiddenDrops;
    $('sync-state').textContent = event.suspended ? '后台暂停' : event.waitingKey ? '等待关键帧' : '已同步';
    history.push(event.fps); if (history.length > 40) history.shift(); chart();
    $('chart-label').textContent = `${event.fps.toFixed(0)} / ${settings().fps} FPS`;
  } else if (event.type === 'transport') { serverDrops = event.dropped; $('pending').textContent = event.pending; $('dropped').textContent = clientDrops + serverDrops; }
  else if (event.type === 'error') { hasError = true; toast(event.message, true); disconnect('连接遇到问题，请查看提示并重试。'); }
  else if (event.type === 'notice') toast(event.message);
  else if (event.type === 'disconnected' && active) disconnect(hasError ? '连接失败，请查看错误提示。' : '设备连接已断开，点击开始投屏重新连接。');
  else if (event.type === 'screenshot') {
    const url = URL.createObjectURL(event.blob), a = document.createElement('a'); a.href = url; a.download = `scrcpy-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); toast('截图已保存');
  }
}
const pointers = new Map();
function point(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return { x: Math.max(0, Math.min(dimensions.width - 1, Math.floor((event.clientX - rect.left) / rect.width * dimensions.width))),
    y: Math.max(0, Math.min(dimensions.height - 1, Math.floor((event.clientY - rect.top) / rect.height * dimensions.height))), ...dimensions };
}
function releasePointers() {
  for (const [pointerId, pos] of pointers) control({ type: 'touch', pointerId, action: 1, ...pos }); pointers.clear();
}
function bindInput(canvas) {
  canvas.oncontextmenu = e => { e.preventDefault(); key(4); };
  canvas.onpointerdown = e => {
    if (!framesShown || e.button !== 0) return; e.preventDefault(); canvas.focus({ preventScroll: true }); canvas.setPointerCapture(e.pointerId);
    const pointerId = e.pointerId % 65536, pos = point(e, canvas); pointers.set(pointerId, pos); control({ type: 'touch', pointerId, action: 0, ...pos });
  };
  canvas.onpointermove = e => {
    const pointerId = e.pointerId % 65536; if (!pointers.has(pointerId)) return;
    const pos = point(e, canvas); pointers.set(pointerId, pos); control({ type: 'touch', pointerId, action: 2, ...pos });
  };
  const up = e => {
    const pointerId = e.pointerId % 65536; if (!pointers.has(pointerId)) return;
    control({ type: 'touch', pointerId, action: 1, ...point(e, canvas) }); pointers.delete(pointerId);
  };
  canvas.onpointerup = up; canvas.onpointercancel = up; canvas.onlostpointercapture = up;
  canvas.addEventListener('wheel', e => {
    if (!framesShown) return; e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 300 : 1;
    control({ type: 'scroll', ...point(e, canvas), dx: -e.deltaX * unit / 100, dy: -e.deltaY * unit / 100 });
  }, { passive: false });
  canvas.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = { Enter: 66, Backspace: 67, Escape: 4, Tab: 61, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Delete: 112, Home: 122, End: 123 }[e.key];
    if (code) { e.preventDefault(); key(code); }
    else if (e.key.length === 1) { e.preventDefault(); control({ type: /^[\x20-\x7e]$/.test(e.key) ? 'text' : 'paste', text: e.key }); }
  });
  canvas.addEventListener('paste', e => { const text = e.clipboardData?.getData('text'); if (text) { e.preventDefault(); control({ type: 'paste', text }); } });
}
function chart() {
  const canvas = $('fps-chart'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h); ctx.strokeStyle = '#2c3933'; ctx.lineWidth = 1;
  for (let y = 15; y < h; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  if (!history.length) return;
  const scale = Math.max(60, ...history), points = history.map((fps, i) => [i * w / 39, h - 7 - fps / scale * (h - 20)]);
  ctx.beginPath(); ctx.moveTo(points[0][0], h); for (const [x, y] of points) ctx.lineTo(x, y); ctx.lineTo(points.at(-1)[0], h); ctx.closePath();
  const fill = ctx.createLinearGradient(0, 0, 0, h); fill.addColorStop(0, '#b8eb7340'); fill.addColorStop(1, '#b8eb7300'); ctx.fillStyle = fill; ctx.fill();
  ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.strokeStyle = '#b7e778'; ctx.lineWidth = 2; ctx.stroke();
}
$('connect').onclick = () => active ? disconnect() : start();
$('apply').onclick = async () => { disconnect('正在应用设置…'); await new Promise(resolve => setTimeout(resolve, 500)); start(); };
$('refresh').onclick = refresh;
document.querySelectorAll('[data-key]').forEach(button => button.onclick = () => key(Number(button.dataset.key)));
$('rotate').onclick = () => control({ type: 'rotate' });
$('recover').onclick = () => { control({ type: 'resync' }); toast('正在请求新的关键帧'); };
$('paste').onclick = () => { const text = $('paste-text').value; if (text) { control({ type: 'paste', text }); toast('文字已发送'); } };
$('screenshot').onclick = () => worker?.postMessage({ type: 'screenshot' });
$('fit').onclick = () => { const native = $('screen').classList.toggle('native'); $('screen-area').classList.toggle('native-area', native); toast(native ? '原始像素显示' : '适应窗口，编码分辨率保持不变'); };
$('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('viewer').requestFullscreen(); } catch (e) { toast(e.message, true); } };
document.addEventListener('visibilitychange', () => { releasePointers(); worker?.postMessage({ type: 'visibility', hidden: document.hidden }); });
window.addEventListener('blur', releasePointers);
window.addEventListener('beforeunload', () => worker?.postMessage({ type: 'stop' }));
let adbPending = false;
function renderAdbDevices() {
  $('adb-devices').replaceChildren();
  if (!deviceList.length) $('adb-devices').textContent = '暂无设备';
  for (const device of deviceList) {
    const row = document.createElement('div'); row.className = 'adb-device';
    const detail = document.createElement('span'); detail.textContent = `${device.model} · ${device.state}\n${device.serial}`; row.append(detail);
    if (device.network) {
      const button = document.createElement('button'); button.className = 'button secondary'; button.textContent = '断开'; button.disabled = adbPending;
      button.onclick = () => adbAction({ action: 'disconnect', target: device.serial }); row.append(button);
    }
    $('adb-devices').append(row);
  }
}
async function adbAction(request) {
  if (adbPending) return;
  adbPending = true;
  $('adb-dialog').querySelectorAll('button, input').forEach(el => { if (el.id !== 'adb-close') el.disabled = true; });
  $('adb-result').textContent = '正在执行，请稍候…';
  try {
    const res = await fetch('/api/adb', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': token }, body: JSON.stringify(request) });
    const data = await res.json(); if (!res.ok) throw new Error(data.error);
    $('adb-result').textContent = data.message;
  } catch (error) { $('adb-result').textContent = `操作失败：${error.message}`; }
  finally {
    $('adb-code').value = ''; await refresh(); adbPending = false;
    $('adb-dialog').querySelectorAll('button, input').forEach(el => el.disabled = false);
  }
}
$('adb-open').onclick = () => { $('adb-dialog').showModal(); void refresh(); };
$('adb-close').onclick = () => $('adb-dialog').close();
$('adb-refresh').onclick = refresh;
$('adb-connect-form').onsubmit = e => { e.preventDefault(); void adbAction({ action: 'connect', target: $('adb-target').value }); };
$('adb-pair-form').onsubmit = e => { e.preventDefault(); void adbAction({ action: 'pair', target: $('adb-pair-target').value, code: $('adb-code').value }); };
document.querySelectorAll('[data-adb-action]').forEach(button => button.onclick = () => adbAction({ action: button.dataset.adbAction }));
loadSettings(); updateSettings(); chart();
try {
  const res = await fetch('/api/info'), info = await res.json(); token = info.token;
  if (info.serverError) toast(info.serverError, true);
  await refresh();
} catch (error) { toast(`服务不可用：${error.message}`, true); }
