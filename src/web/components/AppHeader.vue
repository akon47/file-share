<template>
  <header class="app-header">
    <div class="container header-inner">
      <RouterLink class="logo" to="/" aria-label="file-share 홈">
        <img class="logo-mark" src="/favicon.svg" alt="" width="30" height="30" />
        <span class="logo-text">file-share</span>
      </RouterLink>
      <div class="actions">
        <span class="status" :class="net.status" :title="statusTitle" role="status">
          <span class="dot" aria-hidden="true" />
          <span class="status-text">{{ statusText }}</span>
        </span>
        <button
          class="btn btn-icon"
          type="button"
          :aria-label="settings.theme === 'dark' ? '밝은 테마로' : '어두운 테마로'"
          :title="settings.theme === 'dark' ? '밝은 테마로' : '어두운 테마로'"
          @click="settings.theme = settings.theme === 'dark' ? 'light' : 'dark'"
        >
          <AppIcon :name="settings.theme === 'dark' ? 'sun' : 'moon'" />
        </button>
        <a
          class="btn btn-icon"
          href="https://github.com/akon47/file-share"
          target="_blank"
          rel="noopener"
          aria-label="GitHub 저장소"
          title="GitHub 저장소"
        >
          <AppIcon name="github" />
        </a>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { net } from '@/lib/signaling';
import { settings } from '@/lib/settings';
import AppIcon from './AppIcon.vue';

const statusText = computed(() =>
  net.status === 'online' ? '연결됨' : net.status === 'connecting' ? '연결 중' : '다시 연결하는 중',
);
const statusTitle = computed(() =>
  net.status === 'online'
    ? '연결 서버에 연결되어 있어요. 파일은 이 서버를 거치지 않아요.'
    : '연결 서버에 다시 연결하고 있어요. 진행 중인 전송은 계속돼요.',
);
</script>

<style scoped>
.app-header {
  position: sticky;
  top: 0;
  z-index: 50;
  height: var(--header-height);
  background: var(--header-bg);
  backdrop-filter: saturate(160%) blur(14px);
  -webkit-backdrop-filter: saturate(160%) blur(14px);
  border-bottom: 1px solid var(--border);
}

.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  gap: var(--s-4);
}

.logo {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--text);
  text-decoration: none;
}

.logo:hover {
  text-decoration: none;
}

.logo-mark {
  width: 30px;
  height: 30px;
}

.logo-text {
  font-size: var(--text-lg);
  font-weight: 800;
  letter-spacing: -0.02em;
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--s-1);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  margin-right: var(--s-2);
  padding: 0 10px;
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: var(--text-xs);
  font-weight: 600;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
}

.status.online .dot {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-soft);
}

.status.connecting .dot,
.status.offline .dot {
  background: var(--warning);
  animation: blink 1.2s ease-in-out infinite;
}

@keyframes blink {
  50% {
    opacity: 0.35;
  }
}

@media (max-width: 480px) {
  .status-text {
    display: none;
  }

  .status {
    padding: 0 9px;
  }
}
</style>
