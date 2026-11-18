<template>
  <div class="file-row">
    <span class="file-icon" :class="kind"><AppIcon :name="kind" :size="18" /></span>
    <span class="file-name ellipsis" :title="name">{{ name }}</span>
    <span class="file-size subtle small num">{{ formatBytes(size) }}</span>
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { fileKind, formatBytes } from '@/lib/format';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ name: string; size: number; type?: string }>();
const kind = computed(() => fileKind(props.name, props.type ?? ''));
</script>

<style scoped>
.file-row {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  min-height: 44px;
  min-width: 0;
}

.file-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-2);
}

.file-icon.image {
  background: var(--success-soft);
  color: var(--success);
}

.file-icon.video,
.file-icon.audio {
  background: var(--warning-soft);
  color: var(--warning);
}

.file-icon.pdf {
  background: var(--danger-soft);
  color: var(--danger);
}

.file-icon.archive,
.file-icon.doc,
.file-icon.code {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.file-name {
  flex: 1;
  font-size: var(--text-sm);
  font-weight: 500;
}

.file-size {
  flex-shrink: 0;
}
</style>
