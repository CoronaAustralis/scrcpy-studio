import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';

export function certificateHosts(value = 'localhost,127.0.0.1,::1') {
  return [...new Set(value.split(',').map(host => host.trim()).filter(Boolean))].map(host => {
    if (isIP(host)) return `IP:${host}`;
    if (host.length > 253 || !host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
      throw new Error('TLS_HOSTS 只接受逗号分隔的 IP 或域名，不包含协议、端口或路径');
    }
    return `DNS:${host.toLowerCase()}`;
  });
}

export function tlsOptions(env = process.env) {
  const custom = env.TLS_CERT || env.TLS_KEY;
  if (custom) {
    if (!env.TLS_CERT || !env.TLS_KEY) throw new Error('TLS_CERT 和 TLS_KEY 必须一起设置');
    return { cert:readFileSync(env.TLS_CERT), key:readFileSync(env.TLS_KEY), minVersion:'TLSv1.2' };
  }
  if (env.HTTPS !== 'true') return undefined;
  const hosts = certificateHosts(env.TLS_HOSTS);
  if (!hosts.length) throw new Error('TLS_HOSTS 不能为空');
  const dir = path.resolve(env.TLS_DIR || '.tls');
  mkdirSync(dir, { recursive:true, mode:0o700 });
  const file = name => path.join(dir, name);
  const run = args => execFileSync('openssl', args, { windowsHide:true, stdio:['ignore', 'pipe', 'pipe'], timeout:30000 });
  const ca = file('ca.crt'), caKey = file('ca.key'), cert = file('server.crt'), key = file('server.key');
  const previousMask = process.umask(0o077);
  try {
    if (!existsSync(ca) || !existsSync(caKey)) {
      if (existsSync(ca) || existsSync(caKey)) throw new Error('TLS CA 文件不完整，请恢复 ca.crt 和 ca.key');
      writeFileSync(file('ca.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Scrcpy Studio Local CA\n[ext]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
      run(['req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','3650','-config',file('ca.cnf'),'-keyout',caKey,'-out',ca]);
    }
    if (Date.parse(new X509Certificate(readFileSync(ca)).validTo) < Date.now() + 86400000) throw new Error('本地 CA 即将过期，请重新生成证书并重新导入信任');
    const identity = hosts.join(',');
    const reuse = existsSync(cert) && existsSync(key) && existsSync(file('hosts.txt')) && readFileSync(file('hosts.txt'),'utf8') === identity && Date.parse(new X509Certificate(readFileSync(cert)).validTo) > Date.now() + 7 * 86400000 && new X509Certificate(readFileSync(cert)).verify(new X509Certificate(readFileSync(ca)).publicKey);
    if (!reuse) {
      writeFileSync(file('server.cnf'), `[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Scrcpy Studio\n`);
      writeFileSync(file('extensions.cnf'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${identity}\n`);
      run(['req','-new','-newkey','rsa:2048','-nodes','-sha256','-config',file('server.cnf'),'-keyout',key,'-out',file('server.csr')]);
      run(['x509','-req','-in',file('server.csr'),'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-days','365','-sha256','-extfile',file('extensions.cnf'),'-out',cert]);
      writeFileSync(file('hosts.txt'), identity);
    }
    return { cert:readFileSync(cert), key:readFileSync(key), minVersion:'TLSv1.2' };
  } finally { process.umask(previousMask); }
}
