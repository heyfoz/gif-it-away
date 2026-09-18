#!/usr/bin/env node
// Static file server for the gif-it-to-me page.
//
// Two reasons this exists instead of opening index.html straight off disk:
//   1. ES modules and module workers are blocked on file:// by every browser.
//   2. <video> seeking needs HTTP range requests, which the usual one-line
//      static servers (python -m http.server included) do not answer. Without
//      206 responses the browser can only play forward from the start, so the
//      seek-per-frame decoder stalls.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname);
const PORT = Number(process.env.PORT || process.argv[2] || 5199);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

function resolveSafe(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const full = resolve(join(ROOT, normalize(p)));
  // Refuse anything that climbed out of the served directory.
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

createServer((req, res) => {
  const full = resolveSafe(req.url || '/');
  if (!full) {
    res.writeHead(403).end('forbidden');
    return;
  }

  let stat;
  try {
    stat = statSync(full);
    if (stat.isDirectory()) stat = statSync(join(full, 'index.html'));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }

  const type = TYPES[extname(full).toLowerCase()] || 'application/octet-stream';
  const base = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(stat.size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
      return;
    }
    res.writeHead(206, {
      ...base,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(full, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...base, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(full).pipe(res);
}).listen(PORT, () => {
  console.log(`gif-it-to-me: http://localhost:${PORT}/`);
});
