<template>
  <div class="my-device">
    <DeviceAvatar :name="settings.name" :device="device" size="lg" me />
    <div class="text">
      <span class="tiny subtle">내 기기</span>
      <div class="name-row">
        <strong class="name ellipsis">{{ settings.name }}</strong>
        <button class="btn btn-icon btn-sm" type="button" aria-label="이름 바꾸기" title="이름 바꾸기" @click="rename">
          <AppIcon name="pen" :size="15" />
        </button>
      </div>
      <span class="tiny subtle">{{ deviceLabel(device) }}</span>
    </div>
    <label class="visible">
      <span class="tiny">{{ settings.visible ? '다른 기기에 보임' : '숨김' }}</span>
      <span class="switch">
        <input v-model="settings.visible" type="checkbox" aria-label="같은 네트워크의 다른 기기에 내 기기 보이기" />
        <span class="switch-track" />
      </span>
    </label>
  </div>
</template>

<script setup lang="ts">
import { LIMITS } from '@shared/protocol';
import { deviceLabel } from '@/lib/device';
import { cleanName, settings } from '@/lib/settings';
import { device } from '@/lib/signaling';
import { promptDialog } from '@/lib/ui';
import AppIcon from './AppIcon.vue';
import DeviceAvatar from './DeviceAvatar.vue';

async function rename(): Promise<void> {
  const value = await promptDialog({
    title: '기기 이름 바꾸기',
    message: '같은 네트워크의 다른 기기와 받는 사람에게 이 이름이 보여요.',
    value: settings.name,
    maxLength: LIMITS.nameMax,
    confirmText: '저장',
  });
  const name = value ? cleanName(value) : '';
  if (name) settings.name = name;
}
</script>

<style scoped>
.my-device {
  display: flex;
  align-items: center;
  gap: var(--s-4);
  padding: var(--s-4) var(--s-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}

.text {
  display: grid;
  min-width: 0;
  flex: 1;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.name {
  font-size: var(--text-lg);
}

.visible {
  display: grid;
  justify-items: end;
  gap: 4px;
  color: var(--text-3);
  cursor: pointer;
}
</style>
