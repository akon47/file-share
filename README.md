# [file-share](https://fileshare.kimhwan.com)

<p>
  <img src="https://counter.kimhwan.com/?key=github-akon47-file-share" />
  <img alt="GitHub" src="https://img.shields.io/github/license/akon47/file-share">
</p>

Browser-to-browser file sharing over WebRTC. Devices on the same network show up automatically; anyone else gets a
link, a QR code or a 6-digit code. **Files never touch the server** — they go straight from the sender's browser to
the receiver's over an encrypted peer-to-peer connection. No install, no account, no size limit.

브라우저끼리 직접 파일을 보내는 서비스입니다. 같은 와이파이의 기기는 자동으로 보이고, 다른 곳에 있는 사람에게는
링크·QR·6자리 코드로 보냅니다. 파일은 서버를 거치지 않습니다.

## ✨ Features

### Nearby devices (AirDrop style)
- Devices that open the page on the **same network** appear automatically (random friendly names like "용감한 수달",
  editable, can be hidden).
- Drag files onto a device (or tap it) to send. **The receiver must accept** — that is the gate, no password needed.
- Several files arrive as one `.zip`, packed on the fly.

### Shares (link · QR · code)
- Pick files → **share link**, **QR code** and a **6-digit code**.
- Per-share options: **password**, **approve each receiver**, **show on the same network**, **max receivers**.
- Receivers see the file list, pick files, download everything as a zip or one by one.
- Live receiver list with progress for the sender; disconnect anyone.

### Security
- File data and file names travel only over the WebRTC data channel (DTLS-encrypted). The signaling server only
  sees share sizes/counts and relays connection setup messages.
- Passwords are **never sent anywhere**: after the P2P connection opens, the receiver proves knowledge of the password
  (PBKDF2 → HMAC) and the sender proves it back. Proofs are bound to both peers' DTLS certificate fingerprints, so a
  relaying man-in-the-middle (even a malicious signaling server) cannot reuse them; a wrong guess yields nothing to
  brute-force offline. Attempts are limited per receiver and per share.
- Share links carry a random secret after `#` (never sent to the server). It authenticates the sender to the
  receiver the same way ("확인된 연결"), and is removed from the address bar after it is read.
- Server: strict CSP, origin check on the WebSocket, per-IP connection and lookup rate limits, input validation.

### Large files
- Received bytes are streamed through a service worker into the browser's download manager, so file size is not
  limited by memory (Chromium, Firefox). Safari/iOS fall back to collecting the file in memory.
- Flow control end to end: the sender never runs more than 16 MB ahead of what the receiver has written to disk.
- **Automatic resume**: if the connection drops mid-transfer (Wi-Fi hiccup, switching between Wi-Fi and LTE), both
  sides keep the transfer for up to 2 minutes, reconnect, re-authenticate on their own and continue from the last
  byte written — the browser download simply pauses and goes on.
- Screen wake lock while transferring; a warning before closing a tab that is still sharing.

## 🧭 How "same network" works

Browsers cannot scan the local network (on purpose). The server groups connections by their **public IP address**
(IPv4) or **/64 prefix** (IPv6) — devices behind the same router share it. Strangers behind the same carrier NAT can
end up in one group, which is why nearby transfers always need the receiver's consent.

## 🛠️ Tech stack

- **Web**: Vue 3 + TypeScript + Vite, WebRTC data channels, a download service worker, [client-zip](https://github.com/Touffy/client-zip), [qrcode](https://github.com/soldair/node-qrcode).
- **Server**: Node.js 24 + TypeScript + [`ws`](https://github.com/websockets/ws) (signaling only) — also serves the built web app.
- One repository, one image; the client and server share the protocol types in `src/shared`.

## 💻 Development

```bash
npm install
npm run dev          # server on :8080 + Vite on :5173 (proxies /ws)
npm test             # unit tests (server hub, IP grouping, auth proofs)
npm run lint && npm run typecheck

# end-to-end with real browsers (Chromium + Firefox) against a production build
npx playwright install chromium firefox
npm run build && PORT=8090 node dist/server/index.js &
npm run e2e -- http://localhost:8090
```

Configuration (environment variables): `PORT`, `HOST`, `TRUSTED_PROXY` (read the client IP from `X-Real-IP` —
only behind a trusted reverse proxy), `ALLOWED_ORIGINS`, `ICE_SERVERS` (JSON array of RTCIceServer; default: public
STUN), `DATA_DIR` (keeps `signing.key` so shares survive a restart), `MAX_CONNECTIONS_PER_IP`, `RESUME_GRACE_MS`.

## 🚀 Deployment

`main` → Jenkins builds and tests inside `docker build`, pushes `akon47/file-share`, and runs `deploy/deploy.sh` on
the VM (`docker compose`). The reverse proxy must forward WebSocket upgrades on `/ws` and set `X-Real-IP`.

## 📄 License

[MIT](LICENSE)
