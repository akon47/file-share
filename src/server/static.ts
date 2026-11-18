import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// The built web app is small (a few hundred KB), so it is loaded into memory once at startup with
// gzip / brotli variants precomputed. index.html is served for every app route (SPA).

interface Asset {
  body: Buffer;
  gzip?: Buffer;
  br?: Buffer;
  type: string;
  etag: string;
  cacheControl: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt']);

export class StaticSite {
  private readonly assets = new Map<string, Asset>();

  constructor(private readonly root: string) {
    try {
      if (statSync(root).isDirectory()) this.load(root);
    } catch {
      // No built web app (development: Vite serves it). Only /healthz and /ws are available.
    }
  }

  get size(): number {
    return this.assets.size;
  }

  private load(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.load(full);
        continue;
      }
      const urlPath = '/' + path.relative(this.root, full).split(path.sep).join('/');
      const ext = path.extname(entry.name).toLowerCase();
      const body = readFileSync(full);
      const asset: Asset = {
        body,
        type: TYPES[ext] ?? 'application/octet-stream',
        etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`,
        cacheControl: cacheControlFor(urlPath),
      };
      if (COMPRESSIBLE.has(ext) && body.length > 1024) {
        asset.gzip = gzipSync(body, { level: 9 });
        asset.br = brotliCompressSync(body, {
          params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: body.length },
        });
      }
      this.assets.set(urlPath, asset);
    }
  }

  /** Returns false when nothing matched (caller sends 404). */
  serve(req: IncomingMessage, res: ServerResponse, pathname: string, headers: Record<string, string>): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let asset = this.assets.get(pathname);
    // App routes (no file extension) get index.html; unknown files 404.
    if (!asset && !path.posix.extname(pathname)) asset = this.assets.get('/index.html');
    if (!asset) return false;

    const common: Record<string, string> = {
      ...headers,
      'Content-Type': asset.type,
      'Cache-Control': asset.cacheControl,
      ETag: asset.etag,
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304, common);
      res.end();
      return true;
    }
    const accept = String(req.headers['accept-encoding'] ?? '');
    let body = asset.body;
    if (asset.br && /\bbr\b/.test(accept)) {
      body = asset.br;
      common['Content-Encoding'] = 'br';
    } else if (asset.gzip && /\bgzip\b/.test(accept)) {
      body = asset.gzip;
      common['Content-Encoding'] = 'gzip';
    }
    common['Content-Length'] = String(body.length);
    res.writeHead(200, common);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
}

function cacheControlFor(urlPath: string): string {
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (urlPath === '/index.html' || urlPath === '/sw.js' || urlPath.endsWith('.webmanifest')) return 'no-cache';
  return 'public, max-age=3600';
}
