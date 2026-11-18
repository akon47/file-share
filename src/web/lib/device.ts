import type { DeviceInfo, DeviceType } from '@shared/protocol';

/** Best-effort OS / browser / form factor from the user agent (only used for labels and icons). */
export function detectDevice(nav: Navigator = navigator): DeviceInfo {
  const ua = nav.userAgent;
  const touch = (nav.maxTouchPoints ?? 0) > 1;

  let os = 'Unknown';
  let type: DeviceType = 'desktop';
  if (/iPhone|iPod/.test(ua)) {
    os = 'iOS';
    type = 'mobile';
  } else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) {
    os = 'iPadOS';
    type = 'tablet';
  } else if (/Android/.test(ua)) {
    os = 'Android';
    type = /Mobile/.test(ua) ? 'mobile' : 'tablet';
  } else if (/Windows/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  let browser = 'Browser';
  if (/Whale\//.test(ua)) browser = 'Whale';
  else if (/SamsungBrowser\//.test(ua)) browser = 'Samsung';
  else if (/Edg(A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  return { type, os, browser };
}

/** Safari and every iOS browser (all WebKit). Streaming downloads through a service worker are unreliable there. */
export function isWebKit(nav: Navigator = navigator): boolean {
  const ua = nav.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  return ios || (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Whale\/|SamsungBrowser\//.test(ua));
}

export function deviceIcon(type: DeviceType): string {
  return type === 'mobile' ? 'smartphone' : type === 'tablet' ? 'tablet' : 'monitor';
}

export function deviceLabel(device: DeviceInfo): string {
  return `${device.os} · ${device.browser}`;
}
