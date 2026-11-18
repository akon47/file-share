// A thin wrapper over one RTCDataChannel: JSON control messages as strings, file data as binary frames,
// with backpressure (bufferedAmount) and an acknowledged-bytes window so a slow receiver (or a slow disk
// behind a streaming download) never makes the sender queue gigabytes in memory.

export const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1 * 1024 * 1024;

type JsonHandler = (message: Record<string, unknown> & { t: string }) => void;
type BinaryHandler = (data: ArrayBuffer) => void;

export class Channel {
  private jsonHandler: JsonHandler | null = null;
  private binaryHandler: BinaryHandler | null = null;
  private backlog: Array<string | ArrayBuffer> = [];
  private drainWaiters: Array<() => void> = [];
  private ackWaiters: Array<() => void> = [];
  private closeHandlers = new Set<() => void>();
  /** Bytes the remote side has confirmed writing (see sendAck / waitForWindow). */
  acked = 0;
  closed = false;

  constructor(readonly dc: RTCDataChannel) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    dc.onbufferedamountlow = () => this.wakeDrain();
    dc.onmessage = (event: MessageEvent<string | ArrayBuffer>) => this.dispatch(event.data);
    dc.onclose = () => this.handleClose();
    dc.onerror = () => this.handleClose();
  }

  /** Install handlers; anything that arrived before is delivered now, in order. */
  listen(onJson: JsonHandler, onBinary: BinaryHandler = () => undefined): void {
    this.jsonHandler = onJson;
    this.binaryHandler = onBinary;
    const backlog = this.backlog;
    this.backlog = [];
    for (const item of backlog) this.dispatch(item);
  }

  onClose(handler: () => void): () => void {
    if (this.closed) handler();
    else this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  private dispatch(data: string | ArrayBuffer): void {
    if (!this.jsonHandler) {
      this.backlog.push(data);
      return;
    }
    if (typeof data === 'string') {
      let message: unknown;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message && typeof message === 'object' && typeof (message as { t?: unknown }).t === 'string') {
        if ((message as { t: string }).t === 'ack') {
          const bytes = Number((message as { bytes?: unknown }).bytes);
          if (Number.isFinite(bytes) && bytes > this.acked) {
            this.acked = bytes;
            this.wakeAcks();
          }
          return;
        }
        this.jsonHandler(message as Record<string, unknown> & { t: string });
      }
    } else {
      this.binaryHandler?.(data);
    }
  }

  send(message: { t: string } & Record<string, unknown>): void {
    if (this.closed || this.dc.readyState !== 'open') return;
    this.dc.send(JSON.stringify(message));
  }

  async sendBinary(data: Uint8Array): Promise<void> {
    if (this.dc.bufferedAmount > HIGH_WATER) await this.drained();
    if (this.closed || this.dc.readyState !== 'open') throw new Error('channel closed');
    this.dc.send(data as Uint8Array<ArrayBuffer>);
  }

  /** Receiver side: confirm how many bytes were written so far. */
  sendAck(bytes: number): void {
    this.send({ t: 'ack', bytes });
  }

  /** Sender side: wait until no more than `window` bytes are unconfirmed. */
  async waitForWindow(sent: number, window: number): Promise<void> {
    while (!this.closed && sent - this.acked > window) {
      await new Promise<void>((resolve) => this.ackWaiters.push(resolve));
    }
    if (this.closed) throw new Error('channel closed');
  }

  /** Resolves once everything queued has left (used before closing after the last chunk). */
  async flush(): Promise<void> {
    while (!this.closed && this.dc.bufferedAmount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  close(): void {
    try {
      this.dc.close();
    } catch {
      // ignore
    }
    this.handleClose();
  }

  private drained(): Promise<void> {
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  private wakeDrain(): void {
    for (const waiter of this.drainWaiters.splice(0)) waiter();
  }

  private wakeAcks(): void {
    for (const waiter of this.ackWaiters.splice(0)) waiter();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.wakeDrain();
    this.wakeAcks();
    for (const handler of this.closeHandlers) handler();
    this.closeHandlers.clear();
  }
}
