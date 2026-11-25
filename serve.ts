// Sizzle Station — a tiny local server for playing the game while developing.
//
//   node serve.ts            serves game/ on http://localhost:8080
//   node serve.ts --port 9000   serves it on port 9000 instead
//
// It only reads files under game/ and only listens on the loopback address,
// so it is a development convenience, not a public web server. Requests for
// anything outside game/ are refused, unknown files get a 404, and files are
// streamed straight from disk with a no-store cache header so a fresh edit
// shows up on the next reload.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The game folder, resolved once at startup.
const GAME_ROOT = resolve(fileURLToPath(new URL('./game', import.meta.url)));

// The content type for each file kind a browser game can need. Anything not
// listed here falls back to a generic binary download.
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};

/** The port to listen on: --port N when given and sane, else 8080. */
function pickPort(): number {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--port');
  if (at === -1) return 8080;
  const wanted = Number(argv[at + 1]);
  return Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : 8080;
}

const port = pickPort();

createServer((req, res) => {
  const raw = new URL(req.url ?? '/', 'http://127.0.0.1');
  let path: string;
  try {
    path = decodeURIComponent(raw.pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(join(GAME_ROOT, normalize(path)));
  if (file !== GAME_ROOT && !file.startsWith(GAME_ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let size: number;
  try {
    const info = statSync(file);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size,
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Sizzle Station is on http://localhost:${port}`);
});
