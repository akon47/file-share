<template>
  <section v-if="others.length" class="card" aria-labelledby="lan-shares-title">
    <div class="card-head">
      <div>
        <h2 id="lan-shares-title">같은 네트워크의 공유</h2>
        <p class="lead">가까운 기기가 공유 중인 파일이에요.</p>
      </div>
    </div>
    <div class="card-body list">
      <RouterLink v-for="s in others" :key="s.id" class="share-item" :to="`/s/${s.id}`">
        <DeviceAvatar :name="s.ownerName" :device="s.ownerDevice" size="sm" />
        <div class="main">
          <div class="title ellipsis">{{ s.title || `${s.ownerName}의 파일` }}</div>
          <div class="meta tiny subtle num">
            {{ s.ownerName }} · {{ formatFileCount(s.fileCount) }} · {{ formatBytes(s.totalSize) }}
          </div>
        </div>
        <span v-if="s.locked" class="badge badge-warning" title="비밀번호가 필요해요"
          ><AppIcon name="lock" :size="12"
        /></span>
        <AppIcon class="go" name="arrow-right" :size="18" />
      </RouterLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatBytes, formatFileCount } from '@/lib/format';
import { net } from '@/lib/signaling';
import AppIcon from './AppIcon.vue';
import DeviceAvatar from './DeviceAvatar.vue';

const others = computed(() => net.shares.filter((s) => s.owner !== net.myId));
</script>

<style scoped>
.list {
  display: grid;
  gap: var(--s-2);
}

.share-item {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  transition:
    border-color var(--ease),
    background-color var(--ease);
}

.share-item:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
  text-decoration: none;
}

.main {
  flex: 1;
  min-width: 0;
}

.title {
  font-size: var(--text-sm);
  font-weight: 600;
}

.go {
  color: var(--text-3);
}
</style>
