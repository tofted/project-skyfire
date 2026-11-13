// Skyfire local server (Node.js): serves this folder on 127.0.0.1 and opens the game in the browser.
//   node serve.mjs [--port=8187] [--no-open]
// Same behaviour as serve.py, for computers that have Node.js but no Python.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const arg = (name) => process.argv.find((a) => a === name || a.startsWith(name + '='));
const START = Number((arg('--port') || '').split('=')[1]) || 8187;
const NO_OPEN = !!arg('--no-open');
const QUERY = arg('--touch') ? '?touch=1' : '';                // --touch: the touch-screen layout

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', fs.existsSync('/Applications/Google Chrome.app') ? ['-a', 'Google Chrome', url] : [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function isSkyfire(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/index.html`, { signal: AbortSignal.timeout(2000) });
    return (await r.text()).includes('Riders of the Cloud Sea');
  } catch { return false; }
}

function handler(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  });
}

const listen = (port) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.once('error', () => resolve(null));
  server.listen(port, '127.0.0.1', () => resolve(server));
});

for (let port = START; port < START + 20; port++) {
  if (await isSkyfire(port)) {
    console.log(`Skyfire is already running at http://127.0.0.1:${port}/`);
    if (!NO_OPEN) openBrowser(`http://127.0.0.1:${port}/${QUERY}`);
    process.exit(0);
  }
  if (await listen(port)) {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Skyfire is running at ${url}`);
    console.log('Keep this window open while you play. Close it (or press Ctrl+C) to stop.');
    if (!NO_OPEN) openBrowser(url + QUERY);
    break;
  }
  if (port === START + 19) { console.error('Could not find a free port for the Skyfire server.'); process.exit(1); }
}
