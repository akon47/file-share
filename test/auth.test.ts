import { describe, expect, it } from 'vitest';
import {
  deriveProofKey,
  fromBase64Url,
  makeProof,
  newSecret,
  sdpFingerprints,
  stretchPassword,
  toBase64Url,
  transcript,
  verifyProof,
} from '../src/shared/auth.js';

const SDP_A = 'v=0\r\na=fingerprint:sha-256 AA:BB:CC\r\na=setup:actpass\r\n';
const SDP_B = 'v=0\r\na=fingerprint:sha-256 dd:ee:ff\r\n';
const SDP_EVIL = 'v=0\r\na=fingerprint:sha-256 99:99:99\r\n';
const shareId = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('auth helpers', () => {
  it('base64url round-trips', () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 62, 63]);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    expect(newSecret()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('reads and normalises fingerprints', () => {
    expect(sdpFingerprints(SDP_B)).toEqual(['sha-256 DD:EE:FF']);
  });

  it('builds the same transcript on both ends', () => {
    expect(transcript(shareId, SDP_A, SDP_B)).toBe(transcript(shareId, SDP_B, SDP_A));
    expect(transcript(shareId, SDP_A, SDP_B)).not.toBe(transcript(shareId, SDP_A, SDP_EVIL));
  });
});

describe('proofs', () => {
  it('nothing to prove without a secret or password', async () => {
    expect(await deriveProofKey({ shareId })).toBeNull();
  });

  it('accepts the right password and rejects a wrong one', async () => {
    const senderKey = await deriveProofKey({ shareId, passwordKey: await stretchPassword('hunter2', shareId) });
    const goodKey = await deriveProofKey({ shareId, passwordKey: await stretchPassword('hunter2', shareId) });
    const badKey = await deriveProofKey({ shareId, passwordKey: await stretchPassword('hunter3', shareId) });
    const text = transcript(shareId, SDP_A, SDP_B);
    expect(await verifyProof(senderKey!, 'receiver', text, await makeProof(goodKey!, 'receiver', text))).toBe(true);
    expect(await verifyProof(senderKey!, 'receiver', text, await makeProof(badKey!, 'receiver', text))).toBe(false);
  });

  it('binds proofs to the role and to the connection', async () => {
    const secret = newSecret();
    const key = (await deriveProofKey({ shareId, secret }))!;
    const honest = transcript(shareId, SDP_A, SDP_B);
    const proof = await makeProof(key, 'receiver', honest);
    // A proof cannot be replayed as the other role...
    expect(await verifyProof(key, 'sender', honest, proof)).toBe(false);
    // ...or on a connection with different certificates (a relaying man-in-the-middle).
    expect(await verifyProof(key, 'receiver', transcript(shareId, SDP_EVIL, SDP_B), proof)).toBe(false);
  });

  it('a link secret and a password make different keys, and both are needed when both are used', async () => {
    const secret = newSecret();
    const passwordKey = await stretchPassword('pw', shareId);
    const text = transcript(shareId, SDP_A, SDP_B);
    const both = (await deriveProofKey({ shareId, secret, passwordKey }))!;
    const secretOnly = (await deriveProofKey({ shareId, secret }))!;
    const passwordOnly = (await deriveProofKey({ shareId, passwordKey }))!;
    expect(await verifyProof(both, 'receiver', text, await makeProof(secretOnly, 'receiver', text))).toBe(false);
    expect(await verifyProof(both, 'receiver', text, await makeProof(passwordOnly, 'receiver', text))).toBe(false);
    expect(await verifyProof(both, 'receiver', text, await makeProof(both, 'receiver', text))).toBe(true);
  });

  it('rejects garbage proofs', async () => {
    const key = (await deriveProofKey({ shareId, secret: newSecret() }))!;
    expect(await verifyProof(key, 'receiver', 'x', '!!!')).toBe(false);
    expect(await verifyProof(key, 'receiver', 'x', 'AAAA')).toBe(false);
  });
});
