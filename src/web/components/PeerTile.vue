<template>
  <div
    class="peer-tile"
    :class="{ dragging, busy: isActive, [transfer?.status ?? 'idle']: true }"
    role="button"
    tabindex="0"
    :aria-label="`${peer.name}에게 파일 보내기`"
    @click="pick"
    @keydown.enter.prevent="pick"
    @keydown.space.prevent="pick"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="drop"
  >
    <div class="avatar-wrap">
      <svg v-if="showRing" class="ring" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="30" class="ring-track" />
        <circle
          cx="32"
          cy="32"
          r="30"
          class="ring-value"
          :class="{ spin: transfer?.status === 'connecting' || transfer?.status === 'waiting' }"
          :style="{ strokeDashoffset: ringOffset }"
        />
      </svg>
      <DeviceAvatar :name="peer.name" :device="peer.device" size="md" />
      <span v-if="transfer?.status === 'done'" class="done-mark"
        ><AppIcon name="check" :size="14" :stroke-width="3"
      /></span>
    </div>
    <div class="name ellipsis" :title="peer.name">{{ peer.name }}</div>
    <div class="caption ellipsis" :class="captionTone">{{ caption }}</div>
    <button
      v-if="isActive"
      class="btn btn-icon btn-sm cancel"
      type="button"
      aria-label="보내기 취소"
      title="보내기 취소"
      @click.stop="transfer?.cancel()"
    >
      <AppIcon name="x" :size="16" />
    </button>
    <input ref="input" type="file" multiple hidden @change="picked" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PeerInfo } from '@shared/protocol';
import { deviceLabel } from '@/lib/device';
import { formatBytes, percent } from '@/lib/format';
import { activeOutgoing, pushFiles } from '@/lib/push';
import { toast } from '@/lib/ui';
import AppIcon from './AppIcon.vue';
import DeviceAvatar from './DeviceAvatar.vue';

const props = defineProps<{ peer: PeerInfo }>();
const input = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

const transfer = computed(() => activeOutgoing(props.peer.id));
const isActive = computed(() =>
  ['connecting', 'waiting', 'sending', 'reconnecting'].includes(transfer.value?.status ?? ''),
);
const showRing = computed(() => isActive.value);
const CIRCUMFERENCE = 2 * Math.PI * 30;
const ringOffset = computed(() => {
  const t = transfer.value;
  if (!t || (t.status !== 'sending' && t.status !== 'reconnecting')) return CIRCUMFERENCE * 0.75;
  return CIRCUMFERENCE * (1 - percent(t.sent, t.total) / 100);
});

const caption = computed(() => {
  const t = transfer.value;
  if (!t) return deviceLabel(props.peer.device);
  switch (t.status) {
    case 'connecting':
      return '연결하는 중…';
    case 'waiting':
      return '수락을 기다리는 중…';
    case 'sending':
      return `보내는 중 ${Math.floor(percent(t.sent, t.total))}%`;
    case 'reconnecting':
      return `다시 연결하는 중… ${Math.floor(percent(t.sent, t.total))}%`;
    case 'done':
      return `${formatBytes(t.total)} 보냈어요`;
    case 'declined':
      return t.error || '상대가 거절했어요';
    case 'cancelled':
      return '취소됐어요';
    case 'failed':
      return '보내지 못했어요';
  }
  return '';
});

const captionTone = computed(() => {
  const s = transfer.value?.status;
  if (s === 'done') return 'tone-success';
  if (s === 'failed' || s === 'declined') return 'tone-danger';
  if (s === 'reconnecting') return 'tone-warning';
  if (s === 'connecting' || s === 'waiting' || s === 'sending') return 'tone-accent';
  return '';
});

function pick(): void {
  if (isActive.value) return;
  input.value?.click();
}

function send(files: File[]): void {
  if (files.length === 0) return;
  pushFiles(props.peer, files);
}

function picked(event: Event): void {
  const target = event.target as HTMLInputElement;
  send([...(target.files ?? [])]);
  target.value = '';
}

function drop(event: DragEvent): void {
  dragging.value = false;
  const items = [...(event.dataTransfer?.items ?? [])];
  if (items.some((item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)) {
    toast.info('폴더는 아직 보낼 수 없어요. 폴더 안의 파일을 골라 주세요.');
  }
  send([...(event.dataTransfer?.files ?? [])].filter((f) => f.size > 0 || f.type !== ''));
}
</script>

<style scoped>
.peer-tile {
  position: relative;
  display: grid;
  justify-items: center;
  align-content: start;
  gap: 4px;
  min-width: 0;
  padding: var(--s-5) var(--s-3) var(--s-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  cursor: pointer;
  text-align: center;
  transition:
    border-color var(--ease),
    box-shadow var(--ease),
    transform var(--ease),
    background-color var(--ease);
}

.peer-tile:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}

.peer-tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.peer-tile.dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 4px var(--accent-soft);
  transform: scale(1.03);
}

.peer-tile.busy {
  cursor: default;
}

.avatar-wrap {
  position: relative;
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  margin-bottom: var(--s-2);
}

.ring {
  position: absolute;
  inset: 0;
  transform: rotate(-90deg);
}

.ring circle {
  fill: none;
  stroke-width: 3;
}

.ring-track {
  stroke: var(--surface-3);
}

.ring-value {
  stroke: var(--accent);
  stroke-linecap: round;
  stroke-dasharray: 188.5;
  transition: stroke-dashoffset 0.3s linear;
}

.ring-value.spin {
  transform-origin: 32px 32px;
  animation: spin 1.1s linear infinite;
}

.done-mark {
  position: absolute;
  top: 2px;
  right: 2px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--success);
  color: #fff;
  box-shadow: 0 0 0 2px var(--surface);
  animation: pop 0.3s cubic-bezier(0.3, 1.6, 0.5, 1);
}

@keyframes pop {
  from {
    transform: scale(0.3);
  }
}

.name {
  max-width: 100%;
  font-size: var(--text-sm);
  font-weight: 700;
}

.caption {
  max-width: 100%;
  color: var(--text-3);
  font-size: var(--text-xs);
}

.tone-accent {
  color: var(--accent-text);
  font-weight: 600;
}

.tone-warning {
  color: var(--warning);
  font-weight: 600;
}

.tone-success {
  color: var(--success);
  font-weight: 600;
}

.tone-danger {
  color: var(--danger);
  font-weight: 600;
}

.cancel {
  position: absolute;
  top: 6px;
  right: 6px;
}
</style>
