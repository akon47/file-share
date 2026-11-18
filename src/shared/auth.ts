// Peer-to-peer authentication for shares. Runs in the browser (and in Node for tests) on WebCrypto.
//
// After the WebRTC data channel opens, the receiver proves it knows the share's key, then the sender proves it
// back. The key is derived from
//   - the link secret (the part after `#` in a share link, never sent to the server), and/or
//   - the share password (stretched with PBKDF2; never sent anywhere).
// Every proof is an HMAC over a transcript that contains both peers' DTLS certificate fingerprints. The data
// channel is encrypted with exactly those certificates, so a proof only verifies on the very connection it was
// made for: a signaling server that swapped the session descriptions (man-in-the-middle) would see different
// fingerprints on each side and every proof would fail.
//
// The receiver always proves first and the sender only answers after a correct proof, so a wrong guess at the
// password never gives the guesser anything to brute-force offline. The sender also limits attempts.

const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 210_000;

export type ProofRole = 'receiver' | 'sender';

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 16 random bytes, base64url — used for share link secrets. */
export function newSecret(): string {
  return toBase64Url(randomBytes(16));
}

export function isSecret(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value);
}

/** Stretches a share password. Slow on purpose; the sender caches the result for the lifetime of the share. */
export async function stretchPassword(password: string, shareId: string): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', encoder.encode(password.normalize('NFKC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: encoder.encode(`file-share/v1/password/${shareId}`),
      iterations: PBKDF2_ITERATIONS,
    },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export interface KeyMaterial {
  shareId: string;
  /** Link secret (base64url), when the receiver opened the share through its link. */
  secret?: string | null;
  /** Output of stretchPassword, when the share has a password. */
  passwordKey?: Uint8Array | null;
}

/** Returns null when there is nothing to prove (no secret and no password). */
export async function deriveProofKey(material: KeyMaterial): Promise<CryptoKey | null> {
  const hasSecret = !!material.secret;
  const hasPassword = !!material.passwordKey;
  if (!hasSecret && !hasPassword) return null;
  const parts: Uint8Array[] = [encoder.encode(`file-share/v1/key/${material.shareId}/${+hasSecret}${+hasPassword}`)];
  if (hasSecret) parts.push(fromBase64Url(material.secret!));
  if (hasPassword) parts.push(material.passwordKey!);
  const ikm = concat(parts);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', ikm as BufferSource);
  return globalThis.crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** All `a=fingerprint:` values in a session description, normalised and sorted. */
export function sdpFingerprints(sdp: string): string[] {
  const found = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    const match = /^a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)\s*$/.exec(line.trim());
    if (match) found.add(`${match[1]!.toLowerCase()} ${match[2]!.toUpperCase()}`);
  }
  return [...found].sort();
}

/** The same string on both ends of an honest connection, regardless of who is local or remote. */
export function transcript(shareId: string, localSdp: string, remoteSdp: string): string {
  const sides = [sdpFingerprints(localSdp).join(','), sdpFingerprints(remoteSdp).join(',')].sort();
  return `file-share/v1/transcript/${shareId}/${sides[0]}/${sides[1]}`;
}

export async function makeProof(key: CryptoKey, role: ProofRole, transcriptText: string): Promise<string> {
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(`${role}|${transcriptText}`));
  return toBase64Url(new Uint8Array(signature));
}

export async function verifyProof(
  key: CryptoKey,
  role: ProofRole,
  transcriptText: string,
  proof: string,
): Promise<boolean> {
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(proof);
  } catch {
    return false;
  }
  if (signature.length !== 32) return false;
  return globalThis.crypto.subtle.verify(
    'HMAC',
    key,
    signature as BufferSource,
    encoder.encode(`${role}|${transcriptText}`),
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
