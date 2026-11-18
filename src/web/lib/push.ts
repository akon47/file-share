import { reactive, watch } from 'vue';
import type { PeerInfo } from '@shared/protocol';
import { holdWakeLock, setBusy, setPendingRequests } from './attention';
import type { Channel } from './channel';
import { RateMeter } from './format';
import { failureMessage, PeerSession, type ConnectionKind } from './rtc';
import { archiveName, createSink, MEMORY_WARNING_BYTES } from './save';
import { device } from './signaling';
import { settings } from './settings';
import {
  PROTOCOL,
  TransferCancelled,
  cleanManifest,
  describeFiles,
  sendFiles,
  totalSize,
  FileReceiver,
  type FileMeta,
} from './transfer';
import { toast } from './ui';

// "Nearby" transfers: send files straight to a device on the same network. The receiver must accept.

export type OutgoingStatus = 'connecting' | 'waiting' | 'sending' | 'done' | 'declined' | 'failed' | 'cancelled';
export type IncomingStatus = 'asking' | 'receiving' | 'done' | 'declined' | 'failed' | 'cancelled';

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

const ACTIVE_OUT: OutgoingStatus[] = ['connecting', 'waiting', 'sending'];
const MAX_ASKING = 3;

watch(
  () => transfers.incoming.filter((t) => t.status === 'asking').length,
  (count) => setPendingRequests('push', count),
);
watch(
  () =>
    transfers.outgoing.some((t) => ACTIVE_OUT.includes(t.status)) ||
    transfers.incoming.some((t) => t.status === 'receiving'),
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

export function pushFiles(peer: PeerInfo, files: File[]): void {
  if (files.length === 0) return;
  const existing = activeOutgoing(peer.id);
  if (existing && ACTIVE_OUT.includes(existing.status)) {
    toast.info(`${peer.name}에게 이미 보내는 중이에요.`);
    return;
  }
  if (existing) transfers.outgoing.splice(transfers.outgoing.indexOf(existing), 1);

  const metas = describeFiles(files);
  const session = PeerSession.connect(peer);
  const abort = new AbortController();
  const meter = new RateMeter();
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
      setTimeout(() => session.close(null), 300);
    },
    dismiss: () => removeLater(transfers.outgoing, entry.key, 0),
  });
  transfers.outgoing.unshift(entry);

  session.onOpen((ch) => {
    channel = ch;
    entry.status = 'waiting';
    void session.connectionKind().then((kind) => (entry.kind = kind));
    ch.send({ t: 'push', v: PROTOCOL, name: settings.name, device, files: metas });
    ch.listen(async (message) => {
      if (message.t === 'push-decline') {
        entry.status = 'declined';
        entry.error = message.reason === 'busy' ? '상대가 다른 요청을 처리하고 있어요.' : '';
        session.close(null);
        removeLater(transfers.outgoing, entry.key, 8000);
      } else if (message.t === 'cancel') {
        if (ACTIVE_OUT.includes(entry.status)) entry.status = 'cancelled';
        abort.abort();
        session.close(null);
        removeLater(transfers.outgoing, entry.key, 8000);
      } else if (message.t === 'get' && entry.status === 'waiting') {
        const ids = Array.isArray(message.ids)
          ? message.ids.filter((id): id is number => Number.isInteger(id) && !!files[id])
          : [];
        entry.status = 'sending';
        release = holdWakeLock();
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
          );
          entry.status = 'done';
          entry.sent = entry.total;
          // The receiver closes the connection once it has written everything.
          setTimeout(() => session.close(null), 60_000);
          removeLater(transfers.outgoing, entry.key, 10_000);
        } catch (error) {
          if (!(error instanceof TransferCancelled) && entry.status === 'sending') {
            entry.status = 'failed';
            entry.error = '전송이 중간에 끊어졌어요.';
          }
        } finally {
          release?.();
        }
      }
    });
  });

  session.onClose((reason) => {
    release?.();
    if (ACTIVE_OUT.includes(entry.status)) {
      entry.status = 'failed';
      entry.error = reason === null ? '상대가 연결을 끊었어요.' : failureMessage(reason);
    }
  });
}

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
  const total = totalSize(files);

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
      channel.listen(
        (m) => {
          if (!receiver?.handle(m)) return;
        },
        (data) => receiver?.handleBinary(data),
      );
      channel.send({ t: 'get', ids: files.map((f) => f.id) });
      receiver.done
        .then(() => {
          entry.status = 'done';
          entry.received = total;
          toast.success(
            `${entry.peer.name}에게서 ${files.length > 1 ? `파일 ${files.length}개를` : '파일을'} 받았어요.`,
          );
          session.close(null);
        })
        .catch((error: unknown) => {
          if (entry.status !== 'receiving') return;
          console.warn('[file-share] receive failed', String(error), (error as Error)?.stack ?? '');
          entry.status = error instanceof TransferCancelled ? 'cancelled' : 'failed';
          entry.error = error instanceof TransferCancelled ? '보내는 사람이 취소했어요.' : '받는 중에 문제가 생겼어요.';
          channel.send({ t: 'cancel' });
          setTimeout(() => session.close(null), 300);
        })
        .finally(() => release?.());
    },
    decline: () => {
      if (entry.status !== 'asking') return;
      entry.status = 'declined';
      channel.send({ t: 'push-decline' });
      setTimeout(() => session.close(null), 500);
      removeLater(transfers.incoming, entry.key, 0);
    },
    cancel: () => {
      if (entry.status !== 'receiving') return;
      entry.status = 'cancelled';
      receiver?.fail(new TransferCancelled());
      channel.send({ t: 'cancel' });
      setTimeout(() => session.close(null), 300);
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

  session.onClose((reason) => {
    release?.();
    if (entry.status === 'asking') {
      entry.status = 'cancelled';
      removeLater(transfers.incoming, entry.key, 0);
    } else if (entry.status === 'receiving') {
      entry.status = 'failed';
      entry.error = failureMessage(reason);
      receiver?.fail(new Error('connection closed'));
    }
  });
}
