'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { AuditStore } = require('./store');

const PORT = Number(process.env.PORT || process.env.HOST_PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.resolve(__dirname, '../../web/dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function createServer(store = new AuditStore()) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /healthz') {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'deepspace-proof-audit',
        time: new Date().toISOString(),
        sessions: store.sessions.size,
      });
    }

    if (route === 'POST /api/audits') {
      return readJson(req, (err, body) => {
        if (err) return sendJson(res, 400, { error: 'BAD_JSON', message: err.message });
        const { status, body: result } = store.submit(body);
        return sendJson(res, status, result);
      });
    }

    const mGet = url.pathname.match(/^\/api\/audits\/([^/]+)$/);
    if (req.method === 'GET' && mGet) {
      const found = store.get(decodeURIComponent(mGet[1]));
      if (!found) return sendJson(res, 404, { error: 'NOT_FOUND', message: '审计标识不存在' });
      return sendJson(res, 200, found.body);
    }

    if (req.method === 'GET') return serveStatic(url.pathname, res);
    sendJson(res, 404, { error: 'NOT_FOUND', message: '未知路由' });
  });
}

function readJson(req, cb) {
  let data = '';
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1_048_576) {
      cb(new Error('请求体超过 1 MiB 限制'));
      req.destroy();
      return;
    }
    data += chunk;
  });
  req.on('end', () => {
    try {
      cb(null, data.length ? JSON.parse(data) : {});
    } catch (e) {
      cb(e);
    }
  });
  req.on('error', cb);
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback
      file = path.join(PUBLIC_DIR, 'index.html');
      return fs.readFile(file, (e2, idx) => {
        if (e2) return sendJson(res, 404, { error: 'NOT_FOUND', message: '前端尚未构建：请先运行 npm run build' });
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(idx);
      });
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`[audit] listening on http://${HOST}:${PORT} (health: /healthz)`);
  });
}

module.exports = { createServer };
