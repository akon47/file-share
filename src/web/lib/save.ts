import { makeZip, predictLength } from 'client-zip';
import { isWebKit } from './device';
import type { FileMeta } from './transfer';

// Where received bytes go.
//  - Streaming download through the service worker (public/sw.js): bytes go straight to the browser's
//    download manager and to disk as they arrive, so file size is not limited by memory. Chromium and Firefox.
//  - Memory fallback (Safari / iOS, or when the service worker is not in control): bytes are collected in a
//    Blob and saved at the end.
// Several files are packed on the fly into one uncompressed .zip (client-zip), so one download holds them all.

export interface FileWriter {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface Sink {
  readonly mode: 'stream' | 'memory';
  openFile(meta: FileMeta): Promise<FileWriter>;
  /** Resolves when the download has been fully handed to the browser. */
  finish(): Promise<void>;
  abort(reason?: unknown): void;
}

const PART_BYTES = 64 * 1024 * 1024;

export function canStreamDownloads(): boolean {
  return !isWebKit() && 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
}

/** Above this, the memory fallback is risky (mostly iOS). */
export const MEMORY_WARNING_BYTES = 1.5 * 1024 * 1024 * 1024;

export function archiveName(senderName: string): string {
  const stamp = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
  return `${senderName.replace(/[\\/:*?"<>|]/g, '_')}-${date}.zip`;
}

/** Zip entries need unique names: "a.txt", "a (2).txt", ... */
function uniqueNames(files: FileMeta[]): string[] {
  const seen = new Map<string, number>();
  return files.map((file) => {
    const key = file.name.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 1) return file.name;
    const dot = file.name.lastIndexOf('.');
    return dot > 0 ? `${file.name.slice(0, dot)} (${count})${file.name.slice(dot)}` : `${file.name} (${count})`;
  });
}

export function createSink(files: FileMeta[], zipName: string): Sink {
  const pipes = files.map(
    () =>
      new TransformStream<Uint8Array, Uint8Array>(
        undefined,
        new ByteLengthQueuingStrategy({ highWaterMark: 2 * 1024 * 1024 }),
      ),
  );
  const indexById = new Map(files.map((file, index) => [file.id, index]));
  const single = files.length === 1;

  let output: ReadableStream<Uint8Array>;
  let name: string;
  let size: number;
  let mime: string;
  if (single) {
    output = pipes[0]!.readable;
    name = files[0]!.name;
    size = files[0]!.size;
    mime = files[0]!.type || 'application/octet-stream';
  } else {
    const names = uniqueNames(files);
    const entries = files.map((file, index) => ({
      name: names[index]!,
      lastModified: new Date(file.lastModified),
      size: file.size,
    }));
    size = Number(predictLength(entries));
    output = makeZip(entries.map((entry, index) => ({ ...entry, input: pipes[index]!.readable })));
    name = zipName;
    mime = 'application/zip';
  }

  const controller = new AbortController();
  let mode: Sink['mode'] = canStreamDownloads() ? 'stream' : 'memory';
  const saving = (async () => {
    if (mode === 'stream') {
      try {
        await saveViaServiceWorker(output, name, size, mime, controller.signal);
        return;
      } catch (error) {
        // The worker did not pick up the download before any byte was read: fall back to memory.
        if (!(error instanceof ServiceWorkerUnavailable)) throw error;
        mode = 'memory';
      }
    }
    await saveInMemory(output, name, mime, controller.signal);
  })();
  // If the user cancels the browser download, the writers below start failing and the transfer aborts.
  let savingError: unknown = null;
  saving.catch((error: unknown) => {
    savingError = error;
    for (const pipe of pipes) void pipe.writable.abort(error).catch(() => undefined);
  });

  return {
    get mode() {
      return mode;
    },
    async openFile(meta) {
      const index = indexById.get(meta.id);
      if (index === undefined) throw new Error('unknown file');
      const writer = pipes[index]!.writable.getWriter();
      return {
        async write(chunk) {
          if (savingError) throw savingError;
          await writer.ready;
          void writer.write(chunk).catch(() => undefined);
        },
        async close() {
          await writer.ready;
          await writer.close();
        },
      };
    },
    async finish() {
      await saving;
    },
    abort(reason) {
      controller.abort(reason);
      for (const pipe of pipes) void pipe.writable.abort(reason).catch(() => undefined);
    },
  };
}

class ServiceWorkerUnavailable extends Error {}

function once(port: MessagePort, type: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.removeEventListener('message', listener);
      reject(new ServiceWorkerUnavailable(`no ${type}`));
    }, timeoutMs);
    const listener = (event: MessageEvent) => {
      if (event.data?.t === type) {
        clearTimeout(timer);
        port.removeEventListener('message', listener);
        resolve();
      }
    };
    port.addEventListener('message', listener);
  });
}

async function saveViaServiceWorker(
  source: ReadableStream<Uint8Array>,
  name: string,
  size: number,
  mime: string,
  signal: AbortSignal,
): Promise<void> {
  const worker = navigator.serviceWorker.controller;
  if (!worker) throw new ServiceWorkerUnavailable('no controller');
  const id = crypto.randomUUID();
  const { port1: port, port2 } = new MessageChannel();
  port.start();
  const ready = once(port, 'ready', 3000);
  worker.postMessage({ t: 'fs-dl', id, name, size, mime }, [port2]);
  await ready;

  const started = once(port, 'started', 6000);
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = `/__dl/${id}/${encodeURIComponent(name)}`;
  document.body.append(frame);
  try {
    await started;
  } catch (error) {
    port.postMessage({ t: 'abort' });
    frame.remove();
    throw error;
  }

  // Message events on the worker's global scope keep it alive during long downloads.
  const keepAlive = setInterval(() => navigator.serviceWorker.controller?.postMessage({ t: 'fs-ping' }), 10_000);
  const reader = source.getReader();
  let ackWaiter: (() => void) | null = null;
  let cancelled = false;
  port.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.t === 'ack') {
      ackWaiter?.();
      ackWaiter = null;
    } else if (event.data?.t === 'cancel') {
      cancelled = true;
      ackWaiter?.();
      ackWaiter = null;
    }
  });
  const onAbort = () => {
    port.postMessage({ t: 'abort' });
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (cancelled) throw new DOMException('Download cancelled', 'AbortError');
      const chunk = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value : value.slice();
      const acked = new Promise<void>((resolve) => (ackWaiter = resolve));
      port.postMessage({ t: 'chunk', chunk }, [chunk.buffer]);
      await acked;
      if (cancelled) throw new DOMException('Download cancelled', 'AbortError');
    }
    port.postMessage({ t: 'end' });
  } catch (error) {
    port.postMessage({ t: 'abort' });
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(keepAlive);
    signal.removeEventListener('abort', onAbort);
    setTimeout(() => {
      frame.remove();
      port.close();
    }, 60_000);
  }
}

async function saveInMemory(
  source: ReadableStream<Uint8Array>,
  name: string,
  mime: string,
  signal: AbortSignal,
): Promise<void> {
  const reader = source.getReader();
  const parts: Blob[] = [];
  let chunks: Uint8Array[] = [];
  let pending = 0;
  const onAbort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      pending += value.byteLength;
      // Collapse into Blobs as we go; browsers can page large Blobs out of the JS heap.
      if (pending >= PART_BYTES) {
        parts.push(new Blob(chunks as BlobPart[]));
        chunks = [];
        pending = 0;
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) throw signal.reason;
  saveBlob(new Blob([...parts, ...(chunks as BlobPart[])], { type: mime }), name);
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
}
