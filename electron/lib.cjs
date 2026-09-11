/**
 * Shared Electron helpers with NO electron dependency, so they can be
 * unit-tested with plain node (see test: `node electron/lib.test.cjs`).
 */
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

function health(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/health', timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve({ up: true, ...JSON.parse(body) });
        } catch {
          resolve({ up: true });
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ up: false }));
  });
}

async function waitForHealth(port, tries = 90, delayMs = 2000) {
  for (let i = 0; i < tries; i++) {
    const h = await health(port);
    if (h.up) return h;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { up: false };
}

function portBusy(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect(port, host);
    s.on('connect', () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function serveDist(distDir) {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.normalize(path.join(distDir, urlPath === '/' ? 'index.html' : urlPath.slice(1)));
      if (!file.startsWith(distDir)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(distDir, 'index.html'); // SPA fallback
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      fs.createReadStream(file).pipe(res);
    } catch {
      try {
        res.writeHead(500);
        res.end('error');
      } catch {
        /* noop */
      }
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

module.exports = { health, waitForHealth, portBusy, serveDist, MIME };
