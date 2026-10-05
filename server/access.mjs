import { timingSafeEqual } from 'node:crypto';

function equal(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAccessPolicy({ publicOrigin = '', username = 'admin', password = '' } = {}) {
  let external;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('PUBLIC_ORIGIN 必须是完整的 HTTP(S) origin，例如 https://scrcpy.example.com');
    }
    external = url.origin;
  }
  return {
    allows(req) {
      const host = req.headers.host;
      if (!host || /[\s/@\\?#]/.test(host)) return false;
      let origin;
      try {
        const local = new URL(`http://${host}`);
        const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname);
        if (external && host === new URL(external).host) origin = external;
        else if (loopback) origin = local.origin;
        else return false;
      } catch { return false; }
      return (!req.headers.origin || req.headers.origin === origin) && req.headers['sec-fetch-site'] !== 'cross-site';
    },
    authenticated(req) {
      if (!password) return true;
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Basic ')) return false;
      const credentials = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      return equal(credentials, `${username}:${password}`);
    },
  };
}
