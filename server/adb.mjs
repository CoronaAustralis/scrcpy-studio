import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
export const adbPath = process.env.ADB_PATH || 'adb';
export async function adb(args, { input, timeout = 20000 } = {}) {
  const task = exec(adbPath, args, { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 });
  if (input !== undefined) {
    // A failed adb process may close stdin before consuming the pairing code.
    task.child.stdin.on('error', () => {});
    task.child.stdin.end(input);
  }
  const { stdout } = await task;
  return stdout.trim();
}
export async function devices() {
  const output = await adb(['devices', '-l']);
  return output.split(/\r?\n/).slice(1).filter(line => line.trim()).map(line => {
    const [serial, state, ...details] = line.trim().split(/\s+/);
    const props = Object.fromEntries(details.filter(x => x.includes(':')).map(x => { const i = x.indexOf(':'); return [x.slice(0, i), x.slice(i + 1)]; }));
    const network = serial.includes(':') || serial.includes('._adb-tls-connect._tcp');
    return { serial, state, model: (props.model || serial).replaceAll('_', ' '), network, transport: network ? '网络 ADB' : 'USB' };
  });
}
export async function locateServer() {
  // Only accept official 4.1. Other versions have a different wire protocol.
  const configured = process.env.SCRCPY_SERVER_PATH;
  if (configured) { await access(configured); return { path: path.resolve(configured), version: '4.1' }; }
  const executableName = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';
  const candidates = [process.env.SCRCPY_PATH, process.env.SCRCPY_HOME && path.join(process.env.SCRCPY_HOME, executableName), ...(process.platform === 'win32' ? ['D:/tools/scrcpy/scrcpy.exe'] : []), 'scrcpy'].filter(Boolean);
  for (const executable of candidates) {
    try {
      const { stdout } = await exec(executable, ['--version'], { windowsHide: true, timeout: 4000 });
      if (!/^scrcpy 4\.1(?:\s|$)/m.test(stdout)) continue;
      let resolved = executable;
      if (!path.isAbsolute(executable)) {
        const { stdout: found } = await exec(process.platform === 'win32' ? 'where.exe' : 'which', [executable], { windowsHide: true });
        resolved = found.trim().split(/\r?\n/)[0];
      }
      const serverPath = path.join(path.dirname(resolved), 'scrcpy-server');
      await access(serverPath); return { path: serverPath, version: '4.1' };
    } catch { /* Try the next installation. */ }
  }
  throw new Error('找不到官方 scrcpy 4.1。请设置 SCRCPY_SERVER_PATH 指向 4.1 的 scrcpy-server 文件。');
}
export function launch(serial, args) {
  return spawn(adbPath, ['-s', serial, 'shell', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
