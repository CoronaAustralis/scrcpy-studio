import http from 'node:http';
import https from 'node:https';
const tls = process.env.HTTPS === 'true' || process.env.TLS_CERT;
// Only the container-local liveness probe skips trust checking, never the browser.
const request = (tls ? https : http).get({ hostname:'127.0.0.1', port:process.env.PORT || 8787, path:'/api/health', rejectUnauthorized:false, timeout:4000 }, response => {
  response.resume(); process.exit(response.statusCode === 200 ? 0 : 1);
});
request.on('error', () => process.exit(1));
request.on('timeout', () => request.destroy());
