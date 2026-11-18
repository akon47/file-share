import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { LIMITS, type ServerMessage } from '../shared/protocol.js';
import { loadConfig } from './config.js';
import { Hub } from './hub.js';
import { clientIp, networkKey } from './ip.js';
import { log } from './log.js';
import { StaticSite } from './static.js';

const config = loadConfig();
const startedAt = Date.now();

function loadSigningKey(dataDir: string | null): Buffer {
  if (!dataDir) return randomBytes(32);
  const file = path.join(dataDir, 'signing.key');
  try {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url');
    if (key.length >= 32) return key;
  } catch {
    // first start
  }
  const key = randomBytes(32);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, key.toString('base64url') + '\n', { mode: 0o600 });
  log.info('created signing key', { file });
  return key;
}

const hub = new Hub({
  iceServers: config.iceServers,
  resumeGraceMs: config.resumeGraceMs,
  signingKey: loadSigningKey(config.dataDir),
});
const site = new StaticSite(config.staticDir);

// ---- HTTP ----

function securityHeaders(req: IncomingMessage): Record<string, string> {
  const host = String(req.headers.host ?? '');
  const wsHost = /^[a-z0-9.-]+(:\d+)?$/i.test(host)
    ? ` wss://${host}${config.trustedProxy ? '' : ` ws://${host}`}`
    : '';
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://cdn.jsdelivr.net",
    "font-src 'self' https://cdn.jsdelivr.net data:",
    "img-src 'self' data: blob:",
    `connect-src 'self'${wsHost}`,
    "worker-src 'self'",
    "frame-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

const server = createServer((req, res) => {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === '/healthz') {
    json(res, 200, {
      status: 'ok',
      version: config.version,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      ...hub.stats,
    });
    return;
  }
  if (pathname.includes('..') || pathname.includes('\0')) {
    res.writeHead(400).end();
    return;
  }
  const headers = securityHeaders(req);
  if (site.serve(req, res, pathname, headers)) return;
  res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

// ---- WebSocket signaling ----

interface LiveSocket extends WebSocket {
  alive?: boolean;
}

const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes, perMessageDeflate: false });
const connectionsPerIp = new Map<string, number>();

function reject(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname !== '/ws') return reject(socket, '404 Not Found');
  const origin = String(req.headers.origin ?? '');
  if (config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
    return reject(socket, '403 Forbidden');
  }
  const ip = clientIp(req, config.trustedProxy);
  const count = connectionsPerIp.get(ip) ?? 0;
  if (count >= config.maxConnectionsPerIp) return reject(socket, '429 Too Many Requests');

  wss.handleUpgrade(req, socket, head, (ws: LiveSocket) => {
    connectionsPerIp.set(ip, (connectionsPerIp.get(ip) ?? 0) + 1);
    ws.alive = true;
    const session = hub.connect(
      {
        send(message: ServerMessage) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        },
        close(code: number, reason: string) {
          ws.close(code, reason);
        },
      },
      { ip, network: networkKey(ip) },
    );
    const helloTimer = setTimeout(() => {
      if (!session.ready) ws.close(1008, 'hello timeout');
    }, 10_000);

    ws.on('pong', () => {
      ws.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        ws.close(1003, 'text only');
        return;
      }
      session.handle(data.toString());
    });
    ws.on('close', (code) => {
      clearTimeout(helloTimer);
      const left = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (left <= 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, left);
      // 1000 / 1001: the page closed or reloaded on purpose. Anything else is a drop the browser may come back from.
      session.closed(code === 1000 || code === 1001);
    });
    ws.on('error', () => ws.terminate());
  });
});

const heartbeat = setInterval(() => {
  for (const client of wss.clients as Set<LiveSocket>) {
    if (!client.alive) {
      client.terminate();
      continue;
    }
    client.alive = false;
    client.ping();
  }
  hub.sweep();
}, 25_000);

let lastStats = '';
const statsTimer = setInterval(() => {
  const stats = JSON.stringify(hub.stats);
  if (stats !== lastStats) log.info('stats', hub.stats);
  lastStats = stats;
}, 10 * 60_000);
statsTimer.unref();

server.listen(config.port, config.host, () => {
  log.info('file-share listening', {
    port: config.port,
    version: config.version,
    staticFiles: site.size,
    trustedProxy: config.trustedProxy,
  });
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  clearInterval(heartbeat);
  // 1012 = service restart: browsers reconnect and restore their shares.
  for (const client of wss.clients) client.close(1012, 'restart');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
