<template>
  <main class="container page home">
    <section class="hero">
      <div class="hero-text">
        <h1>파일을 기기끼리 <span class="accent">바로</span> 보내세요</h1>
        <p class="muted">서버에 올리지 않고 브라우저끼리 직접 전송해요. 설치도 가입도 필요 없고, 크기 제한도 없어요.</p>
        <ul class="points">
          <li><AppIcon name="zap" :size="16" /> 같은 와이파이면 자동으로 보여요</li>
          <li><AppIcon name="shield" :size="16" /> 종단간 암호화 · 서버 저장 없음</li>
          <li><AppIcon name="lock" :size="16" /> 링크 · 코드 · 비밀번호 공유</li>
        </ul>
      </div>
      <MyDevice class="hero-device" />
    </section>

    <div v-if="net.outdated" class="notice">
      <AppIcon name="refresh" :size="18" />
      새 버전이 나왔어요. 새로고침해 주세요.
      <button class="btn btn-sm" type="button" @click="reload">새로고침</button>
    </div>

    <div class="grid">
      <div class="col">
        <NearbyDevices />
        <LanShares />
      </div>
      <div class="col">
        <ActiveShareCard v-for="share in myShares" :key="share.key" :share="share" />
        <ShareComposer />
        <CodeReceive />
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import ActiveShareCard from '@/components/ActiveShareCard.vue';
import AppIcon from '@/components/AppIcon.vue';
import CodeReceive from '@/components/CodeReceive.vue';
import LanShares from '@/components/LanShares.vue';
import MyDevice from '@/components/MyDevice.vue';
import NearbyDevices from '@/components/NearbyDevices.vue';
import ShareComposer from '@/components/ShareComposer.vue';
import { myShares } from '@/lib/shares';
import { net } from '@/lib/signaling';

function reload(): void {
  location.reload();
}
</script>

<style scoped>
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  align-items: center;
  gap: var(--s-8);
  margin-bottom: var(--s-8);
}

.hero h1 {
  font-size: var(--text-4xl);
  letter-spacing: -0.03em;
}

.accent {
  color: var(--accent);
}

.hero p {
  max-width: 560px;
  margin-top: var(--s-3);
  font-size: var(--text-md);
}

.points {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2) var(--s-5);
  margin-top: var(--s-4);
  color: var(--text-2);
  font-size: var(--text-sm);
  font-weight: 500;
}

.points li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.points svg {
  color: var(--accent);
}

.notice {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  margin-bottom: var(--s-6);
  padding: var(--s-3) var(--s-4);
  border-radius: var(--radius);
  background: var(--warning-soft);
  color: var(--warning);
  font-weight: 600;
}

.notice .btn {
  margin-left: auto;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
  align-items: start;
  gap: var(--s-6);
}

.col {
  display: grid;
  gap: var(--s-6);
  min-width: 0;
}

@media (max-width: 960px) {
  .hero,
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .hero {
    gap: var(--s-5);
  }
}

@media (max-width: 640px) {
  .page {
    padding-top: var(--s-6);
  }

  .hero h1 {
    font-size: var(--text-3xl);
  }

  .grid,
  .col {
    gap: var(--s-4);
  }
}
</style>
