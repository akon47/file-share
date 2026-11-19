<template>
  <Teleport to="body">
    <TransitionGroup v-if="items.length" tag="div" name="tray" class="tray" aria-live="polite">
      <div v-for="t in items" :key="t.key" class="tray-item" :class="t.status">
        <DeviceAvatar :name="t.peer.name" :device="t.peer.device" size="sm" />
        <div class="main">
          <div class="line">
            <span class="title ellipsis">{{ title(t) }}</span>
            <span class="tiny subtle num">{{ detail(t) }}</span>
          </div>
          <div v-if="t.status === 'receiving' || t.status === 'reconnecting'" class="progress">
            <span :style="{ width: `${percent(t.received, t.total)}%` }" />
          </div>
          <p v-else-if="t.error" class="tiny error-text">{{ t.error }}</p>
        </div>
        <button
          v-if="t.status === 'receiving' || t.status === 'reconnecting'"
          class="btn btn-icon btn-sm"
          type="button"
          aria-label="받기 취소"
          title="받기 취소"
          @click="t.cancel()"
        >
          <AppIcon name="x" :size="16" />
        </button>
        <button v-else class="btn btn-icon btn-sm" type="button" aria-label="닫기" title="닫기" @click="t.dismiss()">
          <AppIcon name="x" :size="16" />
        </button>
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatBytes, formatFileCount, formatSpeed, percent } from '@/lib/format';
import { transfers, type IncomingPush } from '@/lib/push';
import AppIcon from './AppIcon.vue';
import DeviceAvatar from './DeviceAvatar.vue';

const items = computed(() => transfers.incoming.filter((t) => t.status !== 'asking' && t.status !== 'declined'));

function title(t: IncomingPush): string {
  const what = t.files.length === 1 ? t.files[0]!.name : formatFileCount(t.files.length);
  switch (t.status) {
    case 'receiving':
      return `${t.peer.name} → ${what}`;
    case 'reconnecting':
      return `연결이 끊겨 다시 연결하는 중 · ${what}`;
    case 'done':
      return `받았어요 · ${what}`;
    case 'cancelled':
      return `취소됐어요 · ${what}`;
    default:
      return `받지 못했어요 · ${what}`;
  }
}

function detail(t: IncomingPush): string {
  if (t.status === 'reconnecting') return `${Math.floor(percent(t.received, t.total))}%`;
  if (t.status === 'receiving') return `${Math.floor(percent(t.received, t.total))}% ${formatSpeed(t.speed)}`;
  return formatBytes(t.total);
}
</script>

<style scoped>
.tray {
  position: fixed;
  right: 16px;
  bottom: calc(16px + env(safe-area-inset-bottom, 0px));
  z-index: 120;
  display: grid;
  gap: var(--s-2);
  width: min(calc(100vw - 32px), 360px);
}

.tray-item {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}

.tray-item.done {
  border-color: var(--success);
}

.main {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 6px;
}

.line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-2);
}

.title {
  font-size: var(--text-sm);
  font-weight: 600;
}

.tray-enter-active,
.tray-leave-active {
  transition:
    opacity 0.2s,
    transform 0.2s;
}

.tray-enter-from,
.tray-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
