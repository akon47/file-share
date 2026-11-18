import { handleIncomingPush } from './push';
import { initRtc, onIncomingSession } from './rtc';
import { handleShareHello } from './shares';
import { signaling } from './signaling';

/** Starts signaling and routes incoming peer connections by their first message. */
export function startApp(): void {
  initRtc();
  onIncomingSession((session) => {
    session.onOpen((channel) => {
      const timer = setTimeout(() => session.close('local'), 15_000);
      channel.listen((message) => {
        clearTimeout(timer);
        if (message.t === 'push') handleIncomingPush(session, channel, message);
        else if (message.t === 'hello') handleShareHello(session, channel, message);
        else session.close('local');
      });
    });
  });
  signaling.start();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }
}
