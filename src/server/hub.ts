import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  LIMITS,
  PROTOCOL_VERSION,
  isPeerId,
  isShareCode,
  isShareId,
  type ClientMessage,
  type DeviceInfo,
  type DeviceType,
  type ErrorCode,
  type IceServerLike,
  type PeerInfo,
  type ServerMessage,
  type ShareOptions,
  type ShareSummary,
  type SignalData,
} from '../shared/protocol.js';
import { KeyedLimiter, TokenBucket } from './ratelimit.js';

/** The part of a WebSocket the hub needs; tests use a fake. */
export interface Connection {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface HubOptions {
  iceServers: IceServerLike[];
  /** How long a peer whose connection dropped (not closed cleanly) keeps its id and shares. */
  resumeGraceMs: number;
  /**
   * Signs share ids so their owners can re-register them after a server restart (deploy) and keep their links
   * working. Persist it across restarts (DATA_DIR/signing.key) for that to work.
   */
  signingKey: Buffer;
  now?: () => number;
  /** Max peers / shares listed to one network (a carrier-grade NAT can put strangers together). */
  listLimit?: number;
}

interface Peer {
  id: string;
  resume: string;
  network: string;
  name: string;
  device: DeviceInfo;
  visible: boolean;
  joinedAt: number;
  conn: Connection | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  shares: Set<string>;
  /** Peers outside the network this peer may exchange signals with (linked by a share lookup). */
  links: Set<string>;
  messages: TokenBucket;
}

interface Share {
  id: string;
  code: string;
  owner: Peer;
  options: ShareOptions;
  createdAt: number;
}

export interface ClientContext {
  ip: string;
  network: string;
}

export interface Session {
  /** True once a valid hello was received. */
  readonly ready: boolean;
  handle(raw: string): void;
  /** clean = the browser closed the socket on purpose (tab closed / reloaded), not a network drop. */
  closed(clean: boolean): void;
}

const DEVICE_TYPES: readonly DeviceType[] = ['desktop', 'mobile', 'tablet'];
const MAX_SDP = 48 * 1024;
const MAX_CANDIDATE = 2048;

export class Hub {
  private readonly peers = new Map<string, Peer>();
  private readonly byResume = new Map<string, Peer>();
  private readonly networks = new Map<string, Set<Peer>>();
  private readonly shares = new Map<string, Share>();
  private readonly codes = new Map<string, Share>();
  private readonly lookups: KeyedLimiter;
  private readonly dirtyNetworks = new Set<string>();
  private flushScheduled = false;
  private readonly now: () => number;
  private readonly listLimit: number;

  constructor(private readonly options: HubOptions) {
    this.now = options.now ?? Date.now;
    this.listLimit = options.listLimit ?? 50;
    // Share lookups by code are the only guessable thing here: 20 at once, then one every 6 seconds per IP.
    this.lookups = new KeyedLimiter(20, 1 / 6, this.now);
  }

  get stats() {
    let online = 0;
    for (const peer of this.peers.values()) if (peer.conn) online++;
    return { peers: this.peers.size, online, shares: this.shares.size, networks: this.networks.size };
  }

  sweep(): void {
    this.lookups.sweep();
  }

  connect(conn: Connection, context: ClientContext): Session {
    let peer: Peer | null = null;

    const fail = (code: ErrorCode, rid?: number, message?: string) =>
      conn.send({ t: 'error', code, ...(rid !== undefined ? { rid } : {}), ...(message ? { message } : {}) });

    return {
      get ready() {
        return peer !== null;
      },
      handle: (raw: string) => {
        let message: ClientMessage;
        try {
          message = JSON.parse(raw) as ClientMessage;
        } catch {
          conn.close(1003, 'bad json');
          return;
        }
        if (!message || typeof message !== 'object' || typeof message.t !== 'string') {
          conn.close(1003, 'bad message');
          return;
        }

        if (!peer) {
          if (message.t !== 'hello') {
            conn.close(1008, 'hello first');
            return;
          }
          if (message.v !== PROTOCOL_VERSION) {
            fail('version', undefined, 'Please reload the page.');
            conn.close(4000, 'version');
            return;
          }
          peer = this.hello(conn, context, message);
          if (!peer) conn.close(1008, 'bad hello');
          return;
        }

        if (!peer.messages.take()) {
          fail('rate-limited');
          return;
        }
        this.dispatch(peer, context, message, fail);
      },
      closed: (clean: boolean) => {
        if (!peer || peer.conn !== conn) return;
        peer.conn = null;
        if (clean) this.remove(peer);
        else {
          peer.graceTimer = setTimeout(() => this.remove(peer!), this.options.resumeGraceMs);
          peer.graceTimer.unref?.();
        }
      },
    };
  }

  // ---- connection lifecycle ----

  private hello(
    conn: Connection,
    context: ClientContext,
    message: Extract<ClientMessage, { t: 'hello' }>,
  ): Peer | null {
    const name = cleanName(message.name);
    const device = cleanDevice(message.device);
    if (!name || !device) return null;

    let peer = typeof message.resume === 'string' ? this.byResume.get(message.resume) : undefined;
    const resumed = !!peer;
    if (peer) {
      if (peer.graceTimer) clearTimeout(peer.graceTimer);
      peer.graceTimer = null;
      if (peer.conn && peer.conn !== conn) peer.conn.close(4001, 'replaced');
      if (peer.network !== context.network) {
        this.leaveNetwork(peer);
        peer.network = context.network;
        this.joinNetwork(peer);
      }
      peer.conn = conn;
      peer.name = name;
      peer.device = device;
      peer.visible = message.visible !== false;
    } else {
      peer = {
        id: randomId(),
        resume: randomId() + randomId(),
        network: context.network,
        name,
        device,
        visible: message.visible !== false,
        joinedAt: this.now(),
        conn,
        graceTimer: null,
        shares: new Set(),
        links: new Set(),
        messages: new TokenBucket(200, 40, this.now),
      };
      this.peers.set(peer.id, peer);
      this.byResume.set(peer.resume, peer);
      this.joinNetwork(peer);
    }

    conn.send({
      t: 'welcome',
      v: PROTOCOL_VERSION,
      id: peer.id,
      resume: peer.resume,
      resumed,
      iceServers: this.options.iceServers,
    });
    // The network snapshot (including this peer) follows in the same tick via the dirty-network flush.
    this.markDirty(peer.network);
    return peer;
  }

  private remove(peer: Peer): void {
    if (peer.graceTimer) clearTimeout(peer.graceTimer);
    peer.graceTimer = null;
    for (const shareId of [...peer.shares]) this.closeShare(shareId);
    for (const linkedId of peer.links) this.peers.get(linkedId)?.links.delete(peer.id);
    peer.links.clear();
    this.leaveNetwork(peer);
    this.peers.delete(peer.id);
    this.byResume.delete(peer.resume);
  }

  private joinNetwork(peer: Peer): void {
    let members = this.networks.get(peer.network);
    if (!members) {
      members = new Set();
      this.networks.set(peer.network, members);
    }
    members.add(peer);
    this.markDirty(peer.network);
  }

  private leaveNetwork(peer: Peer): void {
    const members = this.networks.get(peer.network);
    if (!members) return;
    members.delete(peer);
    if (members.size === 0) this.networks.delete(peer.network);
    else this.markDirty(peer.network);
  }

  // ---- messages ----

  private dispatch(
    peer: Peer,
    context: ClientContext,
    message: ClientMessage,
    fail: (code: ErrorCode, rid?: number, message?: string) => void,
  ): void {
    switch (message.t) {
      case 'update': {
        if (message.name !== undefined) {
          const name = cleanName(message.name);
          if (!name) return fail('bad-request');
          peer.name = name;
        }
        if (message.visible !== undefined) peer.visible = message.visible === true;
        this.markDirty(peer.network);
        return;
      }
      case 'signal': {
        const data = cleanSignal(message.data);
        if (typeof message.to !== 'string' || !isPeerId(message.to) || !data) return fail('bad-request');
        const target = this.peers.get(message.to);
        if (target === peer) return fail('bad-request');
        if (!target) return fail('peer-offline', undefined, message.to);
        if (target.network !== peer.network && !peer.links.has(target.id)) return fail('forbidden');
        if (!target.conn) return fail('peer-offline', undefined, message.to);
        target.conn.send({ t: 'signal', from: peer.id, peer: info(peer), data });
        return;
      }
      case 'share-open': {
        const rid = cleanRid(message.rid);
        const options = cleanShareOptions(message.options);
        if (rid === null || !options) return fail('bad-request', rid ?? undefined);
        if (peer.shares.size >= LIMITS.maxSharesPerPeer) return fail('too-many-shares', rid);
        const share: Share = { id: randomId(), code: this.newCode(), owner: peer, options, createdAt: this.now() };
        this.addShare(share);
        peer.conn?.send({
          t: 'share-opened',
          rid,
          id: share.id,
          code: share.code,
          proof: this.sign(share.id, share.code),
        });
        return;
      }
      case 'share-restore': {
        const rid = cleanRid(message.rid);
        const options = cleanShareOptions(message.options);
        const { id, code, proof } = message;
        if (rid === null || !options || typeof id !== 'string' || !isShareId(id))
          return fail('bad-request', rid ?? undefined);
        if (typeof code !== 'string' || !isShareCode(code) || typeof proof !== 'string')
          return fail('bad-request', rid);
        if (!this.verify(id, code, proof)) return fail('forbidden', rid);
        const existing = this.shares.get(id);
        if (existing && existing.owner !== peer) return fail('conflict', rid);
        if (!existing) {
          if (peer.shares.size >= LIMITS.maxSharesPerPeer) return fail('too-many-shares', rid);
          // Another share took the code while this one was gone: keep the link (id) and hand out a new code.
          const freeCode = this.codes.has(code) ? this.newCode() : code;
          this.addShare({ id, code: freeCode, owner: peer, options, createdAt: this.now() });
        } else {
          existing.options = options;
          this.markDirty(peer.network);
        }
        const share = this.shares.get(id)!;
        peer.conn?.send({ t: 'share-opened', rid, id, code: share.code, proof: this.sign(id, share.code) });
        return;
      }
      case 'share-update': {
        const share = typeof message.id === 'string' ? this.shares.get(message.id) : undefined;
        const options = cleanShareOptions(message.options);
        if (!share || share.owner !== peer || !options) return fail('bad-request');
        share.options = options;
        this.markDirty(peer.network);
        return;
      }
      case 'share-close': {
        const share = typeof message.id === 'string' ? this.shares.get(message.id) : undefined;
        if (!share || share.owner !== peer) return;
        this.closeShare(share.id);
        return;
      }
      case 'share-lookup': {
        const rid = cleanRid(message.rid);
        if (rid === null) return fail('bad-request');
        if (!this.lookups.take(context.ip)) return fail('rate-limited', rid);
        let share: Share | undefined;
        if (typeof message.id === 'string' && isShareId(message.id)) share = this.shares.get(message.id);
        else if (typeof message.code === 'string' && isShareCode(message.code)) share = this.codes.get(message.code);
        else return fail('bad-request', rid);
        if (!share) return fail('not-found', rid);
        if (share.owner !== peer) {
          peer.links.add(share.owner.id);
          share.owner.links.add(peer.id);
        }
        peer.conn?.send({ t: 'share-found', rid, share: summary(share) });
        return;
      }
      case 'hello':
        return fail('bad-request');
      default:
        return fail('bad-request');
    }
  }

  private addShare(share: Share): void {
    this.shares.set(share.id, share);
    this.codes.set(share.code, share);
    share.owner.shares.add(share.id);
    if (share.options.lan) this.markDirty(share.owner.network);
  }

  private sign(id: string, code: string): string {
    return createHmac('sha256', this.options.signingKey).update(`share/${id}/${code}`).digest('base64url');
  }

  private verify(id: string, code: string, proof: string): boolean {
    const expected = Buffer.from(this.sign(id, code));
    const given = Buffer.from(proof);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private closeShare(id: string): void {
    const share = this.shares.get(id);
    if (!share) return;
    this.shares.delete(id);
    this.codes.delete(share.code);
    share.owner.shares.delete(id);
    if (share.options.lan) this.markDirty(share.owner.network);
  }

  private newCode(): string {
    const space = 10 ** LIMITS.codeLength;
    for (;;) {
      const code = String(randomInt(0, space)).padStart(LIMITS.codeLength, '0');
      if (!this.codes.has(code)) return code;
    }
  }

  // ---- network snapshots ----

  private markDirty(network: string): void {
    this.dirtyNetworks.add(network);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      const networks = [...this.dirtyNetworks];
      this.dirtyNetworks.clear();
      for (const net of networks) {
        const members = this.networks.get(net);
        if (!members) continue;
        const message = this.snapshot(net);
        for (const member of members) member.conn?.send(message);
      }
    });
  }

  private snapshot(network: string): ServerMessage {
    const members = [...(this.networks.get(network) ?? [])].sort((a, b) => a.joinedAt - b.joinedAt);
    const peers = members
      .filter((p) => p.visible && p.conn)
      .slice(0, this.listLimit)
      .map(info);
    const shares: ShareSummary[] = [];
    for (const member of members) {
      for (const shareId of member.shares) {
        const share = this.shares.get(shareId);
        if (share?.options.lan) shares.push(summary(share));
      }
    }
    shares.sort((a, b) => b.createdAt - a.createdAt);
    return { t: 'lan', peers, shares: shares.slice(0, this.listLimit) };
  }
}

// ---- helpers ----

function randomId(): string {
  return randomBytes(16).toString('base64url');
}

function info(peer: Peer): PeerInfo {
  return { id: peer.id, name: peer.name, device: peer.device };
}

function summary(share: Share): ShareSummary {
  return {
    id: share.id,
    owner: share.owner.id,
    ownerName: share.owner.name,
    ownerDevice: share.owner.device,
    title: share.options.title,
    fileCount: share.options.fileCount,
    totalSize: share.options.totalSize,
    locked: share.options.locked,
    approval: share.options.approval,
    createdAt: share.createdAt,
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, max).join('');
}

function cleanName(value: unknown): string | null {
  const name = cleanText(value, LIMITS.nameMax);
  return name ? name : null;
}

function cleanDevice(value: unknown): DeviceInfo | null {
  if (!value || typeof value !== 'object') return null;
  const device = value as Partial<DeviceInfo>;
  if (!DEVICE_TYPES.includes(device.type as DeviceType)) return null;
  return {
    type: device.type as DeviceType,
    os: cleanText(device.os, 24) || 'Unknown',
    browser: cleanText(device.browser, 24) || 'Browser',
  };
}

function cleanRid(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 31 ? value : null;
}

function cleanShareOptions(value: unknown): ShareOptions | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Partial<ShareOptions>;
  const title = cleanText(o.title ?? '', LIMITS.titleMax);
  if (title === null) return null;
  if (!Number.isInteger(o.fileCount) || o.fileCount! < 1 || o.fileCount! > 100_000) return null;
  if (typeof o.totalSize !== 'number' || !Number.isFinite(o.totalSize) || o.totalSize < 0) return null;
  return {
    title,
    fileCount: o.fileCount!,
    totalSize: Math.floor(o.totalSize),
    locked: o.locked === true,
    approval: o.approval === true,
    lan: o.lan === true,
  };
}

function cleanSignal(value: unknown): SignalData | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<SignalData> & Record<string, unknown>;
  if (typeof data.sid !== 'string' || !/^[A-Za-z0-9_-]{8,32}$/.test(data.sid)) return null;
  switch (data.kind) {
    case 'offer':
    case 'answer':
      if (typeof data.sdp !== 'string' || data.sdp.length > MAX_SDP) return null;
      return { sid: data.sid, kind: data.kind, sdp: data.sdp };
    case 'ice': {
      if (data.candidate === null) return { sid: data.sid, kind: 'ice', candidate: null };
      const c = data.candidate as Record<string, unknown> | undefined;
      if (!c || typeof c !== 'object') return null;
      if (typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE) return null;
      return {
        sid: data.sid,
        kind: 'ice',
        candidate: {
          candidate: c.candidate,
          sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 64) : null,
          sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null,
          usernameFragment: typeof c.usernameFragment === 'string' ? c.usernameFragment.slice(0, 256) : null,
        },
      };
    }
    case 'bye':
      return { sid: data.sid, kind: 'bye' };
    default:
      return null;
  }
}
