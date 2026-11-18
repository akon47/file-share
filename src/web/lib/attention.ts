// Keeping the device awake during transfers, and drawing attention to requests in a background tab.

let wakeLock: WakeLockSentinel | null = null;
let holders = 0;

async function acquire(): Promise<void> {
  if (wakeLock || holders === 0 || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeLock?.addEventListener('release', () => (wakeLock = null));
  } catch {
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => void acquire());

/** Keep the screen on (mobile browsers pause background tabs, which would stall the transfer). */
export function holdWakeLock(): () => void {
  holders++;
  void acquire();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders === 0) {
      void wakeLock?.release().catch(() => undefined);
      wakeLock = null;
    }
  };
}

const baseTitle = document.title;
const pending = new Map<string, number>();
let pendingTotal = 0;

/** Shows "(n) " in the tab title while requests (from any `source`) wait for an answer. */
export function setPendingRequests(source: string, count: number): void {
  pending.set(source, count);
  const total = [...pending.values()].reduce((sum, n) => sum + n, 0);
  if (total > pendingTotal) navigator.vibrate?.(120);
  pendingTotal = total;
  document.title = total > 0 ? `(${total}) ${baseTitle}` : baseTitle;
}

// ---- leaving the page while something is going on ----

const busyReasons = new Set<string>();

export function setBusy(reason: string, busy: boolean): void {
  if (busy) busyReasons.add(reason);
  else busyReasons.delete(reason);
}

window.addEventListener('beforeunload', (event) => {
  if (busyReasons.size === 0) return;
  event.preventDefault();
  event.returnValue = '';
});
