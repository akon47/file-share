import { reactive, watch } from 'vue';
import type { PeerInfo } from '@shared/protocol';
import { holdWakeLock, setBusy, setPendingRequests } from './attention';
import type { Channel } from './channel';
import { RateMeter } from './format';
import { failureMessage, PeerSession, type ConnectionKind } from './rtc';
import { archiveName, createSink, MEMORY_WARNING_BYTES } from './save';
import { device, net } from './signaling';
import { settings } from './settings';
import {
  PROTOCOL,
  TransferCancelled,
  cleanManifest,
  cleanResumePoint,
  describeFiles,
  sendFiles,
  totalSize,
  FileReceiver,
  type FileMeta,
  type ResumePoint,
} from './transfer';
import { toast } from './ui';

// "Nearby" transfers: send files straight to a device on the same network. The receiver must accept.
// If the connection drops in the middle, the sender reconnects ({t:'push-resume', key}) and the receiver answers
// with where it stopped ({t:'resume-from', id, offset}); the receiver's download stays open meanwhile.

export type OutgoingStatus =
  'connecting' | 'waiting' | 'sending' | 'reconnecting' | 'done' | 'declined' | 'failed' | 'cancelled';
export type IncomingStatus = 'asking' | 'receiving' | 'reconnecting' | 'done' | 'declined' | 'failed' | 'cancelled';

export interface OutgoingPush {
  key: string;
  peer: PeerInfo;
  names: string[];
  fileCount: number;
  total: number;
  status: OutgoingStatus;
  sent: number;
  speed: number;
  error: string;
  kind: ConnectionKind | null;
  cancel: () => void;
  dismiss: () => void;
}

export interface IncomingPush {
  key: string;
  peer: PeerInfo;
  files: FileMeta[];
  total: number;
  status: IncomingStatus;
  received: number;
  speed: number;
  error: string;
  mode: 'stream' | 'memory' | null;
  createdAt: number;
  accept: () => void;
  decline: () => void;
  cancel: () => void;
  dismiss: () => void;
}

export const transfers = reactive({
  outgoing: [] as OutgoingPush[],
  incoming: [] as IncomingPush[],
});

const ACTIVE_OUT: OutgoingStatus[] = ['connecting', 'waiting', 'sending', 'reconnecting'];
const MAX_ASKING = 3;
/** How long both sides keep an interrupted transfer alive while reconnecting. */
const RESUME_WINDOW_MS = 120_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

watch(
  () => transfers.incoming.filter((t) => t.status === 'asking').length,
  (count) => setPendingRequests('push', count),
);
watch(
  () =>
    transfers.outgoing.some((t) => ACTIVE_OUT.includes(t.status)) ||
    transfers.incoming.some((t) => t.status === 'receiving' || t.status === 'reconnecting'),
  (busy) => setBusy('push', busy),
);

function removeLater<T extends { key: string }>(list: T[], key: string, ms: number): void {
  setTimeout(() => {
    const index = list.findIndex((item) => item.key === key);
    if (index >= 0) list.splice(index, 1);
  }, ms);
}

export function activeOutgoing(peerId: string): OutgoingPush | undefined {
  return transfers.outgoing.find((t) => t.peer.id === peerId);
}

// ---------------------------------------------------------------- sender

export function pushFiles(peer: PeerInfo, files: File[]): void {
  if (files.length === 0) return;
  const existing = activeOutgoing(peer.id);
  if (existing && ACTIVE_OUT.includes(existing.status)) {
    toast.info(`${peer.name}에게 이미 보내는 중이에요.`);
    return;
  }
  if (existing) transfers.outgoing.splice(transfers.outgoing.indexOf(existing), 1);

  const metas = describeFiles(files);
  const ids = metas.map((f) => f.id);
  const abort = new AbortController();
  const meter = new RateMeter();
  let session = PeerSession.connect(peer);
  let channel: Channel | null = null;
  let release: (() => void) | null = null;

  const entry = reactive<OutgoingPush>({
    key: session.sid,
    peer,
    names: metas.slice(0, 3).map((f) => f.name),
    fileCount: metas.length,
    total: totalSize(metas),
    status: 'connecting',
    sent: 0,
    speed: 0,
    error: '',
    kind: null,
    cancel: () => {
      if (!ACTIVE_OUT.includes(entry.status)) return;
      entry.status = 'cancelled';
      abort.abort();
      channel?.send({ t: 'cancel' });
      const current = session;
      setTimeout(() => current.close(null), 300);
      release?.();
    },
    dismiss: () => removeLater(transfers.outgoing, entry.key, 0),
  });
  transfers.outgoing.unshift(entry);

  const stream = async (ch: Channel, from: ResumePoint | null): Promise<void> => {
    entry.status = 'sending';
    release ??= holdWakeLock();
    try {
      await sendFiles(
        ch,
        files,
        ids,
        (sent) => {
          entry.sent = sent;
          entry.speed = meter.update(sent);
        },
        abort.signal,
        from,
      );
      entry.status = 'done';
      entry.sent = entry.total;
      release?.();
      // The receiver closes the connection once it has written everything.
      const current = session;
      setTimeout(() => current.close(null), 60_000);
      removeLater(transfers.outgoing, entry.key, 10_000);
    } catch (error) {
      // A dropped connection is handled by the session's close handler (reconnect); anything else is final.
      if (error instanceof TransferCancelled || entry.status !== 'sending') return;
      if (ch.closed) return;
      entry.status = 'failed';
      entry.error = '전송이 중간에 끊어졌어요.';
      release?.();
    }
  };

  const watchSession = (s: PeerSession) => {
    s.onClose((reason) => {
      if (s !== session) return;
      if (entry.status === 'sending') {
        void reconnect();
        return;
      }
      if (entry.status === 'reconnecting') return; // the reconnect loop owns it
      if (ACTIVE_OUT.includes(entry.status)) {
        entry.status = 'failed';
        entry.error = reason === null ? '상대가 연결을 끊었어요.' : failureMessage(reason);
        release?.();
      }
    });
  };

  session.onOpen((ch) => {
    channel = ch;
    entry.status = 'waiting';
    void session.connectionKind().then((kind) => (entry.kind = kind));
    ch.send({ t: 'push', v: PROTOCOL, name: settings.name, device, files: metas });
    ch.listen((message) => {
      if (message.t === 'push-decline') {
        entry.status = 'declined';
        entry.error = message.reason === 'busy' ? '상대가 다른 요청을 처리하고 있어요.' : '';
        session.close(null);
        removeLater(transfers.outgoing, entry.key, 8000);
      } else if (message.t === 'cancel') {
        if (ACTIVE_OUT.includes(entry.status)) entry.status = 'cancelled';
        abort.abort();
        release?.();
        session.close(null);
        removeLater(transfers.outgoing, entry.key, 8000);
      } else if (message.t === 'get' && entry.status === 'waiting') {
        void stream(ch, null);
      }
    });
  });
  watchSession(session);

  /** The connection dropped mid-transfer: reconnect and ask the receiver where to continue. */
  const reconnect = async (): Promise<void> => {
    entry.status = 'reconnecting';
    entry.speed = 0;
    const deadline = Date.now() + RESUME_WINDOW_MS;
    for (let attempt = 0; entry.status === 'reconnecting' && Date.now() < deadline; attempt++) {
      await sleep(Math.min(8000, 1000 * 2 ** attempt));
      if (entry.status !== 'reconnecting') return;
      // The receiver may have come back to the server under a new id (after a long drop): find it by name.
      const target = net.peers.find((p) => p.id === peer.id) ?? net.peers.find((p) => p.name === peer.name) ?? peer;
      const next = PeerSession.connect(target);
      session = next;
      const outcome = await new Promise<'resumed' | 'closed'>((resolve) => {
        next.onClose(() => resolve('closed'));
        next.onOpen((ch) => {
          channel = ch;
          ch.send({ t: 'push-resume', key: entry.key });
          ch.listen((message) => {
            if (message.t === 'resume-from') {
              const from = cleanResumePoint(message, files, ids);
              if (!from) {
                next.close('local');
                return;
              }
              watchSession(next);
              resolve('resumed');
              void stream(ch, from);
            } else if (message.t === 'cancel' || message.t === 'push-decline') {
              entry.status = 'cancelled';
              abort.abort();
              release?.();
              next.close(null);
            }
          });
        });
      });
      if (outcome === 'resumed') return;
    }
    if (entry.status === 'reconnecting') {
      entry.status = 'failed';
      entry.error = '연결이 끊어져서 이어 보내지 못했어요.';
      release?.();
    }
  };
}

// ---------------------------------------------------------------- receiver

interface Resumable {
  entry: IncomingPush;
  receiver: FileReceiver;
  attach: (session: PeerSession, channel: Channel) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Interrupted incoming transfers waiting for the sender to reconnect, by transfer key. */
const resumable = new Map<string, Resumable>();

/** An incoming data channel whose first message was {t:'push'}. */
export function handleIncomingPush(session: PeerSession, channel: Channel, message: Record<string, unknown>): void {
  const files = cleanManifest(message.files);
  if (!files) {
    session.close('local');
    return;
  }
  if (transfers.incoming.filter((t) => t.status === 'asking').length >= MAX_ASKING) {
    channel.send({ t: 'push-decline', reason: 'busy' });
    setTimeout(() => session.close(null), 500);
    return;
  }

  const meter = new RateMeter();
  let receiver: FileReceiver | null = null;
  let release: (() => void) | null = null;
  let current = { session, channel };
  const total = totalSize(files);

  const finish = (status: IncomingStatus, error = '') => {
    entry.status = status;
    entry.error = error;
    release?.();
    release = null;
    const pending = resumable.get(entry.key);
    if (pending) {
      clearTimeout(pending.timer);
      resumable.delete(entry.key);
    }
  };

  const listen = (ch: Channel) =>
    ch.listen(
      (m) => {
        receiver?.handle(m);
      },
      (data) => receiver?.handleBinary(data),
    );

  /** Keeps the download open after a drop and waits for the sender to come back. */
  const waitForSender = () => {
    entry.status = 'reconnecting';
    entry.speed = 0;
    const timer = setTimeout(() => {
      if (entry.status !== 'reconnecting') return;
      resumable.delete(entry.key);
      finish('failed', '연결이 끊어져서 이어 받지 못했어요.');
      receiver?.fail(new Error('could not resume'));
    }, RESUME_WINDOW_MS);
    resumable.set(entry.key, {
      entry,
      receiver: receiver!,
      timer,
      attach: (nextSession, nextChannel) => {
        clearTimeout(timer);
        resumable.delete(entry.key);
        current = { session: nextSession, channel: nextChannel };
        receiver!.rebind(nextChannel);
        listen(nextChannel);
        watchClose(nextSession);
        entry.status = 'receiving';
        void receiver!.position().then((from) => nextChannel.send({ t: 'resume-from', ...from }));
      },
    });
  };

  const watchClose = (s: PeerSession) =>
    s.onClose((reason) => {
      if (s !== current.session) return;
      if (entry.status === 'asking') {
        finish('cancelled');
        removeLater(transfers.incoming, entry.key, 0);
      } else if (entry.status === 'receiving' && receiver && !receiver.settled) {
        waitForSender();
      } else if (entry.status === 'receiving') {
        finish('failed', failureMessage(reason));
        receiver?.fail(new Error('connection closed'));
      }
    });

  const entry = reactive<IncomingPush>({
    key: session.sid,
    // The name the server shows for this device, not whatever the sender claims inside the channel.
    peer: session.remote,
    files,
    total,
    status: 'asking',
    received: 0,
    speed: 0,
    error: '',
    mode: null,
    createdAt: Date.now(),
    accept: () => {
      if (entry.status !== 'asking') return;
      entry.status = 'receiving';
      release = holdWakeLock();
      const sink = createSink(files, archiveName(entry.peer.name));
      entry.mode = sink.mode;
      if (sink.mode === 'memory' && total > MEMORY_WARNING_BYTES) {
        toast.info('이 브라우저는 파일을 메모리에 모았다가 저장해요. 아주 큰 파일은 실패할 수 있어요.');
      }
      receiver = new FileReceiver(
        channel,
        files,
        files.map((f) => f.id),
        sink,
        (bytes) => {
          entry.received = bytes;
          entry.speed = meter.update(bytes);
        },
      );
      listen(channel);
      channel.send({ t: 'get', ids: files.map((f) => f.id) });
      receiver.done
        .then(() => {
          finish('done');
          entry.received = total;
          toast.success(
            `${entry.peer.name}에게서 ${files.length > 1 ? `파일 ${files.length}개를` : '파일을'} 받았어요.`,
          );
          current.session.close(null);
        })
        .catch((error: unknown) => {
          if (entry.status !== 'receiving' && entry.status !== 'reconnecting') return;
          console.warn('[file-share] receive failed', String(error), (error as Error)?.stack ?? '');
          const cancelled = error instanceof TransferCancelled;
          finish(
            cancelled ? 'cancelled' : 'failed',
            cancelled ? '보내는 사람이 취소했어요.' : '받는 중에 문제가 생겼어요.',
          );
          current.channel.send({ t: 'cancel' });
          const s = current.session;
          setTimeout(() => s.close(null), 300);
        });
    },
    decline: () => {
      if (entry.status !== 'asking') return;
      entry.status = 'declined';
      channel.send({ t: 'push-decline' });
      setTimeout(() => session.close(null), 500);
      removeLater(transfers.incoming, entry.key, 0);
    },
    cancel: () => {
      if (entry.status !== 'receiving' && entry.status !== 'reconnecting') return;
      finish('cancelled');
      receiver?.fail(new TransferCancelled());
      current.channel.send({ t: 'cancel' });
      const s = current.session;
      setTimeout(() => s.close(null), 300);
    },
    dismiss: () => removeLater(transfers.incoming, entry.key, 0),
  });
  transfers.incoming.unshift(entry);

  channel.listen((m) => {
    if (m.t === 'cancel' && entry.status === 'asking') {
      entry.status = 'cancelled';
      session.close(null);
      removeLater(transfers.incoming, entry.key, 0);
    }
  });
  watchClose(session);
}

/** An incoming data channel whose first message was {t:'push-resume'}: a sender continuing a dropped transfer. */
export function handlePushResume(session: PeerSession, channel: Channel, message: Record<string, unknown>): void {
  const pending = typeof message.key === 'string' ? resumable.get(message.key) : undefined;
  // Only the device that started the transfer may continue it (same id, or same name after a server reconnect).
  if (!pending || (session.remote.id !== pending.entry.peer.id && session.remote.name !== pending.entry.peer.name)) {
    channel.send({ t: 'push-decline' });
    setTimeout(() => session.close(null), 300);
    return;
  }
  pending.attach(session, channel);
}
