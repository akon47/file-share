import { CHUNK_SIZE, type Channel } from './channel';
import type { Sink, FileWriter } from './save';

// File streaming over a data channel. The sender sends, in order:
//   {t:'file', id, size, offset}  <binary chunks...>  {t:'file-end', id}   ... for each requested file, then {t:'done'}
// The receiver writes chunks to a Sink and periodically sends {t:'ack', bytes} for the bytes it has written,
// and the sender never runs more than WINDOW bytes ahead of those acks.

export const PROTOCOL = 1;
const WINDOW = 16 * 1024 * 1024;
const READ_BLOCK = 2 * 1024 * 1024;
const ACK_EVERY = 1024 * 1024;

export interface FileMeta {
  id: number;
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

export function describeFiles(files: File[]): FileMeta[] {
  return files.map((file, id) => ({
    id,
    name: file.name || `file-${id + 1}`,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  }));
}

export function totalSize(files: Array<{ size: number }>): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

/** Validates a manifest received from the other side. */
export function cleanManifest(value: unknown): FileMeta[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100_000) return null;
  const files: FileMeta[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const f = item as Partial<FileMeta>;
    if (!Number.isInteger(f.id) || typeof f.name !== 'string' || !Number.isSafeInteger(f.size) || f.size! < 0)
      return null;
    files.push({
      id: f.id!,
      name: safeFileName(f.name),
      size: f.size!,
      type: typeof f.type === 'string' ? f.type.slice(0, 128) : '',
      lastModified: Number.isFinite(f.lastModified) ? Number(f.lastModified) : Date.now(),
    });
  }
  return files;
}

/** No paths, no control characters, no reserved names — the name goes into a download. */
export function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean)) clean = `_${clean}`;
  return [...clean].slice(0, 200).join('') || 'file';
}

export class TransferCancelled extends Error {
  constructor(message = 'cancelled') {
    super(message);
  }
}

/** Where an interrupted transfer continues: inside file `id`, after `offset` bytes. */
export interface ResumePoint {
  id: number;
  offset: number;
}

export function cleanResumePoint(
  value: unknown,
  files: Array<{ size: number } | undefined>,
  ids: number[],
): ResumePoint | null {
  if (!value || typeof value !== 'object') return null;
  const { id, offset } = value as Partial<ResumePoint>;
  if (!Number.isInteger(id) || !Number.isSafeInteger(offset) || !ids.includes(id!)) return null;
  const size = files[id!]?.size ?? -1;
  return offset! >= 0 && offset! <= size ? { id: id!, offset: offset! } : null;
}

/**
 * Sender: stream `ids` (in that order) from `files` (indexed by FileMeta.id), optionally continuing from `from`.
 * `onProgress` gets the bytes done for the whole request, including what was sent before an interruption.
 */
export async function sendFiles(
  channel: Channel,
  files: File[],
  ids: number[],
  onProgress: (doneBytes: number) => void,
  signal?: AbortSignal,
  from: ResumePoint | null = null,
): Promise<void> {
  let startIndex = 0;
  let startOffset = 0;
  if (from) {
    startIndex = ids.indexOf(from.id);
    if (startIndex < 0) throw new Error('bad resume point');
    startOffset = from.offset;
  }
  let done = ids.slice(0, startIndex).reduce((sum, id) => sum + (files[id]?.size ?? 0), 0) + startOffset;
  // The ack window counts bytes on this channel only (the receiver re-bases its acks on a new channel).
  let sentHere = 0;
  channel.acked = 0;
  onProgress(done);
  for (let i = startIndex; i < ids.length; i++) {
    const id = ids[i]!;
    const file = files[id];
    if (!file) throw new Error(`unknown file ${id}`);
    const begin = i === startIndex ? startOffset : 0;
    channel.send({ t: 'file', id, size: file.size, offset: begin });
    for (let offset = begin; offset < file.size; offset += READ_BLOCK) {
      const block = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + READ_BLOCK)).arrayBuffer());
      for (let pos = 0; pos < block.byteLength; pos += CHUNK_SIZE) {
        if (signal?.aborted) throw new TransferCancelled();
        const piece = block.subarray(pos, Math.min(block.byteLength, pos + CHUNK_SIZE));
        await channel.waitForWindow(sentHere, WINDOW);
        await channel.sendBinary(piece);
        sentHere += piece.byteLength;
        done += piece.byteLength;
        onProgress(done);
      }
    }
    channel.send({ t: 'file-end', id });
  }
  channel.send({ t: 'done' });
  await channel.flush();
}

/**
 * Receiver: feed it the channel's messages; `done` settles when the last file is written (or it fails).
 * After a dropped connection, `rebind()` it to the new channel and ask the sender to continue from `position()`.
 */
export class FileReceiver {
  readonly done: Promise<void>;
  received = 0;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;
  private queue: Promise<void> = Promise.resolve();
  private current: { meta: FileMeta; writer: FileWriter; received: number } | null = null;
  private nextIndex = 0;
  private ackBase = 0;
  private lastAck = 0;
  private failed = false;
  private finished = false;
  private readonly expected: FileMeta[];

  constructor(
    private channel: Channel,
    files: FileMeta[],
    ids: number[],
    private readonly sink: Sink,
    private readonly onProgress: (receivedBytes: number) => void,
  ) {
    const byId = new Map(files.map((f) => [f.id, f]));
    this.expected = ids.map((id) => byId.get(id)).filter((f): f is FileMeta => !!f);
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.done.catch(() => undefined);
  }

  get ids(): number[] {
    return this.expected.map((f) => f.id);
  }

  get settled(): boolean {
    return this.finished || this.failed;
  }

  /** Returns true if the message belonged to the transfer. */
  handle(message: { t: string } & Record<string, unknown>): boolean {
    if (!['file', 'file-end', 'done', 'cancel'].includes(message.t)) return false;
    this.enqueue(() => this.process(message));
    return true;
  }

  handleBinary(data: ArrayBuffer): void {
    this.enqueue(() => this.write(new Uint8Array(data)));
  }

  /** Continue on a new connection; acks restart from zero there. */
  rebind(channel: Channel): void {
    this.channel = channel;
    this.ackBase = this.received;
    this.lastAck = this.received;
  }

  /** Where to continue, once everything that already arrived has been written. */
  async position(): Promise<ResumePoint> {
    await this.queue;
    if (this.current) return { id: this.current.meta.id, offset: this.current.received };
    const next = this.expected[this.nextIndex] ?? this.expected[this.expected.length - 1]!;
    return { id: next.id, offset: 0 };
  }

  fail(error: unknown): void {
    if (this.failed || this.finished) return;
    this.failed = true;
    this.sink.abort(error);
    this.rejectDone(error);
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(() => (this.failed || this.finished ? undefined : task()))
      .catch((error) => this.fail(error));
  }

  private async process(message: { t: string } & Record<string, unknown>): Promise<void> {
    switch (message.t) {
      case 'file': {
        const offset = Number(message.offset ?? 0);
        if (this.current) {
          // A resumed transfer continues inside the file we were writing.
          if (message.id === this.current.meta.id && offset === this.current.received) return;
          throw new Error('file not finished');
        }
        const meta = this.expected[this.nextIndex];
        if (!meta || message.id !== meta.id || message.size !== meta.size || offset !== 0) {
          throw new Error('unexpected file');
        }
        this.nextIndex++;
        this.current = { meta, writer: await this.sink.openFile(meta), received: 0 };
        return;
      }
      case 'file-end': {
        const current = this.current;
        if (!current || message.id !== current.meta.id) throw new Error('unexpected file end');
        if (current.received !== current.meta.size) throw new Error('size mismatch');
        await current.writer.close();
        this.current = null;
        this.ack(true);
        if (this.nextIndex === this.expected.length) {
          // Everything is written; the closing {t:'done'} may never come if the connection drops right now.
          await this.sink.finish();
          this.finished = true;
          this.resolveDone();
        }
        return;
      }
      case 'done':
        return;
      case 'cancel':
        throw new TransferCancelled('remote cancelled');
    }
  }

  private async write(chunk: Uint8Array): Promise<void> {
    const current = this.current;
    if (!current) throw new Error('data outside a file');
    // Read the length first: the sink may transfer (detach) the buffer to the service worker.
    const length = chunk.byteLength;
    if (current.received + length > current.meta.size) throw new Error('too much data');
    await current.writer.write(chunk);
    current.received += length;
    this.received += length;
    this.onProgress(this.received);
    this.ack(false);
  }

  private ack(force: boolean): void {
    if (force || this.received - this.lastAck >= ACK_EVERY) {
      this.lastAck = this.received;
      this.channel.sendAck(this.received - this.ackBase);
    }
  }
}
