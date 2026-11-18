<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="request" class="overlay">
        <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="incoming-title">
          <div class="who">
            <DeviceAvatar :name="request.peer.name" :device="request.peer.device" size="lg" />
            <div>
              <h2 id="incoming-title">{{ request.peer.name }}님이 파일을 보내려고 해요</h2>
              <p class="small subtle num">
                {{ formatFileCount(request.files.length) }} · {{ formatBytes(request.total) }} ·
                {{ deviceLabel(request.peer.device) }}
              </p>
            </div>
          </div>
          <ul class="files">
            <li v-for="file in request.files.slice(0, 4)" :key="file.id">
              <FileRow :name="file.name" :size="file.size" :type="file.type" />
            </li>
          </ul>
          <p v-if="request.files.length > 4" class="small subtle more">외 {{ request.files.length - 4 }}개</p>
          <p v-if="request.files.length > 1" class="tiny subtle">여러 파일은 zip 파일 하나로 저장돼요.</p>
          <div class="buttons">
            <button class="btn btn-secondary btn-lg" type="button" @click="request.decline()">거절</button>
            <button ref="acceptButton" class="btn btn-lg" type="button" @click="request.accept()">
              <AppIcon name="download" :size="18" /> 받기
            </button>
          </div>
          <p v-if="queued > 0" class="tiny subtle queued">요청 {{ queued }}개가 더 기다리고 있어요.</p>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { deviceLabel } from '@/lib/device';
import { formatBytes, formatFileCount } from '@/lib/format';
import { transfers } from '@/lib/push';
import AppIcon from './AppIcon.vue';
import DeviceAvatar from './DeviceAvatar.vue';
import FileRow from './FileRow.vue';

const asking = computed(() => transfers.incoming.filter((t) => t.status === 'asking').reverse());
const request = computed(() => asking.value[0]);
const queued = computed(() => Math.max(0, asking.value.length - 1));
const acceptButton = ref<HTMLButtonElement | null>(null);

watch(
  () => request.value?.key,
  async (key) => {
    if (!key) return;
    await nextTick();
    acceptButton.value?.focus();
  },
);
</script>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 150;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--overlay);
}

.dialog {
  display: grid;
  gap: var(--s-4);
  width: min(100%, 440px);
  max-height: calc(100dvh - 32px);
  overflow: auto;
  padding: var(--s-6);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}

.who {
  display: flex;
  align-items: center;
  gap: var(--s-4);
}

.who h2 {
  font-size: var(--text-lg);
}

.files {
  display: grid;
  padding: var(--s-1) var(--s-3);
  border-radius: var(--radius);
  background: var(--surface-2);
}

.more {
  margin-top: calc(var(--s-2) * -1);
}

.buttons {
  display: grid;
  grid-template-columns: 1fr 1.6fr;
  gap: var(--s-2);
}

.queued {
  text-align: center;
}

@media (max-width: 520px) {
  .overlay {
    place-items: end center;
    padding: 0;
  }

  .dialog {
    width: 100%;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    padding-bottom: calc(var(--s-6) + env(safe-area-inset-bottom, 0px));
  }
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.2s;
}

.sheet-enter-active .dialog,
.sheet-leave-active .dialog {
  transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-from .dialog,
.sheet-leave-to .dialog {
  transform: translateY(24px);
}
</style>
