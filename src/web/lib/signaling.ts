import { reactive, watch } from 'vue';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type PeerInfo,
  type ServerMessage,
  type ShareSummary,
  type SignalData,
} from '@shared/protocol';
import { detectDevice } from './device';
import { settings } from './settings';

// One WebSocket to the signaling server for the whole app. Reconnects with backoff and resumes the same
// peer id (and shares) when the server still remembers it.

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export class RequestError extends Error {
  constructor(readonly code: ErrorCode | 'timeout' | 'offline') {
    super(code);
  }
}

type SignalHandler = (from: PeerInfo, data: SignalData) => void;
type WelcomeHandler = (resumed: boolean) => void;
type ErrorHandler = (code: ErrorCode, message?: string) => void;

interface Pending {
  resolve: (message: ServerMessage) => void;
  reject: (error: RequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const device = detectDevice();

export const net = reactive({
  status: 'connecting' as ConnectionStatus,
  myId: '',
  iceServers: [] as RTCIceServer[],
  peers: [] as PeerInfo[],
  shares: [] as ShareSummary[],
  /** The server asked for a reload (protocol version changed). */
  outdated: false,
});

class Signaling {
  private ws: WebSocket | null = null;
  private resume: string | undefined;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRid = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly signalHandlers = new Set<SignalHandler>();
  private readonly welcomeHandlers = new Set<WelcomeHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readyWaiters: Array<() => void> = [];
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.open();
    window.addEventListener('online', () => this.reconnectSoon(0));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && net.status === 'offline') this.reconnectSoon(0);
    });
    watch(
      () => [settings.name, settings.visible] as const,
      ([name, visible]) => this.send({ t: 'update', name, visible }),
    );
  }

  private open(): void {
    if (net.outdated) return;
    net.status = 'connecting';
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          v: PROTOCOL_VERSION,
          name: settings.name,
          device,
          visible: settings.visible,
          resume: this.resume,
        } satisfies ClientMessage),
      );
    };
    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      this.receive(message);
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      net.status = 'offline';
      for (const [rid, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new RequestError('offline'));
        this.pending.delete(rid);
      }
      if (event.code === 4000) {
        net.outdated = true;
        return;
      }
      this.reconnectSoon();
    };
  }

  private reconnectSoon(delay?: number): void {
    if (this.reconnectTimer || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    const wait = delay ?? Math.min(10_000, 500 * 2 ** this.attempt) * (0.8 + Math.random() * 0.4);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, wait);
  }

  private receive(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome':
        this.attempt = 0;
        this.resume = message.resume;
        net.myId = message.id;
        net.iceServers = message.iceServers as RTCIceServer[];
        net.status = 'online';
        for (const handler of this.welcomeHandlers) handler(message.resumed);
        for (const waiter of this.readyWaiters.splice(0)) waiter();
        return;
      case 'lan':
        net.peers = message.peers.filter((peer) => peer.id !== net.myId);
        net.shares = message.shares;
        return;
      case 'signal':
        for (const handler of this.signalHandlers) handler(message.peer, message.data);
        return;
      case 'error':
        if (message.code === 'version') net.outdated = true;
        if (message.rid !== undefined) {
          const pending = this.pending.get(message.rid);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.rid);
            pending.reject(new RequestError(message.code));
            return;
          }
        }
        for (const handler of this.errorHandlers) handler(message.code, message.message);
        return;
      default:
        if ('rid' in message) {
          const pending = this.pending.get(message.rid);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.rid);
            pending.resolve(message);
          }
        }
    }
  }

  send(message: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || net.status !== 'online') return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  /** Resolves once connected (immediately if already online). */
  ready(): Promise<void> {
    if (net.status === 'online') return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  /** Sends a message carrying a fresh `rid` and waits for the reply with the same rid. */
  async request<T extends ServerMessage>(build: (rid: number) => ClientMessage, timeoutMs = 10_000): Promise<T> {
    await this.ready();
    const rid = this.nextRid++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new RequestError('timeout'));
      }, timeoutMs);
      this.pending.set(rid, { resolve: resolve as (m: ServerMessage) => void, reject, timer });
      if (!this.send(build(rid))) {
        clearTimeout(timer);
        this.pending.delete(rid);
        reject(new RequestError('offline'));
      }
    });
  }

  signal(to: string, data: SignalData): boolean {
    return this.send({ t: 'signal', to, data });
  }

  onSignal(handler: SignalHandler): () => void {
    this.signalHandlers.add(handler);
    return () => this.signalHandlers.delete(handler);
  }

  onWelcome(handler: WelcomeHandler): () => void {
    this.welcomeHandlers.add(handler);
    return () => this.welcomeHandlers.delete(handler);
  }

  onError(handler: ErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }
}

export const signaling = new Signaling();
