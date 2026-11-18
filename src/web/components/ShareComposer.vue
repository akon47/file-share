<template>
  <section class="card composer" aria-labelledby="composer-title">
    <div class="card-head">
      <div>
        <h2 id="composer-title">공유 만들기</h2>
        <p class="lead">링크·QR·6자리 코드로 어디서든 받을 수 있어요.</p>
      </div>
    </div>
    <div class="card-body">
      <div
        v-if="files.length === 0"
        class="dropzone"
        :class="{ dragging }"
        role="button"
        tabindex="0"
        @click="input?.click()"
        @keydown.enter.prevent="input?.click()"
        @keydown.space.prevent="input?.click()"
        @dragenter.prevent="dragging = true"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="drop"
      >
        <span class="drop-icon"><AppIcon name="upload" :size="26" /></span>
        <strong>파일을 끌어다 놓거나 눌러서 고르세요</strong>
        <span class="subtle small">여러 개도 돼요 · 크기 제한 없음 · 붙여넣기(Ctrl+V)도 돼요</span>
      </div>

      <template v-else>
        <div class="file-summary">
          <strong>{{ formatFileCount(files.length) }}</strong>
          <span class="subtle num">{{ formatBytes(total) }}</span>
          <button class="btn btn-ghost btn-sm add" type="button" @click="input?.click()">
            <AppIcon name="plus" :size="16" /> 추가
          </button>
        </div>
        <ul class="file-list" :class="{ collapsed: files.length > 5 && !showAll }">
          <li v-for="(file, index) in visibleFiles" :key="`${file.name}-${index}`">
            <FileRow :name="file.name" :size="file.size" :type="file.type">
              <button
                class="btn btn-icon btn-sm"
                type="button"
                :aria-label="`${file.name} 빼기`"
                @click="files.splice(index, 1)"
              >
                <AppIcon name="x" :size="16" />
              </button>
            </FileRow>
          </li>
        </ul>
        <button
          v-if="files.length > 5 && !showAll"
          class="btn btn-ghost btn-sm more"
          type="button"
          @click="showAll = true"
        >
          {{ files.length - 5 }}개 더 보기
        </button>

        <div class="options">
          <div class="field">
            <label for="share-title">제목 <span class="subtle">(선택)</span></label>
            <input
              id="share-title"
              v-model="title"
              class="input"
              type="text"
              :maxlength="LIMITS.titleMax"
              placeholder="예: 회의 자료, 여행 사진"
              autocomplete="off"
            />
          </div>

          <div class="option">
            <div class="option-text">
              <span class="option-title"><AppIcon name="lock" :size="16" /> 비밀번호</span>
              <span class="hint">받는 사람이 입력해야 해요. 서버로는 보내지 않아요.</span>
            </div>
            <label class="switch">
              <input v-model="usePassword" type="checkbox" aria-label="비밀번호 사용" />
              <span class="switch-track" />
            </label>
          </div>
          <div v-if="usePassword" class="password-row">
            <input
              ref="passwordInput"
              v-model="password"
              class="input"
              :type="showPassword ? 'text' : 'password'"
              placeholder="비밀번호"
              autocomplete="new-password"
              maxlength="128"
            />
            <button
              class="btn btn-icon"
              type="button"
              :aria-label="showPassword ? '비밀번호 숨기기' : '비밀번호 보기'"
              @click="showPassword = !showPassword"
            >
              <AppIcon :name="showPassword ? 'eye-off' : 'eye'" :size="18" />
            </button>
          </div>

          <div class="option">
            <div class="option-text">
              <span class="option-title"><AppIcon name="user-check" :size="16" /> 받는 사람마다 승인</span>
              <span class="hint">누가 받으려 하면 내가 허용해야 시작돼요.</span>
            </div>
            <label class="switch">
              <input v-model="approval" type="checkbox" aria-label="받는 사람마다 승인" />
              <span class="switch-track" />
            </label>
          </div>

          <div class="option">
            <div class="option-text">
              <span class="option-title"><AppIcon name="wifi" :size="16" /> 같은 네트워크에 표시</span>
              <span class="hint">가까운 기기의 화면에 이 공유가 보여요.</span>
            </div>
            <label class="switch">
              <input v-model="lan" type="checkbox" aria-label="같은 네트워크에 표시" />
              <span class="switch-track" />
            </label>
          </div>

          <div class="option">
            <div class="option-text">
              <span class="option-title"><AppIcon name="users" :size="16" /> 받을 수 있는 사람</span>
              <span class="hint">다 받으면 공유가 자동으로 닫혀요.</span>
            </div>
            <select v-model="maxReceivers" class="input select limit" aria-label="받을 수 있는 사람 수">
              <option :value="0">제한 없음</option>
              <option :value="1">1명</option>
              <option :value="3">3명</option>
              <option :value="10">10명</option>
            </select>
          </div>
        </div>

        <div class="actions">
          <button class="btn btn-ghost" type="button" @click="reset">취소</button>
          <button class="btn btn-lg start" type="button" :disabled="!canStart" @click="start">
            <span v-if="starting" class="spinner on-accent" />
            <AppIcon v-else name="link" :size="18" />
            공유 시작
          </button>
        </div>
        <p class="tiny subtle keep-open">
          <AppIcon name="info" :size="14" /> 이 탭을 열어 둔 동안만 받을 수 있어요. 파일은 이 기기에서 바로 전송돼요.
        </p>
      </template>
      <input ref="input" type="file" multiple hidden @change="picked" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { LIMITS } from '@shared/protocol';
import { formatBytes, formatFileCount } from '@/lib/format';
import { openShare } from '@/lib/shares';
import { net, RequestError } from '@/lib/signaling';
import { toast } from '@/lib/ui';
import AppIcon from './AppIcon.vue';
import FileRow from './FileRow.vue';

const input = ref<HTMLInputElement | null>(null);
const passwordInput = ref<HTMLInputElement | null>(null);
const files = ref<File[]>([]);
const dragging = ref(false);
const showAll = ref(false);
const title = ref('');
const usePassword = ref(false);
const password = ref('');
const showPassword = ref(false);
const approval = ref(false);
const lan = ref(true);
const maxReceivers = ref(0);
const starting = ref(false);

const total = computed(() => files.value.reduce((sum, f) => sum + f.size, 0));
const visibleFiles = computed(() => (showAll.value ? files.value : files.value.slice(0, 5)));
const canStart = computed(
  () =>
    files.value.length > 0 &&
    !starting.value &&
    net.status === 'online' &&
    (!usePassword.value || password.value.length > 0),
);

watch(usePassword, async (on) => {
  if (on) {
    await nextTick();
    passwordInput.value?.focus();
  }
});

function add(list: File[]): void {
  if (list.length === 0) return;
  files.value = [...files.value, ...list];
}

function picked(event: Event): void {
  const target = event.target as HTMLInputElement;
  add([...(target.files ?? [])]);
  target.value = '';
}

function drop(event: DragEvent): void {
  dragging.value = false;
  add([...(event.dataTransfer?.files ?? [])].filter((f) => f.size > 0 || f.type !== ''));
}

function onPaste(event: ClipboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
  const pasted = [...(event.clipboardData?.files ?? [])];
  if (pasted.length) {
    event.preventDefault();
    add(pasted);
  }
}

onMounted(() => window.addEventListener('paste', onPaste));
onBeforeUnmount(() => window.removeEventListener('paste', onPaste));

function reset(): void {
  files.value = [];
  title.value = '';
  usePassword.value = false;
  password.value = '';
  approval.value = false;
  lan.value = true;
  maxReceivers.value = 0;
  showAll.value = false;
}

async function start(): Promise<void> {
  if (!canStart.value) return;
  starting.value = true;
  try {
    await openShare({
      files: files.value,
      title: title.value,
      password: usePassword.value ? password.value : '',
      approval: approval.value,
      lan: lan.value,
      maxReceivers: maxReceivers.value > 0 ? maxReceivers.value : null,
    });
    reset();
    toast.success('공유를 시작했어요. 링크나 코드를 보내 주세요.');
  } catch (error) {
    toast.error(
      error instanceof RequestError && error.code === 'too-many-shares'
        ? '동시에 열 수 있는 공유는 10개까지예요.'
        : '공유를 시작하지 못했어요. 잠시 후 다시 시도해 주세요.',
    );
  } finally {
    starting.value = false;
  }
}

defineExpose({ add });
</script>

<style scoped>
.dropzone {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: var(--s-10) var(--s-4);
  border: 2px dashed var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--surface-2);
  text-align: center;
  cursor: pointer;
  transition:
    border-color var(--ease),
    background-color var(--ease);
}

.dropzone:hover,
.dropzone.dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.drop-icon {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin-bottom: var(--s-2);
  border-radius: 50%;
  background: var(--surface);
  color: var(--accent);
  box-shadow: var(--shadow-sm);
}

.file-summary {
  display: flex;
  align-items: baseline;
  gap: var(--s-2);
  margin-bottom: var(--s-2);
}

.file-summary .add {
  margin-left: auto;
}

.file-list {
  display: grid;
  border-top: 1px solid var(--border);
}

.file-list li {
  border-bottom: 1px solid var(--border);
}

.more {
  margin-top: var(--s-2);
}

.options {
  display: grid;
  gap: var(--s-4);
  margin-top: var(--s-5);
}

.option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
}

.option-text {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.option-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  font-weight: 600;
}

.option-title svg {
  color: var(--text-3);
}

.password-row {
  display: flex;
  gap: var(--s-2);
  margin-top: calc(var(--s-2) * -1);
}

.limit {
  width: auto;
  min-width: 120px;
  min-height: 36px;
  padding-block: 6px;
  font-size: var(--text-sm);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-6);
}

.start {
  flex: 1;
  max-width: 240px;
}

.spinner.on-accent {
  border-color: rgba(255, 255, 255, 0.35);
  border-top-color: var(--on-accent);
}

.keep-open {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--s-3);
}
</style>
