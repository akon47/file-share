<template>
  <main class="container container-narrow page receive">
    <RouterLink class="back small" to="/"><AppIcon name="arrow-left" :size="16" /> 처음으로</RouterLink>

    <section class="card">
      <!-- who is sending -->
      <div v-if="s.share" class="sender">
        <DeviceAvatar :name="s.share.ownerName" :device="s.share.ownerDevice" size="lg" />
        <div class="sender-text">
          <span class="tiny subtle">보낸 사람</span>
          <h1 class="ellipsis">{{ s.title || s.share.title || `${s.share.ownerName}님의 파일` }}</h1>
          <p class="small muted num">
            {{ s.share.ownerName }} · {{ formatFileCount(s.share.fileCount) }} · {{ formatBytes(s.share.totalSize) }}
          </p>
          <div class="badges">
            <span v-if="s.verified" class="badge badge-success" title="링크의 비밀 키로 보내는 사람을 확인했어요">
              <AppIcon name="shield" :size="12" /> 확인된 연결
            </span>
            <span v-if="s.share.locked" class="badge badge-warning"><AppIcon name="lock" :size="12" /> 비밀번호</span>
            <span v-if="s.kind === 'local'" class="badge badge-accent"
              ><AppIcon name="wifi" :size="12" /> 같은 네트워크 직결</span
            >
            <span v-else-if="s.kind === 'p2p'" class="badge badge-accent"
              ><AppIcon name="zap" :size="12" /> P2P 직결</span
            >
          </div>
        </div>
      </div>

      <div class="card-body">
        <!-- lookup / connecting -->
        <div v-if="['lookup', 'connecting', 'verifying'].includes(s.phase)" class="state">
          <span class="spinner big" />
          <h2>
            {{
              s.phase === 'lookup'
                ? '공유를 찾는 중…'
                : s.phase === 'verifying'
                  ? '비밀번호 확인 중…'
                  : '보내는 사람과 연결하는 중…'
            }}
          </h2>
          <p class="small muted">기기끼리 직접 연결하고 있어요. 보통 몇 초면 돼요.</p>
        </div>

        <!-- password -->
        <form v-else-if="s.phase === 'password'" class="state password" @submit.prevent="submitPassword">
          <span class="state-icon warning"><AppIcon name="lock" :size="26" /></span>
          <h2>비밀번호가 필요해요</h2>
          <p class="small muted">보내는 사람에게 받은 비밀번호를 입력하세요.</p>
          <div class="password-row">
            <input
              ref="passwordInput"
              v-model="password"
              class="input"
              :class="{ invalid: !!s.passwordError }"
              type="password"
              placeholder="비밀번호"
              autocomplete="off"
              maxlength="128"
            />
            <button class="btn" type="submit" :disabled="!password">확인</button>
          </div>
          <p v-if="s.passwordError" class="error-text">{{ s.passwordError }}</p>
        </form>

        <!-- approval -->
        <div v-else-if="s.phase === 'approval'" class="state">
          <span class="state-icon"><AppIcon name="user-check" :size="26" /></span>
          <h2>보내는 사람의 승인을 기다리는 중</h2>
          <p class="small muted">{{ s.share?.ownerName }}님이 허용하면 파일 목록이 보여요.</p>
          <span class="spinner" />
        </div>

        <!-- file list -->
        <template v-else-if="['ready', 'receiving', 'reconnecting', 'done'].includes(s.phase)">
          <div v-if="s.phase === 'done'" class="done-banner">
            <span class="done-icon"><AppIcon name="check" :size="22" :stroke-width="3" /></span>
            <div>
              <strong>받기 완료</strong>
              <p class="small muted">
                {{ s.mode === 'memory' ? '브라우저가 파일 저장을 시작했어요.' : '다운로드 폴더에 저장됐어요.' }}
              </p>
            </div>
          </div>

          <div class="list-head">
            <label v-if="s.files.length > 1 && !busy" class="check-all">
              <input type="checkbox" :checked="allSelected" @change="toggleAll" />
              <span class="small">전체 선택</span>
            </label>
            <span v-else class="small subtle">{{ formatFileCount(s.files.length) }}</span>
            <span class="small subtle num">{{ formatBytes(selectedBytes) }}</span>
          </div>
          <ul class="files">
            <li v-for="file in s.files" :key="file.id" :class="{ dim: busy && !s.selected.includes(file.id) }">
              <label class="file-line">
                <input
                  v-if="s.files.length > 1"
                  v-model="s.selected"
                  type="checkbox"
                  :value="file.id"
                  :disabled="busy"
                  :aria-label="`${file.name} 선택`"
                />
                <FileRow :name="file.name" :size="file.size" :type="file.type">
                  <AppIcon
                    v-if="s.downloadedIds.includes(file.id)"
                    class="got"
                    name="check-circle"
                    :size="18"
                    title="받음"
                  />
                  <button
                    v-if="s.files.length > 1 && !busy"
                    class="btn btn-icon btn-sm"
                    type="button"
                    :aria-label="`${file.name} 받기`"
                    :title="s.downloadedIds.includes(file.id) ? '이 파일 다시 받기' : '이 파일만 받기'"
                    @click.prevent="controller.download([file.id])"
                  >
                    <AppIcon name="download" :size="16" />
                  </button>
                </FileRow>
              </label>
            </li>
          </ul>

          <div v-if="busy" class="progress-box">
            <p v-if="s.phase === 'reconnecting'" class="reconnecting small">
              <span class="spinner" /> 연결이 끊겼어요. 다시 연결해서 끊긴 곳부터 이어 받을게요…
            </p>
            <div class="progress-top">
              <span class="small ellipsis">{{ s.currentFile }}</span>
              <strong class="num">{{ Math.floor(percent(s.received, s.total)) }}%</strong>
            </div>
            <div class="progress" :class="{ paused: s.phase === 'reconnecting' }">
              <span :style="{ width: `${percent(s.received, s.total)}%` }" />
            </div>
            <div class="progress-bottom tiny subtle num">
              <span>{{ formatBytes(s.received) }} / {{ formatBytes(s.total) }}</span>
              <span
                >{{ formatSpeed(s.speed) }}<template v-if="eta"> · {{ eta }} 남음</template></span
              >
            </div>
            <button class="btn btn-secondary btn-block" type="button" @click="controller.cancel()">멈추기</button>
          </div>
          <button
            v-else
            class="btn btn-lg btn-block download"
            type="button"
            :disabled="s.selected.length === 0"
            @click="controller.download()"
          >
            <AppIcon name="download" :size="18" />
            {{ downloadLabel }}
          </button>
          <p v-if="!busy && s.selected.length > 1" class="tiny subtle zip-note">
            여러 파일은 zip 파일 하나로 받아요. 하나씩 받으려면 파일 옆의 받기 버튼을 누르세요.
          </p>
        </template>

        <!-- gone -->
        <div v-else-if="s.phase === 'gone'" class="state">
          <span class="state-icon muted-icon"><AppIcon name="inbox" :size="26" /></span>
          <h2>공유가 끝났어요</h2>
          <p class="small muted">
            {{ s.error || '보내는 사람이 공유를 끝냈거나 페이지를 닫았어요. 주소가 맞는지도 확인해 주세요.' }}
          </p>
          <RouterLink class="btn btn-secondary" to="/">처음으로</RouterLink>
        </div>

        <!-- own share -->
        <div v-else-if="s.phase === 'own'" class="state">
          <span class="state-icon"><AppIcon name="info" :size="26" /></span>
          <h2>내가 공유한 파일이에요</h2>
          <p class="small muted">이 링크를 다른 기기나 다른 사람에게 보내 주세요.</p>
          <RouterLink class="btn btn-secondary" to="/">공유 관리로</RouterLink>
        </div>

        <!-- error -->
        <div v-else-if="s.phase === 'error'" class="state">
          <span class="state-icon danger"><AppIcon name="alert" :size="26" /></span>
          <h2>받을 수 없어요</h2>
          <p class="small muted">{{ s.error }}</p>
          <button class="btn" type="button" @click="controller.retry()">
            <AppIcon name="refresh" :size="16" /> 다시 시도
          </button>
        </div>
      </div>
    </section>

    <p class="footnote tiny subtle">
      <AppIcon name="shield" :size="14" />
      파일은 서버를 거치지 않고 보내는 사람의 브라우저에서 바로, 암호화된 연결로 전송돼요. 보내는 사람이 페이지를 닫으면
      받을 수 없어요.
    </p>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { isSecret } from '@shared/auth';
import AppIcon from '@/components/AppIcon.vue';
import DeviceAvatar from '@/components/DeviceAvatar.vue';
import FileRow from '@/components/FileRow.vue';
import { formatBytes, formatDuration, formatFileCount, formatSpeed, percent } from '@/lib/format';
import { ReceiveController } from '@/lib/receive';
import { confirmDialog } from '@/lib/ui';

const route = useRoute();
const shareId = String(route.params.id);
const controller = new ReceiveController(shareId, readSecret(shareId));

/**
 * The link secret (after `#`) is read once and then removed from the address bar, so it does not end up in
 * screenshots or synced history. It is kept for this tab (sessionStorage) so a reload still verifies the sender.
 */
function readSecret(id: string): string | null {
  const key = `fs.secret.${id}`;
  const fromHash = location.hash.slice(1);
  if (fromHash) {
    history.replaceState(history.state, '', location.pathname + location.search);
    if (isSecret(fromHash)) {
      try {
        sessionStorage.setItem(key, fromHash);
      } catch {
        // storage unavailable: the secret still works for this page view
      }
      return fromHash;
    }
  }
  try {
    const stored = sessionStorage.getItem(key);
    return stored && isSecret(stored) ? stored : null;
  } catch {
    return null;
  }
}
const s = controller.state;
void controller.start();

const password = ref('');
const passwordInput = ref<HTMLInputElement | null>(null);

watch(
  () => s.phase,
  async (phase) => {
    if (phase === 'password') {
      await nextTick();
      passwordInput.value?.focus();
      passwordInput.value?.select();
    }
  },
);

async function submitPassword(): Promise<void> {
  await controller.submitPassword(password.value);
}

const busy = computed(() => s.phase === 'receiving' || s.phase === 'reconnecting');
const allSelected = computed(() => s.selected.length === s.files.length);
const selectedBytes = computed(() =>
  s.files.filter((f) => s.selected.includes(f.id)).reduce((sum, f) => sum + f.size, 0),
);
const downloadLabel = computed(() => {
  if (s.selected.length === s.files.length) return s.files.length > 1 ? '모두 받기' : '받기';
  return `선택한 ${s.selected.length}개 받기`;
});
const eta = computed(() => (s.speed > 0 ? formatDuration((s.total - s.received) / s.speed) : ''));

function toggleAll(): void {
  s.selected = allSelected.value ? [] : s.files.map((f) => f.id);
}

onBeforeRouteLeave(async () => {
  if (!busy.value) return true;
  return confirmDialog({
    title: '받기를 멈추고 나갈까요?',
    message: '지금 받고 있는 파일은 저장되지 않아요.',
    confirmText: '나가기',
    danger: true,
  });
});

onBeforeUnmount(() => controller.dispose());
</script>

<style scoped>
.back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: var(--s-4);
  color: var(--text-2);
}

.sender {
  display: flex;
  gap: var(--s-4);
  align-items: center;
  padding: var(--s-6) var(--s-6) var(--s-5);
  border-bottom: 1px solid var(--border);
}

.sender-text {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.sender h1 {
  font-size: var(--text-xl);
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.badges:empty {
  display: none;
}

.state {
  display: grid;
  justify-items: center;
  gap: var(--s-3);
  padding: var(--s-6) 0;
  text-align: center;
}

.state h2 {
  font-size: var(--text-lg);
}

.state p {
  max-width: 420px;
}

.spinner.big {
  width: 36px;
  height: 36px;
  border-width: 3px;
}

.state-icon {
  display: grid;
  place-items: center;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-text);
}

.state-icon.warning {
  background: var(--warning-soft);
  color: var(--warning);
}

.state-icon.danger {
  background: var(--danger-soft);
  color: var(--danger);
}

.state-icon.muted-icon {
  background: var(--surface-2);
  color: var(--text-3);
}

.password-row {
  display: flex;
  gap: var(--s-2);
  width: min(100%, 360px);
}

.done-banner {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  margin-bottom: var(--s-4);
  padding: var(--s-3) var(--s-4);
  border-radius: var(--radius);
  background: var(--success-soft);
}

.done-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--success);
  color: #fff;
  animation: pop 0.35s cubic-bezier(0.3, 1.6, 0.5, 1);
}

@keyframes pop {
  from {
    transform: scale(0.3);
  }
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: var(--s-2);
  border-bottom: 1px solid var(--border);
}

.check-all {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  cursor: pointer;
}

input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
  flex-shrink: 0;
}

.files {
  display: grid;
  max-height: 420px;
  overflow: auto;
  margin-bottom: var(--s-5);
}

.files li {
  border-bottom: 1px solid var(--border);
}

.files li.dim {
  opacity: 0.45;
}

.file-line {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  cursor: pointer;
}

.file-line > :last-child {
  flex: 1;
}

.got {
  color: var(--success);
}

.progress-box {
  display: grid;
  gap: var(--s-2);
}

.progress-top,
.progress-bottom {
  display: flex;
  justify-content: space-between;
  gap: var(--s-3);
}

.reconnecting {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--radius);
  background: var(--warning-soft);
  color: var(--warning);
  font-weight: 600;
}

.reconnecting .spinner {
  width: 14px;
  height: 14px;
  border-top-color: var(--warning);
}

.progress.paused > span {
  background: var(--warning);
}

.progress-box .btn {
  margin-top: var(--s-2);
}

.zip-note {
  margin-top: var(--s-2);
  text-align: center;
}

.footnote {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: var(--s-4);
  line-height: 1.5;
}

.footnote svg {
  margin-top: 1px;
}

@media (max-width: 640px) {
  .sender {
    padding: var(--s-5) var(--s-4) var(--s-4);
  }
}
</style>
