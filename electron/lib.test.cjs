/** Headless smoke test for the Electron shell logic (plain node, no display). */
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { health, portBusy, serveDist } = require('./lib.cjs');

function get(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
      })
      .on('error', reject);
  });
}

(async () => {
  const dist = path.join(__dirname, '..', 'dist');
  const { server, port } = await serveDist(dist);
  try {
    const idx = await get(port, '/');
    assert.strictEqual(idx.status, 200, 'index serves');
    assert.match(idx.headers['content-type'], /text\/html/, 'html mime');
    assert.match(idx.body, /<div id="root"/, 'index has root');
    assert.strictEqual(idx.headers['cross-origin-embedder-policy'], 'require-corp', 'COEP set');

    const spa = await get(port, '/nonexistent-route');
    assert.strictEqual(spa.status, 200, 'SPA fallback');
    assert.match(spa.body, /<div id="root"/, 'fallback serves index');

    const trav = await get(port, '/..%5c..%5cpackage.json');
    assert.strictEqual(trav.status, 403, 'traversal blocked');

    // live sidecar (started separately on 8010)
    const busy = await portBusy(8010);
    assert.strictEqual(busy, true, 'sidecar port busy');
    const h = await health(8010);
    assert.strictEqual(h.up, true, 'sidecar answers');
    assert.strictEqual(h.device, 'cuda', 'sidecar on cuda');

    const free = await portBusy(9);
    assert.strictEqual(free, false, 'closed port reported free');
    const down = await health(9);
    assert.strictEqual(down.up, false, 'dead port reported down');

    console.log('lib.test: ALL OK');
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error('lib.test FAILED:', e.message);
  process.exit(1);
});
