// Serve a built client (tools/build-client.mjs output) the way CloudFront
// will: static files as themselves, extensionless paths rewritten to
// /app.html so the unified app's clean routes (/, /onboarding, /squad, …)
// survive a refresh. This is the LOCAL twin of
// infra/cloudfront/app-router-function.js — if the rewrite rule changes,
// change both.
//
//   node tools/build-client.mjs --lobby-url http://localhost:8475 --match-ws ws://localhost:8787
//   node tools/serve-client.mjs [--dir dist/client] [--port 8470]
//
// No dependencies, no cache — an honest dev loop over the real artifact.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const dir = resolve(root, args.dir ?? 'dist/client');
const port = Number(args.port ?? 8470);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** the ONE rewrite rule, mirrored by the CloudFront function */
export function rewritePath(pathname) {
  if (pathname.endsWith('/') && pathname !== '/') pathname = pathname.replace(/\/+$/, '');
  if (pathname === '/') return '/app.html';
  return /\.[a-zA-Z0-9]+$/.test(pathname) ? pathname : '/app.html';
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://local');
    const file = rewritePath(decodeURIComponent(url.pathname));
    const path = normalize(join(dir, file));
    if (!path.startsWith(dir)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

// importable for tests; a server only when run directly
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, () => {
    console.log(`client → http://localhost:${port}  (serving ${dir})`);
    console.log('extensionless paths rewrite to /app.html — the CloudFront rule, locally');
  });
}
