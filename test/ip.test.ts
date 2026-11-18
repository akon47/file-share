import { describe, expect, it } from 'vitest';
import { expandV6, networkKey, normalizeIp } from '../src/server/ip.js';

describe('normalizeIp', () => {
  it('unwraps IPv4-mapped IPv6 and zone ids', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });
});

describe('networkKey', () => {
  it('groups by public IPv4 address', () => {
    expect(networkKey('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(networkKey('::ffff:203.0.113.7')).toBe('v4:203.0.113.7');
    expect(networkKey('203.0.113.8')).not.toBe(networkKey('203.0.113.7'));
  });

  it('puts private, loopback and link-local addresses together', () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.0.10', '127.0.0.1', '::1', 'fd00::5', 'fe80::1']) {
      expect(networkKey(ip)).toBe('private');
    }
    expect(networkKey('172.32.0.1')).toBe('v4:172.32.0.1');
  });

  it('groups IPv6 by /64 prefix', () => {
    expect(networkKey('2001:db8:1:2:aaaa::1')).toBe('v6:2001:0db8:0001:0002');
    expect(networkKey('2001:db8:1:2:bbbb::2')).toBe(networkKey('2001:db8:1:2:aaaa::1'));
    expect(networkKey('2001:db8:1:3::1')).not.toBe(networkKey('2001:db8:1:2::1'));
  });
});

describe('expandV6', () => {
  it('expands compressed forms', () => {
    expect(expandV6('2001:db8::1')).toEqual(['2001', '0db8', '0000', '0000', '0000', '0000', '0000', '0001']);
    expect(expandV6('::1')).toEqual(['0000', '0000', '0000', '0000', '0000', '0000', '0000', '0001']);
    expect(expandV6('fe80::')).toEqual(['fe80', '0000', '0000', '0000', '0000', '0000', '0000', '0000']);
  });
});
