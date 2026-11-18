import { reactive, watch } from 'vue';
import type { PeerInfo, ServerMessage, ShareOptions } from '@shared/protocol';
import { deriveProofKey, makeProof, newSecret, stretchPassword, transcript, verifyProof } from '@shared/auth';
import { holdWakeLock, setBusy, setPendingRequests } from './attention';
import type { Channel } from './channel';
import { RateMeter } from './format';
import type { ConnectionKind, PeerSession } from './rtc';
import { RequestError, signaling } from './signaling';
import { describeFiles, sendFiles, totalSize, TransferCancelled, type FileMeta } from './transfer';
import { toast } from './ui';

// The sender side of a share: files stay in this tab; receivers connect peer-to-peer, prove they know the link
// secret and/or password, optionally wait for approval, then pick files to download.

export type ReceiverStatus = 'auth' | 'approval' | 'browsing' | 'sending' | 'done' | 'denied' | 'failed' | 'left';

export interface ShareReceiver {
  sid: string;
  peer: PeerInfo;
  status: ReceiverStatus;
  sent: number;
  total: number;
  speed: number;
  kind: ConnectionKind | null;
  completed: boolean;
  joinedAt: number;
  approve: () => void;
  deny: () => void;
  disconnect: () => void;
}

export interface MyShare {
  key: string;
  id: string;
  code: string;
  link: string;
  title: string;
  metas: FileMeta[];
  totalSize: number;
  hasPassword: boolean;
  approval: boolean;
  lan: boolean;
  /** null = unlimited */
  maxReceivers: number | null;
  completed: number;
  status: 'active' | 'full';
  receivers: ShareReceiver[];
  createdAt: number;
}

export interface NewShare {
  files: File[];
  title: string;
  password: string;
  approval: boolean;
  lan: boolean;
  maxReceivers: number | null;
}

interface Private {
  files: File[];
  secret: string;
  proof: string;
  passwordKey: Promise<Uint8Array> | null;
  failures: number;
  lockedUntil: number;
  sessions: Set<PeerSession>;
}

const ATTEMPTS_PER_RECEIVER = 5;
const FAILURES_BEFORE_LOCK = 20;
const LOCK_MS = 5 * 60_000;

export const myShares = reactive<MyShare[]>([]);
const secrets = new Map<string, Private>();

watch(
  () => myShares.length > 0,
  (busy) => setBusy('shares', busy),
);
watch(
  () => myShares.reduce((n, s) => n + s.receivers.filter((r) => r.status === 'approval').length, 0),
  (count) => setPendingRequests('shares', count),
);

function optionsOf(share: MyShare): ShareOptions {
  return {
    title: share.title,
    fileCount: share.metas.length,
    totalSize: share.totalSize,
    locked: share.hasPassword,
    approval: share.approval,
    lan: share.lan && share.status === 'active',
  };
}

export async function openShare(input: NewShare): Promise<MyShare> {
  const metas = describeFiles(input.files);
  const draft = {
    title: input.title.trim(),
    fileCount: metas.length,
    totalSize: totalSize(metas),
    locked: input.password.length > 0,
    approval: input.approval,
    lan: input.lan,
  };
  const reply = await signaling.request<Extract<ServerMessage, { t: 'share-opened' }>>((rid) => ({
    t: 'share-open',
    rid,
    options: draft,
  }));
  const secret = newSecret();
  const share = reactive<MyShare>({
    key: reply.id,
    id: reply.id,
    code: reply.code,
    link: `${location.origin}/s/${reply.id}#${secret}`,
    title: draft.title,
    metas,
    totalSize: draft.totalSize,
    hasPassword: draft.locked,
    approval: input.approval,
    lan: input.lan,
    maxReceivers: input.maxReceivers,
    completed: 0,
    status: 'active',
    receivers: [],
    createdAt: Date.now(),
  });
  secrets.set(share.key, {
    files: input.files,
    secret,
    proof: reply.proof,
    passwordKey: input.password ? stretchPassword(input.password, reply.id) : null,
    failures: 0,
    lockedUntil: 0,
    sessions: new Set(),
  });
  myShares.unshift(share);
  return share;
}

export function closeShare(key: string): void {
  const index = myShares.findIndex((s) => s.key === key);
  if (index < 0) return;
  const share = myShares[index]!;
  myShares.splice(index, 1);
  signaling.send({ t: 'share-close', id: share.id });
  const priv = secrets.get(key);
  secrets.delete(key);
  for (const session of priv?.sessions ?? []) {
    session.channel?.send({ t: 'gone', reason: 'closed' });
    setTimeout(() => session.close(null), 300);
  }
}

export function setShareOption(key: string, patch: Partial<Pick<MyShare, 'approval' | 'lan'>>): void {
  const share = myShares.find((s) => s.key === key);
  if (!share) return;
  Object.assign(share, patch);
  signaling.send({ t: 'share-update', id: share.id, options: optionsOf(share) });
}

// After a server restart (deploy) or a long disconnect the server forgot our shares: re-register them so their
// links and codes keep working.
signaling.onWelcome((resumed) => {
  if (resumed) return;
  for (const share of myShares) {
    const priv = secrets.get(share.key);
    if (!priv) continue;
    signaling
      .request<Extract<ServerMessage, { t: 'share-opened' }>>((rid) => ({
        t: 'share-restore',
        rid,
        id: share.id,
        code: share.code,
        proof: priv.proof,
        options: optionsOf(share),
      }))
      .then((reply) => {
        if (reply.code !== share.code) toast.info('서버가 다시 시작되어 공유 코드가 바뀌었어요. 링크는 그대로예요.');
        share.code = reply.code;
        priv.proof = reply.proof;
      })
      .catch((error: unknown) => {
        if (error instanceof RequestError && (error.code === 'offline' || error.code === 'timeout')) return;
        toast.error('공유를 다시 등록하지 못했어요. 새로 공유해 주세요.');
      });
  }
});

function markFull(share: MyShare): void {
  if (share.maxReceivers !== null && share.completed >= share.maxReceivers && share.status === 'active') {
    share.status = 'full';
    // No new receivers: drop it from the server (codes, nearby list). Connected receivers can finish.
    signaling.send({ t: 'share-close', id: share.id });
  }
}

/** An incoming data channel whose first message was {t:'hello'}: someone wants one of our shares. */
export function handleShareHello(session: PeerSession, channel: Channel, hello: Record<string, unknown>): void {
  const share = myShares.find((s) => s.id === hello.shareId);
  const priv = share ? secrets.get(share.key) : undefined;
  if (!share || !priv || share.status !== 'active') {
    channel.send({ t: 'gone', reason: share?.status === 'full' ? 'limit' : 'closed' });
    setTimeout(() => session.close(null), 500);
    return;
  }
  priv.sessions.add(session);

  const hasSecret = hello.hasSecret === true;
  const needsPassword = priv.passwordKey !== null;
  const meter = new RateMeter();
  let attempts = 0;
  let authed = false;
  let sending: AbortController | null = null;

  const entry = reactive<ShareReceiver>({
    sid: session.sid,
    peer: session.remote,
    status: 'auth',
    sent: 0,
    total: 0,
    speed: 0,
    kind: null,
    completed: false,
    joinedAt: Date.now(),
    approve: () => {
      if (entry.status !== 'approval') return;
      grant();
    },
    deny: () => {
      if (entry.status !== 'approval') return;
      entry.status = 'denied';
      channel.send({ t: 'denied' });
      setTimeout(() => session.close(null), 500);
    },
    disconnect: () => {
      sending?.abort();
      channel.send({ t: 'gone', reason: 'kicked' });
      entry.status = 'left';
      setTimeout(() => session.close(null), 300);
    },
  });
  share.receivers.unshift(entry);
  if (share.receivers.length > 30) share.receivers.splice(30);
  void session.connectionKind().then((kind) => (entry.kind = kind));

  const grant = () => {
    entry.status = 'browsing';
    channel.send({ t: 'manifest', title: share.title, files: share.metas });
  };
  const afterAuth = () => {
    authed = true;
    if (share.approval) {
      entry.status = 'approval';
      channel.send({ t: 'wait-approval' });
      toast.info(`${entry.peer.name}님이 파일을 받으려고 해요.`);
    } else grant();
  };

  if (!hasSecret && !needsPassword) afterAuth();
  else channel.send({ t: 'auth-need', password: needsPassword });

  channel.listen(async (message) => {
    switch (message.t) {
      case 'auth': {
        if (authed || typeof message.proof !== 'string') return;
        if (Date.now() < priv.lockedUntil) {
          channel.send({ t: 'auth-fail', left: 0, locked: true });
          setTimeout(() => session.close(null), 500);
          entry.status = 'failed';
          return;
        }
        const descriptions = session.descriptions();
        const key = await deriveProofKey({
          shareId: share.id,
          secret: hasSecret ? priv.secret : null,
          passwordKey: needsPassword ? await priv.passwordKey : null,
        });
        if (!descriptions || !key) return;
        const text = transcript(share.id, descriptions.local, descriptions.remote);
        if (await verifyProof(key, 'receiver', text, message.proof)) {
          channel.send({ t: 'auth-ok', proof: await makeProof(key, 'sender', text) });
          afterAuth();
          return;
        }
        attempts++;
        priv.failures++;
        if (priv.failures >= FAILURES_BEFORE_LOCK) {
          priv.lockedUntil = Date.now() + LOCK_MS;
          priv.failures = 0;
          toast.error('비밀번호가 여러 번 틀려서 5분 동안 새 시도를 막았어요.');
        }
        const left = Math.max(0, ATTEMPTS_PER_RECEIVER - attempts);
        channel.send({ t: 'auth-fail', left });
        if (left === 0) {
          entry.status = 'failed';
          setTimeout(() => session.close(null), 500);
        }
        return;
      }
      case 'get': {
        if (entry.status !== 'browsing' && entry.status !== 'done') return;
        const ids = Array.isArray(message.ids)
          ? [...new Set(message.ids.filter((id): id is number => Number.isInteger(id) && !!priv.files[id]))]
          : [];
        if (ids.length === 0) return;
        entry.status = 'sending';
        entry.sent = 0;
        entry.total = ids.reduce((sum, id) => sum + priv.files[id]!.size, 0);
        sending = new AbortController();
        const release = holdWakeLock();
        try {
          await sendFiles(
            channel,
            priv.files,
            ids,
            (sent) => {
              entry.sent = sent;
              entry.speed = meter.update(sent);
            },
            sending.signal,
          );
          entry.status = 'done';
          if (!entry.completed) {
            entry.completed = true;
            share.completed++;
            markFull(share);
          }
        } catch (error) {
          if (error instanceof TransferCancelled) {
            // Everything after this marker belongs to a new request (the channel is ordered).
            channel.send({ t: 'aborted' });
            if (entry.status === 'sending') entry.status = 'browsing';
          } else if (entry.status === 'sending') entry.status = 'failed';
        } finally {
          sending = null;
          release();
        }
        return;
      }
      case 'cancel':
        sending?.abort();
        if (entry.status === 'sending') entry.status = 'browsing';
        return;
    }
  });

  session.onClose(() => {
    priv.sessions.delete(session);
    sending?.abort();
    if (!['done', 'denied', 'failed'].includes(entry.status)) entry.status = 'left';
  });
}
