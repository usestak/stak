/*
 * Minimal static server for the passkey dogfood page (SPIKE ONLY).
 *
 * WebAuthn requires a secure context; http://localhost qualifies. Run:
 *   node experiments/memory-remote/dogfood/server.mjs
 * then open the printed http://localhost:<port> URL in Chrome.
 *
 * No dependencies. Serves only this folder's index.html and passkey.js.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4599);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const requested =
    req.url === '/' || !req.url ? '/index.html' : req.url.split('?')[0];
  const name = path.basename(requested); // no traversal; flat folder
  const file = path.join(here, name);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Stack Memory passkey dogfood: http://localhost:${PORT}`);
});
