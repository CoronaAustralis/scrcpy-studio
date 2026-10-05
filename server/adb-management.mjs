import { isIP } from 'node:net';
import { adb } from './adb.mjs';

export function endpoint(value, { requirePort = false, disconnect = false } = {}) {
  if (typeof value !== 'string' || value.length > 300) throw new Error('请输入设备地址，例如 192.168.1.20:5555');
  const address = value.trim();
  if (disconnect && /^[a-z\d][a-z\d._-]*\._adb-tls-connect\._tcp\.?$/i.test(address)) return address;
  const parts = address.startsWith('[') ? /^(\[[^\]]+\])(?::(\d+))?$/.exec(address) : /^([a-z\d][a-z\d._-]*)(?::(\d+))?$/i.exec(address);
  if (!parts || parts[1].length > 253) throw new Error('设备地址只支持主机名、IPv4 或 [IPv6]，以及可选端口');
  const host = parts[1];
  if (host.startsWith('[') && isIP(host.slice(1, -1)) !== 6) throw new Error('IPv6 地址无效');
  if (requirePort && !parts[2]) throw new Error('配对需要填写手机显示的配对端口');
  const port = Number(parts[2] || 5555);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间');
  return `${host}:${port}`;
}

export function validateAdbAction(input) {
  if (!input || typeof input !== 'object') throw new Error('无效的 ADB 请求');
  const { action } = input;
  if (!['connect', 'disconnect', 'disconnect-all', 'pair', 'reconnect-offline', 'restart'].includes(action)) throw new Error('不支持的 ADB 操作');
  const result = { action };
  if (['connect', 'disconnect', 'pair'].includes(action)) result.target = endpoint(input.target, { requirePort: action === 'pair', disconnect: action === 'disconnect' });
  if (action === 'pair') {
    if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code)) throw new Error('配对码必须是手机显示的 6 位数字');
    result.code = input.code;
  }
  return result;
}

export async function performAdbAction(input, { run = adb, stopSessions = async () => {} } = {}) {
  const request = validateAdbAction(input);
  const { action, target, code } = request;
  try {
    let output;
    if (action === 'connect') output = await run(['connect', target]);
    else if (action === 'pair') output = await run(['pair', target], { input: `${code}\n`, timeout: 30000 });
    else if (action === 'disconnect') { await stopSessions(target); output = await run(['disconnect', target]); }
    else if (action === 'disconnect-all') { await stopSessions('network'); output = await run(['disconnect']); }
    else if (action === 'reconnect-offline') output = await run(['reconnect', 'offline']);
    else {
      await stopSessions('all');
      await run(['kill-server']);
      await run(['start-server']);
      output = 'ADB 已重启。网络设备请重新连接。';
    }
    // adb connect can exit 0 while reporting a failed connection.
    if (/\b(failed|cannot|unable|error|refused|timed out)\b/i.test(output)) throw new Error(output);
    return { action, target, message: (output || '操作完成').replaceAll(code || '\0', '[已隐藏]') };
  } catch (error) {
    // Do not return execFile's command-line representation or the pairing code.
    const detail = error.stderr || error.stdout || error.message || 'ADB 操作失败';
    throw new Error(String(detail).replaceAll(code || '\0', '[已隐藏]').slice(0, 1800));
  }
}
