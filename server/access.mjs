import { timingSafeEqual } from 'node:crypto';

function equal(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAccessPolicy({ username = 'admin', password = '' } = {}) {
  return {
    allows(req) {
      const host = req.headers.host;
      if (!host || /[\s/@\\?#,]/.test(host) || req.headers['sec-fetch-site'] === 'cross-site') return false;
      try {
        const target = new URL(`http://${host}`);
        if (!target.hostname) return false;
        if (!req.headers.origin) return true;
        const origin = new URL(req.headers.origin);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== req.headers.origin) return false;
        // Use the requested authority, including mapped ports, for HTTP and HTTPS.
        // This also works when TLS terminates upstream without trusting forwarded headers.
        return origin.origin === new URL(`${origin.protocol}//${host}`).origin;
      } catch { return false; }
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
