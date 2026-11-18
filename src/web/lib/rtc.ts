import type { PeerInfo, SignalData } from '@shared/protocol';
import { toBase64Url, randomBytes } from '@shared/auth';
import { Channel } from './channel';
import { net, signaling } from './signaling';

// One RTCPeerConnection (+ one data channel) per transfer session. Sessions are identified by a random `sid`
// carried in every signal, so two devices can run several transfers in both directions without offer glare.

export type FailReason = 'timeout' | 'network' | 'offline' | 'remote' | 'local';
export type ConnectionKind = 'local' | 'p2p' | 'relay' | 'unknown';

const OPEN_TIMEOUT_MS = 25_000;
const MAX_INCOMING = 24;

const sessions = new Map<string, PeerSession>();
let incomingHandler: ((session: PeerSession) => void) | null = null;
let initialised = false;

export function onIncomingSession(handler: (session: PeerSession) => void): void {
  incomingHandler = handler;
}

export function initRtc(): void {
  if (initialised) return;
  initialised = true;
  signaling.onSignal((from, data) => {
    let session = sessions.get(data.sid);
    if (!session) {
      if (data.kind !== 'offer') return;
      const incoming = [...sessions.values()].filter((s) => !s.initiator).length;
      if (incoming >= MAX_INCOMING || !incomingHandler) {
        signaling.signal(from.id, { sid: data.sid, kind: 'bye' });
        return;
      }
      session = new PeerSession(from, data.sid, false);
      incomingHandler(session);
    }
    if (session.remote.id !== from.id) return;
    void session.handleSignal(data);
  });
  signaling.onError((code, message) => {
    if (code !== 'peer-offline' && code !== 'forbidden') return;
    for (const session of sessions.values()) {
      if (session.state === 'connecting' && (!message || session.remote.id === message)) session.fail('offline');
    }
  });
}

export class PeerSession {
  readonly pc: RTCPeerConnection;
  channel: Channel | null = null;
  state: 'connecting' | 'open' | 'closed' = 'connecting';
  failure: FailReason | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private openTimer: ReturnType<typeof setTimeout>;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private openHandlers: Array<(channel: Channel) => void> = [];
  private closeHandlers: Array<(reason: FailReason | null) => void> = [];

  /** Starts an outgoing connection to `remote`. */
  static connect(remote: PeerInfo): PeerSession {
    const session = new PeerSession(remote, toBase64Url(randomBytes(12)), true);
    void session.offer();
    return session;
  }

  constructor(
    readonly remote: PeerInfo,
    readonly sid: string,
    readonly initiator: boolean,
  ) {
    sessions.set(sid, this);
    this.pc = new RTCPeerConnection({ iceServers: net.iceServers });
    this.pc.onicecandidate = (event) => {
      signaling.signal(this.remote.id, {
        sid: this.sid,
        kind: 'ice',
        candidate: event.candidate ? event.candidate.toJSON() : null,
      });
    };
    this.pc.onconnectionstatechange = () => this.connectionChanged();
    this.pc.ondatachannel = (event) => this.attach(event.channel);
    this.openTimer = setTimeout(() => this.fail('timeout'), OPEN_TIMEOUT_MS);
  }

  onOpen(handler: (channel: Channel) => void): void {
    if (this.channel && this.state === 'open') handler(this.channel);
    else this.openHandlers.push(handler);
  }

  onClose(handler: (reason: FailReason | null) => void): void {
    if (this.state === 'closed') handler(this.failure);
    else this.closeHandlers.push(handler);
  }

  private async offer(): Promise<void> {
    this.attach(this.pc.createDataChannel('fs', { ordered: true }));
    try {
      await this.pc.setLocalDescription();
      const sdp = this.pc.localDescription?.sdp;
      if (!sdp || !signaling.signal(this.remote.id, { sid: this.sid, kind: 'offer', sdp })) this.fail('offline');
    } catch {
      this.fail('local');
    }
  }

  async handleSignal(data: SignalData): Promise<void> {
    if (this.state === 'closed') return;
    try {
      switch (data.kind) {
        case 'offer': {
          if (this.initiator) return;
          await this.pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
          await this.flushCandidates();
          await this.pc.setLocalDescription();
          const sdp = this.pc.localDescription?.sdp;
          if (sdp) signaling.signal(this.remote.id, { sid: this.sid, kind: 'answer', sdp });
          return;
        }
        case 'answer':
          if (!this.initiator || this.pc.signalingState !== 'have-local-offer') return;
          await this.pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          await this.flushCandidates();
          return;
        case 'ice':
          if (!data.candidate) return;
          if (this.pc.remoteDescription) await this.pc.addIceCandidate(data.candidate as RTCIceCandidateInit);
          else this.pendingCandidates.push(data.candidate as RTCIceCandidateInit);
          return;
        case 'bye':
          this.close('remote', false);
          return;
      }
    } catch {
      // A malformed or stale candidate is not fatal; a bad description will time out.
    }
  }

  private async flushCandidates(): Promise<void> {
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        // ignore
      }
    }
  }

  private attach(dc: RTCDataChannel): void {
    if (this.channel) return;
    const channel = new Channel(dc);
    this.channel = channel;
    const opened = () => {
      if (this.state !== 'connecting') return;
      clearTimeout(this.openTimer);
      this.state = 'open';
      for (const handler of this.openHandlers.splice(0)) handler(channel);
    };
    if (dc.readyState === 'open') queueMicrotask(opened);
    else dc.addEventListener('open', opened);
    channel.onClose(() => this.close(this.state === 'open' ? null : 'network', true));
  }

  private connectionChanged(): void {
    const state = this.pc.connectionState;
    if (state === 'connected' && this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    } else if (state === 'failed') {
      this.fail('network');
    } else if (state === 'disconnected' && !this.disconnectTimer) {
      // Often recovers by itself (Wi-Fi hiccup); give it a moment.
      this.disconnectTimer = setTimeout(() => {
        if (this.pc.connectionState !== 'connected') this.fail('network');
      }, 10_000);
    }
  }

  /** Both DTLS fingerprints, used to bind authentication proofs to this connection. */
  descriptions(): { local: string; remote: string } | null {
    const local = this.pc.localDescription?.sdp;
    const remote = this.pc.remoteDescription?.sdp;
    return local && remote ? { local, remote } : null;
  }

  async connectionKind(): Promise<ConnectionKind> {
    try {
      const stats = await this.pc.getStats();
      let pairId: string | undefined;
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) pairId = report.selectedCandidatePairId;
      });
      let pair: RTCIceCandidatePairStats | undefined;
      stats.forEach((report) => {
        if (report.type !== 'candidate-pair') return;
        if ((pairId && report.id === pairId) || (!pairId && report.nominated && report.state === 'succeeded')) {
          pair = report as RTCIceCandidatePairStats;
        }
      });
      if (!pair) return 'unknown';
      const local = stats.get(pair.localCandidateId) as { candidateType?: string } | undefined;
      const remote = stats.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
      if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') return 'relay';
      if (local?.candidateType === 'host' && remote?.candidateType === 'host') return 'local';
      return 'p2p';
    } catch {
      return 'unknown';
    }
  }

  fail(reason: FailReason): void {
    this.close(reason, true);
  }

  /** reason null = finished normally. */
  close(reason: FailReason | null = null, notifyRemote = true): void {
    if (this.state === 'closed') return;
    const wasOpen = this.state === 'open';
    this.state = 'closed';
    this.failure = reason;
    clearTimeout(this.openTimer);
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    if (notifyRemote && !wasOpen) signaling.signal(this.remote.id, { sid: this.sid, kind: 'bye' });
    this.channel?.close();
    try {
      this.pc.close();
    } catch {
      // ignore
    }
    sessions.delete(this.sid);
    for (const handler of this.closeHandlers.splice(0)) handler(reason);
  }
}

export function failureMessage(reason: FailReason | null): string {
  switch (reason) {
    case 'timeout':
    case 'network':
      return '직접 연결하지 못했어요. 두 기기를 같은 와이파이에 연결하거나, 다른 네트워크(예: LTE ↔ 와이파이)에서 다시 시도해 보세요.';
    case 'offline':
      return '상대 기기가 연결되어 있지 않아요.';
    case 'remote':
      return '상대가 연결을 끊었어요.';
    case 'local':
      return '이 브라우저에서 연결을 만들지 못했어요.';
    default:
      return '연결이 끊어졌어요.';
  }
}
