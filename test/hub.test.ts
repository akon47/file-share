import { describe, expect, it, vi } from 'vitest';
import { Hub, type Connection, type Session } from '../src/server/hub.js';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage, type ShareOptions } from '../src/shared/protocol.js';

class FakeConnection implements Connection {
  messages: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(message: ServerMessage): void {
    this.messages.push(message);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return [...this.messages].reverse().find((m) => m.t === t) as Extract<ServerMessage, { t: T }> | undefined;
  }
}

const device = { type: 'desktop', os: 'Windows', browser: 'Chrome' } as const;
const options: ShareOptions = { title: '', fileCount: 2, totalSize: 1234, locked: false, approval: false, lan: true };

function makeHub(now = () => Date.now()) {
  return new Hub({ iceServers: [], resumeGraceMs: 30_000, signingKey: Buffer.alloc(32, 7), now });
}

interface Client {
  conn: FakeConnection;
  session: Session;
  id: string;
  resume: string;
  send(message: ClientMessage): void;
}

async function join(
  hub: Hub,
  network: string,
  name = 'tester',
  ip = network,
  extra: Partial<ClientMessage> = {},
): Promise<Client> {
  const conn = new FakeConnection();
  const session = hub.connect(conn, { ip, network });
  session.handle(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name, device, visible: true, ...extra }));
  await Promise.resolve();
  const welcome = conn.last('welcome')!;
  return {
    conn,
    session,
    id: welcome.id,
    resume: welcome.resume,
    send: (message) => session.handle(JSON.stringify(message)),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Hub', () => {
  it('requires hello first and the current protocol version', () => {
    const hub = makeHub();
    const a = new FakeConnection();
    hub.connect(a, { ip: '1', network: 'n' }).handle(JSON.stringify({ t: 'update', name: 'x' }));
    expect(a.closed?.code).toBe(1008);

    const b = new FakeConnection();
    hub
      .connect(b, { ip: '1', network: 'n' })
      .handle(JSON.stringify({ t: 'hello', v: 999, name: 'x', device, visible: true }));
    expect(b.last('error')?.code).toBe('version');
    expect(b.closed?.code).toBe(4000);
  });

  it('lists devices on the same network only', async () => {
    const hub = makeHub();
    const a = await join(hub, 'home', 'A');
    const b = await join(hub, 'home', 'B');
    const c = await join(hub, 'office', 'C');
    await flush();
    const lanA = a.conn.last('lan')!;
    expect(lanA.peers.map((p) => p.name).sort()).toEqual(['A', 'B']);
    expect(c.conn.last('lan')!.peers.map((p) => p.name)).toEqual(['C']);
    expect(b.conn.last('lan')!.peers.some((p) => p.id === c.id)).toBe(false);
  });

  it('hides invisible devices but still lists them their neighbours', async () => {
    const hub = makeHub();
    const a = await join(hub, 'home', 'A');
    const b = await join(hub, 'home', 'Hidden', 'home', { visible: false } as Partial<ClientMessage>);
    await flush();
    expect(a.conn.last('lan')!.peers.map((p) => p.name)).toEqual(['A']);
    expect(b.conn.last('lan')!.peers.map((p) => p.name)).toEqual(['A']);
  });

  it('relays signals within a network and refuses strangers', async () => {
    const hub = makeHub();
    const a = await join(hub, 'home', 'A');
    const b = await join(hub, 'home', 'B');
    const c = await join(hub, 'office', 'C');
    a.send({ t: 'signal', to: b.id, data: { sid: 'session-1', kind: 'offer', sdp: 'v=0' } });
    const relayed = b.conn.last('signal')!;
    expect(relayed.from).toBe(a.id);
    expect(relayed.peer.name).toBe('A');
    expect(relayed.data).toEqual({ sid: 'session-1', kind: 'offer', sdp: 'v=0' });

    c.send({ t: 'signal', to: a.id, data: { sid: 'session-2', kind: 'offer', sdp: 'v=0' } });
    expect(c.conn.last('error')?.code).toBe('forbidden');
    expect(a.conn.last('signal')).toBeUndefined();
  });

  it('opens shares, finds them by id and code, and links the two peers for signaling', async () => {
    const hub = makeHub();
    const owner = await join(hub, 'home', 'Owner');
    const remote = await join(hub, 'far', 'Remote');
    owner.send({ t: 'share-open', rid: 1, options });
    const opened = owner.conn.last('share-opened')!;
    expect(opened.rid).toBe(1);
    expect(opened.code).toMatch(/^\d{6}$/);
    await flush();
    expect(owner.conn.last('lan')!.shares.map((s) => s.id)).toEqual([opened.id]);
    expect(remote.conn.last('lan')!.shares).toEqual([]);

    remote.send({ t: 'share-lookup', rid: 2, code: opened.code });
    const found = remote.conn.last('share-found')!;
    expect(found.share.id).toBe(opened.id);
    expect(found.share.owner).toBe(owner.id);
    expect(found.share.fileCount).toBe(2);

    remote.send({ t: 'signal', to: owner.id, data: { sid: 'session-3', kind: 'offer', sdp: 'v=0' } });
    expect(owner.conn.last('signal')?.from).toBe(remote.id);
    owner.send({ t: 'signal', to: remote.id, data: { sid: 'session-3', kind: 'answer', sdp: 'v=0' } });
    expect(remote.conn.last('signal')?.data.kind).toBe('answer');

    remote.send({ t: 'share-lookup', rid: 3, code: '000000' === opened.code ? '000001' : '000000' });
    expect(remote.conn.last('error')).toMatchObject({ code: 'not-found', rid: 3 });
  });

  it('only the owner can update or close a share; closing removes the code', async () => {
    const hub = makeHub();
    const owner = await join(hub, 'home', 'Owner');
    const other = await join(hub, 'home', 'Other');
    owner.send({ t: 'share-open', rid: 1, options });
    const { id, code } = owner.conn.last('share-opened')!;
    other.send({ t: 'share-close', id });
    other.send({ t: 'share-lookup', rid: 2, id });
    expect(other.conn.last('share-found')?.share.id).toBe(id);
    owner.send({ t: 'share-close', id });
    other.send({ t: 'share-lookup', rid: 3, code });
    expect(other.conn.last('error')).toMatchObject({ code: 'not-found', rid: 3 });
  });

  it('rate-limits code lookups per IP', async () => {
    const hub = makeHub();
    const guesser = await join(hub, 'net', 'G', '198.51.100.1');
    for (let i = 0; i < 20; i++) guesser.send({ t: 'share-lookup', rid: i, code: String(100000 + i) });
    expect(guesser.conn.messages.filter((m) => m.t === 'error' && m.code === 'not-found')).toHaveLength(20);
    guesser.send({ t: 'share-lookup', rid: 99, code: '123456' });
    expect(guesser.conn.last('error')).toMatchObject({ code: 'rate-limited', rid: 99 });
  });

  it('keeps a dropped peer (same id and shares) for the grace period, and drops it on a clean close', async () => {
    vi.useFakeTimers();
    try {
      const hub = makeHub();
      const a = await join(hub, 'home', 'A');
      a.send({ t: 'share-open', rid: 1, options });
      const { id } = a.conn.last('share-opened')!;
      a.session.closed(false);

      const back = await join(hub, 'home', 'A', 'home', { resume: a.resume } as Partial<ClientMessage>);
      const welcome = back.conn.last('welcome')!;
      expect(welcome.resumed).toBe(true);
      expect(welcome.id).toBe(a.id);
      expect(hub.stats.shares).toBe(1);

      back.session.closed(true);
      expect(hub.stats).toMatchObject({ peers: 0, shares: 0 });

      const c = await join(hub, 'home', 'C');
      c.send({ t: 'share-lookup', rid: 5, id });
      expect(c.conn.last('error')).toMatchObject({ code: 'not-found' });

      c.session.closed(false);
      vi.advanceTimersByTime(31_000);
      expect(hub.stats.peers).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a share after a restart only with a valid proof', async () => {
    const first = makeHub();
    const owner = await join(first, 'home', 'Owner');
    owner.send({ t: 'share-open', rid: 1, options });
    const opened = owner.conn.last('share-opened')!;

    const second = makeHub(); // same signing key = same server after a restart
    const again = await join(second, 'home', 'Owner');
    again.send({ t: 'share-restore', rid: 2, id: opened.id, code: opened.code, proof: 'forged', options });
    expect(again.conn.last('error')).toMatchObject({ code: 'forbidden', rid: 2 });
    again.send({ t: 'share-restore', rid: 3, id: opened.id, code: opened.code, proof: opened.proof, options });
    expect(again.conn.last('share-opened')).toMatchObject({ rid: 3, id: opened.id, code: opened.code });

    const thief = await join(second, 'home', 'Thief');
    thief.send({ t: 'share-restore', rid: 4, id: opened.id, code: opened.code, proof: opened.proof, options });
    expect(thief.conn.last('error')).toMatchObject({ code: 'conflict', rid: 4 });
  });

  it('rejects malformed input', async () => {
    const hub = makeHub();
    const a = await join(hub, 'home', 'A');
    a.send({ t: 'share-open', rid: 1, options: { ...options, fileCount: 0 } });
    expect(a.conn.last('error')).toMatchObject({ code: 'bad-request', rid: 1 });
    a.send({ t: 'signal', to: 'nope', data: { sid: 'x', kind: 'offer', sdp: '' } });
    expect(a.conn.last('error')?.code).toBe('bad-request');
    a.session.handle('{not json');
    expect(a.conn.closed?.code).toBe(1003);
  });

  it('cleans names', async () => {
    const hub = makeHub();
    const a = await join(hub, 'home', '  A\u0007  very   long name that keeps going on  ');
    await flush();
    const name = a.conn.last('lan')!.peers[0]!.name;
    expect(name).toBe('A very long name that ke');
    expect(name.length).toBeLessThanOrEqual(24);
  });
});
