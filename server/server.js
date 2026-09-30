'use strict';
/* =========================================================================
   BizOrganiser — local / VM server: serves ./public and the /api routes.
   (On Vercel the same API runs from api/index.js and Vercel serves ./public.)
   ========================================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle, ensureReady, SEC_HEADERS, RUNTIME, DATA, PUB, where } = require('./app');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400, SEC_HEADERS).end('Bad request'); return; }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const p = path.normalize(path.join(PUB, rel));
  if (!p.startsWith(PUB + path.sep)) { res.writeHead(404, SEC_HEADERS).end('Not found'); return; }
  fs.stat(p, (err, st) => {
    if (err || !st.isFile()) {
      if (!path.extname(rel)) { res.writeHead(302, { Location: pathname + '/' }).end(); return; }
      res.writeHead(404, { ...SEC_HEADERS, 'Content-Type': 'text/plain' }).end('Not found'); return;
    }
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(p).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/api/')) return handle(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SEC_HEADERS).end('Method not allowed'); return; }
  serveStatic(req, res, pathname);
});
server.requestTimeout = 120000;
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${RUNTIME.port} is already in use — is BizOrganiser already running? Set another port with PORT=8081 or in data/config.json.`);
  else console.error(e);
  process.exit(1);
});

ensureReady().then(() => {
  server.listen(RUNTIME.port, RUNTIME.host, () => {
    console.log(`BizOrganiser running at http://${RUNTIME.host === '0.0.0.0' ? 'localhost' : RUNTIME.host}:${RUNTIME.port}/`);
    console.log(`  B2B portal: /b2b/   ·   E-shop: /shop/   ·   database: ${where}   ·   data folder: ${DATA}`);
  });
}).catch(e => { console.error('Could not start BizOrganiser:', e); process.exit(1); });
