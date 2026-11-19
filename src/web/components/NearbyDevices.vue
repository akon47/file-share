<template>
  <section class="card nearby" aria-labelledby="nearby-title">
    <div class="card-head">
      <div>
        <h2 id="nearby-title">가까운 기기</h2>
        <p class="lead">같은 네트워크에서 이 페이지를 연 기기예요. 파일을 끌어다 놓거나 눌러서 보내세요.</p>
      </div>
      <span v-if="net.peers.length" class="badge badge-accent num">{{ net.peers.length }}대</span>
    </div>
    <div class="card-body">
      <template v-if="net.peers.length">
        <div class="grid">
          <PeerTile v-for="peer in net.peers" :key="peer.id" :peer="peer" />
        </div>
        <p class="tiny subtle legal-note">
          저작권 침해물·불법촬영물 등 불법 파일은 보낼 수 없고, 보낸 파일에 대한 책임은 보낸 사람에게 있어요.
          <RouterLink to="/terms">이용약관</RouterLink>
        </p>
      </template>
      <div v-else class="empty">
        <div class="radar" aria-hidden="true">
          <span class="pulse" />
          <span class="pulse delay" />
          <span class="center"><AppIcon name="wifi" :size="22" /></span>
        </div>
        <h3>{{ net.status === 'online' ? '같은 네트워크의 기기를 찾고 있어요' : '연결 서버에 연결하는 중…' }}</h3>
        <p class="muted small">
          같은 와이파이에 연결된 다른 기기에서
          <strong class="mono">{{ host }}</strong> 를 열면 여기에 바로 나타나요.
        </p>
        <button class="btn btn-soft btn-sm" type="button" @click="showQr = !showQr">
          <AppIcon name="qr" :size="16" />
          {{ showQr ? 'QR 코드 닫기' : '휴대폰으로 열기' }}
        </button>
        <div v-if="showQr" class="qr-box">
          <QrCode :value="origin" label="이 사이트 주소 QR 코드" />
        </div>
        <p class="tiny subtle note">다른 네트워크의 기기에는 <strong>공유 만들기</strong>로 링크나 코드를 보내세요.</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { net } from '@/lib/signaling';
import AppIcon from './AppIcon.vue';
import PeerTile from './PeerTile.vue';
import QrCode from './QrCode.vue';

const showQr = ref(false);
const origin = location.origin;
const host = location.host;
</script>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: var(--s-3);
}

.legal-note {
  margin-top: var(--s-4);
  line-height: 1.5;
}

.legal-note a {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.empty {
  display: grid;
  justify-items: center;
  gap: var(--s-3);
  padding: var(--s-6) var(--s-2) var(--s-2);
  text-align: center;
}

.empty h3 {
  font-size: var(--text-md);
}

.empty p {
  max-width: 400px;
}

.radar {
  position: relative;
  display: grid;
  place-items: center;
  width: 112px;
  height: 112px;
  margin-bottom: var(--s-2);
}

.pulse {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid var(--accent);
  opacity: 0;
  animation: radar 2.4s ease-out infinite;
}

.pulse.delay {
  animation-delay: 1.2s;
}

@keyframes radar {
  0% {
    transform: scale(0.35);
    opacity: 0.7;
  }
  100% {
    transform: scale(1);
    opacity: 0;
  }
}

.center {
  position: relative;
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-text);
}

.qr-box {
  width: 168px;
}

.note {
  margin-top: var(--s-2);
}
</style>
