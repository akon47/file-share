<template>
  <span class="device-avatar" :class="[`size-${size}`, { me }]" :style="{ '--hue': hue }">
    <span class="glyph" aria-hidden="true">{{ glyph }}</span>
    <span v-if="device" class="device-badge" :title="deviceLabel(device)">
      <AppIcon :name="deviceIcon(device.type)" :size="size === 'lg' ? 14 : 11" :stroke-width="2.4" />
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DeviceInfo } from '@shared/protocol';
import { deviceIcon, deviceLabel } from '@/lib/device';
import { avatarGlyph, avatarHue } from '@/lib/names';
import AppIcon from './AppIcon.vue';

const props = withDefaults(
  defineProps<{ name: string; device?: DeviceInfo | null; size?: 'sm' | 'md' | 'lg'; me?: boolean }>(),
  { device: null, size: 'md', me: false },
);

const glyph = computed(() => avatarGlyph(props.name));
const hue = computed(() => avatarHue(props.name));
</script>

<style scoped>
.device-avatar {
  position: relative;
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  border-radius: 50%;
  background: oklch(var(--avatar-l) var(--avatar-c) var(--hue));
  box-shadow: inset 0 0 0 1px oklch(var(--avatar-ring) 0.09 var(--hue) / 0.25);
}

.size-sm {
  width: 32px;
  height: 32px;
  font-size: 17px;
}

.size-md {
  width: 48px;
  height: 48px;
  font-size: 25px;
}

.size-lg {
  width: 72px;
  height: 72px;
  font-size: 38px;
}

.glyph {
  line-height: 1;
  font-weight: 700;
  color: oklch(var(--avatar-ring) 0.12 var(--hue));
}

.me {
  box-shadow:
    0 0 0 2px var(--surface),
    0 0 0 4px var(--accent);
}

.device-badge {
  position: absolute;
  right: -3px;
  bottom: -3px;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-2);
  box-shadow: 0 0 0 1px var(--border);
}

.size-sm .device-badge {
  width: 16px;
  height: 16px;
  right: -4px;
  bottom: -4px;
}

.size-lg .device-badge {
  width: 26px;
  height: 26px;
}
</style>
