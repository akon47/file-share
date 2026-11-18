import { isIPv4, isIPv6 } from 'node:net';
import type { IncomingMessage } from 'node:http';

/**
 * The client's address. Behind the nginx gateway (TRUSTED_PROXY=true) it is the X-Real-IP header the gateway
 * sets from the TCP peer; otherwise the socket address. Never trust these headers on a directly exposed server.
 */
export function clientIp(req: IncomingMessage, trustedProxy: boolean): string {
  if (trustedProxy) {
    const real = headerValue(req.headers['x-real-ip']);
    if (real && isIp(normalizeIp(real))) return normalizeIp(real);
    const forwarded = headerValue(req.headers['x-forwarded-for'])?.split(',')[0]?.trim();
    if (forwarded && isIp(normalizeIp(forwarded))) return normalizeIp(forwarded);
  }
  return normalizeIp(req.socket.remoteAddress ?? '');
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isIp(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
}

/** Strips IPv4-mapped IPv6 prefixes, brackets and zone ids. */
export function normalizeIp(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  return ip.toLowerCase();
}

/**
 * "Same network" key. Devices behind one router share a public IPv4 address. With IPv6 every device has its own
 * address, so the /64 prefix (one per home network) is used instead. Private, loopback and link-local addresses
 * (development, or clients inside the home network hairpinning through the router) all share one key.
 */
export function networkKey(rawIp: string): string {
  const ip = normalizeIp(rawIp);
  if (isIPv4(ip)) return isPrivateV4(ip) ? 'private' : `v4:${ip}`;
  if (isIPv6(ip)) {
    const groups = expandV6(ip);
    if (isPrivateV6(groups)) return 'private';
    return `v6:${groups.slice(0, 4).join(':')}`;
  }
  return 'unknown';
}

function isPrivateV4(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function isPrivateV6(groups: string[]): boolean {
  const first = Number.parseInt(groups[0] ?? '0', 16);
  const loopback = groups.slice(0, 7).every((g) => g === '0000') && groups[7] === '0001';
  const unspecified = groups.every((g) => g === '0000');
  return loopback || unspecified || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** "2001:db8::1" → ["2001","0db8","0000",...,"0001"] */
export function expandV6(ip: string): string[] {
  const [head = '', tail] = ip.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups =
    tail !== undefined ? [...headGroups, ...Array(Math.max(0, missing)).fill('0'), ...tailGroups] : headGroups;
  return groups.map((g) => g.padStart(4, '0').toLowerCase());
}
