# file-share

브라우저끼리 WebRTC 로 파일을 보내는 서비스(https://fileshare.kimhwan.com). 같은 네트워크 기기 자동 탐색(받는 쪽 수락) +
공유(링크·QR·6자리 코드, 비밀번호·승인·받기 횟수). 파일은 서버를 거치지 않는다. 저장소는 공개(MIT).

## 구조
- `src/shared/protocol.ts` — 시그널링 메시지 타입(서버·웹 공용). 바꾸면 `PROTOCOL_VERSION` 을 올린다(옛 탭은 새로고침 안내).
- `src/shared/auth.ts` — 비밀번호·링크 비밀 키 증명(PBKDF2 → HMAC, DTLS 지문에 묶임). 서버 빌드에는 안 들어간다(웹·테스트만).
- `src/server/` — Node 24 + `ws`. `hub.ts` 가 핵심(피어·네트워크 묶기·공유·코드·중계·재접속 유예·공유 복구 서명),
  `index.ts` 는 HTTP(정적 파일 메모리 서빙 + 보안 헤더 + `/healthz`) 와 `/ws`. 상태는 전부 메모리, `DATA_DIR/signing.key` 만 파일.
- `src/web/` — Vue 3 + Vite. 로직은 `lib/`(signaling → rtc(PeerSession, sid 마다 RTCPeerConnection 하나) → channel(흐름 제어) →
  transfer(파일 스트리밍 프로토콜) → save(서비스 워커 스트리밍 다운로드 / 메모리, zip)), 화면 상태는 `push.ts`(가까운 기기),
  `shares.ts`(보내는 쪽 공유), `receive.ts`(받는 쪽). `public/sw.js` 는 `/__dl/` 다운로드만 가로챈다.
- 디자인은 hwanstory 와 같은 토큰(`src/web/css/base.css`). 색 리터럴 대신 토큰, 다크는 `:root.dark-theme`.
  브라우저 alert/confirm/prompt 대신 `lib/ui.ts`(toast, confirmDialog, promptDialog).

## 개발·검증
- `npm run dev`(서버 :8080 + Vite :5173), `npm test`, `npm run lint`, `npm run typecheck`, `npx prettier --write .`
- 실제 브라우저 E2E: `npm run build && PORT=8090 node dist/server/index.js` 후 `npm run e2e -- http://localhost:8090`
  (Chromium·Firefox, 링크+비밀번호+zip, 코드, 가까운 기기 보내기/거절, 브라우저 간 전송, 콘솔 오류 없음). 화면: `node scripts/screenshots.mjs`.
  전송 로직을 바꾸면 커밋 전에 E2E 를 돌린다(Jenkins 에는 브라우저가 없다).
- 주의: 받은 청크는 서비스 워커로 **transfer(소유권 이동)** 된다 — `write()` 뒤에 그 버퍼의 길이를 읽지 않는다(Firefox 에서 0 이 된다).

## 배포 (중요)
- **`main` 푸시 = 운영 자동 배포**(Jenkins `file-share` 잡 → Docker Hub `akon47/file-share` → VM 207 `deploy@10.10.10.225:/srv/file-share`).
- 관문 nginx(LXC 101)의 `fileshare.kimhwan.com` 블록이 `/` 전체를 `10.10.10.225:8080` 으로 넘기며 WebSocket 업그레이드 헤더와 `X-Real-IP` 를 넣는다.
  "같은 네트워크" 판정이 `X-Real-IP` 에 달려 있으니 `TRUSTED_PROXY=true` 는 관문 뒤에서만 쓴다.
- TURN 없음(STUN 만). 까다로운 네트워크(대칭 NAT)끼리는 연결이 안 될 수 있다 — 넣으려면 `ICE_SERVERS` 환경변수.
- 인프라 문서·도구는 `C:\Users\hwank\OneDrive\문서\source\repos\my-home-server`(docs/infrastructure.md 의 VM 207).

## 커밋
- 작성자 `Kim, Hwan <akon47@naver.com>`(저장소 로컬 설정됨).
