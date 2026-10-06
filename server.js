// DUEL — real-time multiplayer trading simulator (solo, on a local network, or online).
// Dependency-free server: static UI, live game streams (SSE) and orders (POST).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const game = require('./lib/game');
const { feedStatus } = require('./lib/feeds');

const PORT = Number(process.env.PORT) || 3001;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// This machine's local network addresses, used to invite a friend on the same Wi-Fi.
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  }
  return out;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  if (!pathname.startsWith('/api/')) return serveStatic(req, res);
  const m = pathname.match(/^\/api\/game\/(\d{4})\/(stream|action)$/);
  try {
    if (pathname === '/api/status') return sendJson(res, 200, { feeds: feedStatus() });
    if (pathname === '/api/game/lan') return sendJson(res, 200, { urls: lanUrls(), local: isLocal(req) });
    if (pathname === '/api/game/create' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, 200, await game.createGame({ name: b.name, assetId: b.asset, duration: b.duration, mode: b.mode, solo: b.solo === true }));
    }
    if (pathname === '/api/game/join' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      return sendJson(res, 200, game.joinGame(String(b.code || '').trim(), b.name));
    }
    if (m && m[2] === 'stream') {
      if (!game.stream(m[1], searchParams.get('token'), res)) sendJson(res, 404, { error: 'Game not found.' });
      return;
    }
    if (m && m[2] === 'action' && req.method === 'POST') {
      return sendJson(res, 200, await game.action(m[1], JSON.parse((await readBody(req)) || '{}')));
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  DUEL · trading simulator → http://localhost:${PORT}`);
  const lan = lanUrls();
  if (lan.length) console.log(`  On the same Wi-Fi: ${lan.join('  ')}`);
  console.log('');
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`\n  Port ${PORT} is already in use: DUEL may already be running (press Ctrl + C in the other terminal).\n`);
  else console.error(e);
  process.exit(1);
});
