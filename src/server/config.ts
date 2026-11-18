import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IceServerLike } from '../shared/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  port: number;
  host: string;
  version: string;
  /** Read the client address from X-Real-IP / X-Forwarded-For (only behind the trusted gateway). */
  trustedProxy: boolean;
  /** Allowed WebSocket Origin values; empty = any (development). */
  allowedOrigins: string[];
  iceServers: IceServerLike[];
  staticDir: string;
  maxConnectionsPerIp: number;
  resumeGraceMs: number;
  /** Holds signing.key (created on first start). Unset = a new key per process. */
  dataDir: string | null;
}

const DEFAULT_ICE_SERVERS: IceServerLike[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function iceServers(value: string | undefined): IceServerLike[] {
  if (!value) return DEFAULT_ICE_SERVERS;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('ICE_SERVERS must be a JSON array');
  return parsed as IceServerLike[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: int(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    version: env.APP_VERSION || 'dev',
    trustedProxy: bool(env.TRUSTED_PROXY, false),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    iceServers: iceServers(env.ICE_SERVERS),
    staticDir: env.STATIC_DIR || path.resolve(here, '../web'),
    maxConnectionsPerIp: int(env.MAX_CONNECTIONS_PER_IP, 64),
    resumeGraceMs: int(env.RESUME_GRACE_MS, 30_000),
    dataDir: env.DATA_DIR || null,
  };
}
