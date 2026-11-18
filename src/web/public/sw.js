// file-share service worker: streams received files into the browser's download manager.
// The page opens a download with {t:'fs-dl', id, name, size, mime} + a MessagePort, then loads
// /__dl/<id>/<name> in a hidden iframe. This worker answers that request with a ReadableStream fed by the
// page over the port, one chunk at a time, acknowledging each chunk once there is room (backpressure).
// Nothing else is intercepted or cached.

const downloads = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.t !== 'fs-dl' || typeof data.id !== 'string' || !event.ports[0]) return;
  const port = event.ports[0];
  const id = data.id;
  let controller;
  let ackPending = false;

  const stream = new ReadableStream(
    {
      start(c) {
        controller = c;
      },
      pull() {
        if (ackPending) {
          ackPending = false;
          port.postMessage({ t: 'ack' });
        }
      },
      cancel() {
        downloads.delete(id);
        port.postMessage({ t: 'cancel' });
      },
    },
    { highWaterMark: 4 * 1024 * 1024, size: (chunk) => chunk.byteLength },
  );

  port.onmessage = (message) => {
    const m = message.data;
    if (!m) return;
    if (m.t === 'chunk') {
      controller.enqueue(m.chunk);
      if (controller.desiredSize > 0) port.postMessage({ t: 'ack' });
      else ackPending = true;
    } else if (m.t === 'end') {
      controller.close();
      downloads.delete(id);
    } else if (m.t === 'abort') {
      try {
        controller.error(new Error('aborted'));
      } catch {
        // already closed
      }
      downloads.delete(id);
    }
  };

  downloads.set(id, {
    stream,
    port,
    name: String(data.name || 'download'),
    size: Number.isSafeInteger(data.size) ? data.size : -1,
    mime: String(data.mime || 'application/octet-stream'),
  });
  // Forget downloads that are never requested.
  setTimeout(() => {
    const entry = downloads.get(id);
    if (entry && !entry.started) downloads.delete(id);
  }, 30_000);
  port.postMessage({ t: 'ready' });
});

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__dl/')) return;
  const id = url.pathname.split('/')[2];
  const entry = downloads.get(id);
  if (!entry || entry.started) {
    event.respondWith(new Response('This download is no longer available.', { status: 404 }));
    return;
  }
  entry.started = true;
  entry.port.postMessage({ t: 'started' });
  const headers = new Headers({
    'Content-Type': entry.mime,
    'Content-Disposition': contentDisposition(entry.name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'Cache-Control': 'no-store',
  });
  if (entry.size >= 0) headers.set('Content-Length', String(entry.size));
  event.respondWith(new Response(entry.stream, { headers }));
});
