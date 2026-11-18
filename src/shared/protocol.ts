// Signaling protocol between the browser and the server (JSON over one WebSocket at /ws).
// The server only introduces peers and relays WebRTC session descriptions / ICE candidates.
// File names, passwords and file contents never go through it: those travel over the
// encrypted peer-to-peer data channel (see src/web/lib/transfer.ts).

export const PROTOCOL_VERSION = 1;

/** Limits shared by client validation and server enforcement. */
export const LIMITS = {
  nameMax: 24,
  titleMax: 80,
  maxMessageBytes: 64 * 1024,
  maxSharesPerPeer: 10,
  codeLength: 6,
} as const;

export type DeviceType = 'desktop' | 'mobile' | 'tablet';

export interface DeviceInfo {
  type: DeviceType;
  /** e.g. "Windows", "macOS", "iOS", "Android" */
  os: string;
  /** e.g. "Chrome", "Edge", "Safari", "Whale" */
  browser: string;
}

export interface PeerInfo {
  id: string;
  name: string;
  device: DeviceInfo;
}

/** What other devices on the same network (or holders of a link / code) may know about a share. */
export interface ShareSummary {
  id: string;
  owner: string;
  ownerName: string;
  ownerDevice: DeviceInfo;
  title: string;
  fileCount: number;
  totalSize: number;
  /** A password is required (it is verified peer-to-peer, never by the server). */
  locked: boolean;
  /** The sender approves each receiver. */
  approval: boolean;
  createdAt: number;
}

export interface ShareOptions {
  title: string;
  fileCount: number;
  totalSize: number;
  locked: boolean;
  approval: boolean;
  /** List the share for devices on the same network. */
  lan: boolean;
}

/** Relayed between two peers. `sid` identifies one RTCPeerConnection (one transfer session). */
export type SignalData =
  | { sid: string; kind: 'offer'; sdp: string }
  | { sid: string; kind: 'answer'; sdp: string }
  | { sid: string; kind: 'ice'; candidate: RTCIceCandidateInitLike | null }
  | { sid: string; kind: 'bye' };

/** Structural copy of RTCIceCandidateInit so the server does not need DOM types. */
export interface RTCIceCandidateInitLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// ---- client → server ----
export type ClientMessage =
  | { t: 'hello'; v: number; name: string; device: DeviceInfo; visible: boolean; resume?: string }
  | { t: 'update'; name?: string; visible?: boolean }
  | { t: 'signal'; to: string; data: SignalData }
  | { t: 'share-open'; rid: number; options: ShareOptions }
  /** Re-register a share after the server restarted (the proof comes from share-opened). */
  | { t: 'share-restore'; rid: number; id: string; code: string; proof: string; options: ShareOptions }
  | { t: 'share-update'; id: string; options: ShareOptions }
  | { t: 'share-close'; id: string }
  | { t: 'share-lookup'; rid: number; id?: string; code?: string };

// ---- server → client ----
export type ServerMessage =
  | {
      t: 'welcome';
      v: number;
      id: string;
      resume: string;
      /** True when this connection resumed an earlier session (same peer id, shares kept). */
      resumed: boolean;
      iceServers: IceServerLike[];
    }
  /** Everything visible on the caller's network. Sent on join and whenever it changes. */
  | { t: 'lan'; peers: PeerInfo[]; shares: ShareSummary[] }
  | { t: 'signal'; from: string; peer: PeerInfo; data: SignalData }
  | { t: 'share-opened'; rid: number; id: string; code: string; proof: string }
  | { t: 'share-found'; rid: number; share: ShareSummary }
  | { t: 'error'; code: ErrorCode; rid?: number; message?: string };

export type ErrorCode =
  | 'bad-request'
  | 'version'
  | 'not-found'
  | 'peer-offline'
  | 'forbidden'
  | 'rate-limited'
  | 'too-many-shares'
  | 'too-many-connections'
  | 'conflict';

export function isShareCode(value: string): boolean {
  return new RegExp(`^\\d{${LIMITS.codeLength}}$`).test(value);
}

/** Share ids are 16 random bytes in base64url (22 chars). */
export function isShareId(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value);
}

export function isPeerId(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value);
}
