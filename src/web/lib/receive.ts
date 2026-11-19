import { reactive } from 'vue';
import type { PeerInfo, ServerMessage, ShareSummary } from '@shared/protocol';
import {
  deriveProofKey,
  makeProof,
  randomBytes,
  stretchPassword,
  toBase64Url,
  transcript,
  verifyProof,
} from '@shared/auth';
import { holdWakeLock, setBusy } from './attention';
import type { Channel } from './channel';
import { RateMeter } from './format';
import { failureMessage, PeerSession, type ConnectionKind } from './rtc';
import { archiveName, createSink, MEMORY_WARNING_BYTES } from './save';
import { device, net, RequestError, signaling } from './signaling';
import { settings } from './settings';
import { cleanManifest, FileReceiver, PROTOCOL, TransferCancelled, type FileMeta } from './transfer';
import { toast } from './ui';

// The receiving side of a share link / code / nearby share card.

export type ReceivePhase =
  | 'lookup'
  | 'connecting'
  | 'password'
  | 'verifying'
  | 'approval'
  | 'ready'
  | 'receiving'
  | 'reconnecting'
  | 'done'
  | 'error'
  | 'gone'
  | 'own';

export interface ReceiveState {
  shareId: string;
  phase: ReceivePhase;
  share: ShareSummary | null;
  title: string;
  files: FileMeta[];
  selected: number[];
  error: string;
  passwordError: string;
  received: number;
  total: number;
  speed: number;
  currentFile: string;
  mode: 'stream' | 'memory' | null;
  kind: ConnectionKind | null;
  /** The receiver proved the link secret and the sender proved it back. */
  verified: boolean;
  downloadedIds: number[];
}

/** How long to keep trying to reconnect after the connection drops in the middle of a download. */
const RESUME_WINDOW_MS = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ReceiveController {
  readonly state: ReceiveState;
  private session: PeerSession | null = null;
  private channel: Channel | null = null;
  private receiver: FileReceiver | null = null;
  private proofKey: CryptoKey | null = null;
  /** Remembered after a correct password so a reconnect does not ask again. */
  private passwordKey: Uint8Array | null = null;
  private pendingPasswordKey: Uint8Array | null = null;
  /** Identifies this receiver to the sender across reconnects (skips approval the second time). */
  private readonly token = toBase64Url(randomBytes(16));
  private draining = false;
  private disposed = false;
  private release: (() => void) | null = null;
  /** Set while reconnecting after a drop in the middle of a download. */
  private resuming: { receiver: FileReceiver; attempt: ((outcome: 'resumed' | 'closed') => void) | null } | null = null;

  constructor(
    shareId: string,
    private readonly secret: string | null,
  ) {
    this.state = reactive<ReceiveState>({
      shareId,
      phase: 'lookup',
      share: null,
      title: '',
      files: [],
      selected: [],
      error: '',
      passwordError: '',
      received: 0,
      total: 0,
      speed: 0,
      currentFile: '',
      mode: null,
      kind: null,
      verified: false,
      downloadedIds: [],
    });
  }

  private async lookup(): Promise<ShareSummary> {
    const reply = await signaling.request<Extract<ServerMessage, { t: 'share-found' }>>((rid) => ({
      t: 'share-lookup',
      rid,
      id: this.state.shareId,
    }));
    return reply.share;
  }

  async start(): Promise<void> {
    const s = this.state;
    s.phase = 'lookup';
    s.error = '';
    try {
      s.share = await this.lookup();
    } catch (error) {
      if (error instanceof RequestError && error.code === 'not-found') s.phase = 'gone';
      else if (error instanceof RequestError && error.code === 'rate-limited') this.fail('잠시 후 다시 시도해 주세요.');
      else this.fail('서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    if (s.share.owner === net.myId) {
      s.phase = 'own';
      return;
    }
    this.connect();
  }

  private connect(): void {
    const s = this.state;
    const share = s.share!;
    if (!this.resuming) s.phase = 'connecting';
    const owner: PeerInfo = { id: share.owner, name: share.ownerName, device: share.ownerDevice };
    const session = PeerSession.connect(owner);
    this.session = session;
    this.channel = null;
    this.proofKey = null;
    this.draining = false;
    session.onOpen((channel) => {
      this.channel = channel;
      void session.connectionKind().then((kind) => (s.kind = kind));
      channel.send({
        t: 'hello',
        v: PROTOCOL,
        shareId: share.id,
        name: settings.name,
        device,
        hasSecret: !!this.secret,
        token: this.token,
      });
      channel.listen(
        (message) => void this.onMessage(message),
        (data) => {
          if (!this.draining && !this.resuming) this.receiver?.handleBinary(data);
        },
      );
    });
    session.onClose((reason) => {
      if (this.session !== session || this.disposed) return;
      if (this.resuming) {
        // One reconnect attempt failed; the loop in reconnect() decides what is next.
        this.resuming.attempt?.('closed');
        return;
      }
      if (s.phase === 'receiving' && this.receiver && !this.receiver.settled && !this.draining) {
        void this.reconnect();
        return;
      }
      this.release?.();
      this.release = null;
      setBusy('receive', false);
      this.receiver?.fail(new Error('closed'));
      if (['done', 'gone', 'error', 'ready'].includes(s.phase) && reason === null) {
        if (s.phase === 'ready') s.phase = 'gone';
        return;
      }
      if (s.phase !== 'gone' && s.phase !== 'error') this.fail(failureMessage(reason));
    });
  }

  /** The connection dropped mid-download: keep the download open and reconnect to continue where it stopped. */
  private async reconnect(): Promise<void> {
    const s = this.state;
    this.resuming = { receiver: this.receiver!, attempt: null };
    s.phase = 'reconnecting';
    s.speed = 0;
    const deadline = Date.now() + RESUME_WINDOW_MS;
    for (let attempt = 0; this.resuming && !this.disposed && Date.now() < deadline; attempt++) {
      await sleep(Math.min(8000, 1000 * 2 ** attempt));
      if (!this.resuming || this.disposed) return;
      try {
        s.share = await this.lookup();
      } catch {
        continue; // the sender (or we) may still be reconnecting to the server
      }
      const outcome = await new Promise<'resumed' | 'closed'>((resolve) => {
        this.resuming!.attempt = resolve;
        this.connect();
      });
      if (outcome === 'resumed') return;
    }
    if (this.resuming && !this.disposed) {
      const receiver = this.resuming.receiver;
      this.resuming = null;
      this.fail('연결이 끊어져서 이어 받지 못했어요. 보내는 사람의 페이지가 열려 있는지 확인하고 다시 시도해 주세요.');
      receiver.fail(new Error('could not resume'));
      this.session?.close(null);
    }
  }

  private async continueTransfer(): Promise<void> {
    const resuming = this.resuming;
    const channel = this.channel;
    if (!resuming || !channel) return;
    const receiver = resuming.receiver;
    receiver.rebind(channel);
    const from = await receiver.position();
    this.resuming = null;
    this.state.phase = 'receiving';
    channel.send({ t: 'get', ids: receiver.ids, from });
    resuming.attempt?.('resumed');
    toast.success('다시 연결했어요. 끊긴 곳부터 이어 받아요.');
  }

  private async onMessage(message: { t: string } & Record<string, unknown>): Promise<void> {
    const s = this.state;
    if (this.draining) {
      if (message.t === 'aborted') this.draining = false;
      return;
    }
    if (!this.resuming && this.receiver?.handle(message)) return;
    switch (message.t) {
      case 'auth-need':
        if (message.password === true && !this.passwordKey) {
          s.phase = 'password';
        } else {
          await this.sendProof(message.password === true ? this.passwordKey : null);
        }
        return;
      case 'auth-ok': {
        if (this.proofKey) {
          const descriptions = this.session?.descriptions();
          const text = descriptions ? transcript(s.shareId, descriptions.local, descriptions.remote) : '';
          const ok =
            typeof message.proof === 'string' &&
            !!text &&
            (await verifyProof(this.proofKey, 'sender', text, message.proof));
          if (!ok) {
            this.stopResuming();
            this.fail('보안 확인에 실패했어요. 연결이 중간에서 바뀌었을 수 있어요. 링크를 다시 받아 열어 주세요.');
            this.session?.close('local');
            return;
          }
          s.verified = !!this.secret;
          if (this.pendingPasswordKey) this.passwordKey = this.pendingPasswordKey;
        }
        return;
      }
      case 'auth-fail': {
        const left = Number(message.left) || 0;
        this.passwordKey = null;
        if (left <= 0) {
          this.stopResuming();
          this.fail(
            message.locked
              ? '비밀번호가 너무 많이 틀려서 잠시 잠겼어요. 몇 분 뒤에 다시 시도해 주세요.'
              : '비밀번호를 너무 많이 틀렸어요.',
          );
          return;
        }
        s.phase = 'password';
        s.passwordError = `비밀번호가 맞지 않아요. ${left}번 더 시도할 수 있어요.`;
        return;
      }
      case 'wait-approval':
        if (!this.resuming) s.phase = 'approval';
        return;
      case 'denied':
        this.stopResuming();
        this.fail('보내는 사람이 요청을 거절했어요.');
        return;
      case 'manifest': {
        if (this.resuming) {
          await this.continueTransfer();
          return;
        }
        const files = cleanManifest(message.files);
        if (!files) {
          this.fail('파일 목록을 읽지 못했어요.');
          return;
        }
        s.files = files;
        s.title = typeof message.title === 'string' ? message.title.slice(0, 80) : '';
        s.selected = files.map((f) => f.id);
        s.phase = 'ready';
        return;
      }
      case 'gone':
        this.stopResuming();
        s.phase = 'gone';
        if (message.reason === 'limit') s.error = '받을 수 있는 횟수가 모두 찼어요.';
        else if (message.reason === 'kicked') s.error = '보내는 사람이 연결을 끊었어요.';
        else s.error = '';
        this.session?.close(null);
        return;
    }
  }

  /** Gives up an ongoing reconnect (the transfer cannot continue). */
  private stopResuming(): void {
    const resuming = this.resuming;
    if (!resuming) return;
    this.resuming = null;
    resuming.receiver.fail(new Error('stopped'));
    resuming.attempt?.('closed');
  }

  async submitPassword(password: string): Promise<void> {
    const s = this.state;
    if (s.phase !== 'password' || !password) return;
    s.phase = 'verifying';
    s.passwordError = '';
    this.pendingPasswordKey = await stretchPassword(password, s.shareId);
    await this.sendProof(this.pendingPasswordKey);
  }

  private async sendProof(passwordKey: Uint8Array | null): Promise<void> {
    const descriptions = this.session?.descriptions();
    const key = await deriveProofKey({ shareId: this.state.shareId, secret: this.secret, passwordKey });
    if (!descriptions || !key) {
      this.fail('보안 확인을 시작하지 못했어요.');
      return;
    }
    this.proofKey = key;
    const text = transcript(this.state.shareId, descriptions.local, descriptions.remote);
    this.channel?.send({ t: 'auth', proof: await makeProof(key, 'receiver', text) });
    if (this.state.phase !== 'verifying' && !this.resuming) this.state.phase = 'connecting';
  }

  download(ids: number[] = this.state.selected): void {
    const s = this.state;
    const channel = this.channel;
    if (!channel || (s.phase !== 'ready' && s.phase !== 'done')) return;
    const files = s.files.filter((f) => ids.includes(f.id));
    if (files.length === 0) return;
    const total = files.reduce((sum, f) => sum + f.size, 0);
    const sink = createSink(files, archiveName(s.share?.ownerName ?? 'file-share'));
    if (sink.mode === 'memory' && total > MEMORY_WARNING_BYTES) {
      toast.info('이 브라우저는 파일을 메모리에 모았다가 저장해요. 아주 큰 파일은 실패할 수 있어요.');
    }
    const meter = new RateMeter();
    s.phase = 'receiving';
    s.mode = sink.mode;
    s.received = 0;
    s.total = total;
    s.speed = 0;
    s.currentFile = files[0]!.name;
    this.release = holdWakeLock();
    setBusy('receive', true);
    const receiver = new FileReceiver(
      channel,
      s.files,
      files.map((f) => f.id),
      sink,
      (bytes) => {
        s.received = bytes;
        s.speed = meter.update(bytes);
        let before = 0;
        for (const file of files) {
          if (bytes < before + file.size || file === files[files.length - 1]) {
            s.currentFile = file.name;
            break;
          }
          before += file.size;
        }
      },
    );
    this.receiver = receiver;
    channel.send({ t: 'get', ids: files.map((f) => f.id) });
    receiver.done
      .then(() => {
        s.phase = 'done';
        s.received = total;
        s.downloadedIds = [...new Set([...s.downloadedIds, ...files.map((f) => f.id)])];
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        if (s.phase === 'reconnecting') {
          // e.g. the browser download was cancelled while we were reconnecting
          this.stopResuming();
          this.session?.close(null);
          this.fail('받기를 멈췄어요. 다시 시도하면 처음부터 받아요.');
          return;
        }
        if (s.phase !== 'receiving') return;
        console.warn('[file-share] receive failed', String(error), (error as Error)?.stack ?? '');
        if (error instanceof TransferCancelled && error.message === 'cancelled') {
          s.phase = 'ready';
          return;
        }
        if (error instanceof TransferCancelled) this.fail('보내는 사람이 전송을 멈췄어요.');
        else if (this.session?.state === 'open') {
          // Typically the browser download was cancelled: tell the sender and go back to the list.
          this.channel?.send({ t: 'cancel' });
          this.draining = true;
          s.phase = 'ready';
          toast.info('받기를 멈췄어요.');
        } else this.fail('받는 중에 연결이 끊어졌어요.');
      })
      .finally(() => {
        if (this.receiver === receiver) this.receiver = null;
        this.release?.();
        this.release = null;
        setBusy('receive', false);
      });
  }

  cancel(): void {
    if (!this.receiver) return;
    if (this.state.phase === 'reconnecting') {
      this.receiver.fail(new TransferCancelled('cancelled'));
      return;
    }
    if (this.state.phase !== 'receiving') return;
    this.channel?.send({ t: 'cancel' });
    this.draining = true;
    this.receiver.fail(new TransferCancelled('cancelled'));
  }

  retry(): void {
    this.stopResuming();
    this.session?.close(null);
    this.session = null;
    this.channel = null;
    this.proofKey = null;
    this.draining = false;
    this.state.passwordError = '';
    void this.start();
  }

  dispose(): void {
    this.disposed = true;
    this.resuming = null;
    this.receiver?.fail(new TransferCancelled('cancelled'));
    this.session?.close(null);
    this.release?.();
    setBusy('receive', false);
  }

  private fail(message: string): void {
    this.state.phase = 'error';
    this.state.error = message;
  }
}

/** Looks up a 6-digit code; resolves to the share id or throws RequestError. */
export async function findShareByCode(code: string): Promise<ShareSummary> {
  const reply = await signaling.request<Extract<ServerMessage, { t: 'share-found' }>>((rid) => ({
    t: 'share-lookup',
    rid,
    code,
  }));
  return reply.share;
}
