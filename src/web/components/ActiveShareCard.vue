<template>
  <section class="card share" :class="share.status" :aria-label="`공유: ${heading}`">
    <div class="card-head">
      <div class="head-text">
        <span class="live" :class="share.status">
          <span class="dot" /> {{ share.status === 'active' ? '공유 중' : '받기 횟수를 모두 채웠어요' }}
        </span>
        <h2 class="ellipsis" :title="heading">{{ heading }}</h2>
        <p class="lead num">{{ formatFileCount(share.metas.length) }} · {{ formatBytes(share.totalSize) }}</p>
      </div>
      <button class="btn btn-danger-ghost btn-sm" type="button" @click="stop">
        <AppIcon name="x" :size="16" /> 공유 끝내기
      </button>
    </div>

    <div class="card-body">
      <div class="badges">
        <span v-if="share.hasPassword" class="badge badge-warning"><AppIcon name="lock" :size="12" /> 비밀번호</span>
        <span v-if="share.approval" class="badge badge-accent"><AppIcon name="user-check" :size="12" /> 승인 필요</span>
        <span v-if="share.lan" class="badge"><AppIcon name="wifi" :size="12" /> 같은 네트워크에 표시</span>
        <span
          v-if="share.lan && !share.hasPassword && !share.approval"
          class="badge badge-accent"
          title="링크 없이 목록이나 코드로 들어온 사람은 내가 허용해야 받을 수 있어요"
        >
          <AppIcon name="user-check" :size="12" /> 링크 없는 사람은 승인
        </span>
        <span v-if="share.maxReceivers" class="badge num">
          <AppIcon name="users" :size="12" /> {{ share.completed }} / {{ share.maxReceivers }}명
        </span>
      </div>

      <template v-if="share.status === 'active'">
        <div class="link-row">
          <input class="input mono link" :value="share.link" readonly aria-label="공유 링크" @focus="selectAll" />
          <button class="btn" type="button" @click="copyText(share.link, '링크를 복사했어요')">
            <AppIcon name="copy" :size="16" /> 복사
          </button>
        </div>

        <div class="code-row">
          <div class="code-block">
            <span class="tiny subtle">받는 쪽에서 입력할 코드</span>
            <button class="code num" type="button" title="코드 복사" @click="copyText(share.code, '코드를 복사했어요')">
              {{ formatCode(share.code) }}
            </button>
          </div>
          <div class="code-actions">
            <button v-if="canShare" class="btn btn-secondary btn-sm" type="button" @click="nativeShare">
              <AppIcon name="send" :size="14" /> 보내기
            </button>
            <button class="btn btn-secondary btn-sm" type="button" :aria-expanded="showQr" @click="showQr = !showQr">
              <AppIcon name="qr" :size="14" /> QR
            </button>
          </div>
        </div>
        <div v-if="showQr" class="qr-wrap">
          <QrCode :value="share.link" label="공유 링크 QR 코드" />
          <p class="tiny subtle">휴대폰 카메라로 찍으면 바로 열려요.</p>
        </div>
      </template>

      <div class="receivers">
        <div class="receivers-head">
          <h3>받는 사람</h3>
          <span class="tiny subtle">{{ share.receivers.length ? `${share.receivers.length}명` : '' }}</span>
        </div>
        <p v-if="share.receivers.length === 0" class="small subtle waiting">
          <span class="spinner" /> 링크나 코드를 연 사람이 여기에 나타나요.
        </p>
        <ul v-else class="receiver-list">
          <li v-for="r in share.receivers" :key="r.sid" class="receiver" :class="r.status">
            <DeviceAvatar :name="r.peer.name" :device="r.peer.device" size="sm" />
            <div class="receiver-main">
              <div class="receiver-line">
                <span class="receiver-name ellipsis">{{ r.peer.name }}</span>
                <span class="badge" :class="statusBadge(r.status)">{{ statusText(r) }}</span>
              </div>
              <div v-if="r.status === 'sending'" class="progress-line">
                <div class="progress"><span :style="{ width: `${percent(r.sent, r.total)}%` }" /></div>
                <span class="tiny subtle num"
                  >{{ Math.floor(percent(r.sent, r.total)) }}% · {{ formatSpeed(r.speed) }}</span
                >
              </div>
            </div>
            <div v-if="r.status === 'approval'" class="approve">
              <button class="btn btn-ghost btn-sm" type="button" @click="r.deny()">거절</button>
              <button class="btn btn-sm" type="button" @click="r.approve()">허용</button>
            </div>
            <button
              v-else-if="['browsing', 'sending', 'done'].includes(r.status)"
              class="btn btn-icon btn-sm"
              type="button"
              :aria-label="`${r.peer.name} 연결 끊기`"
              title="연결 끊기"
              @click="disconnect(r)"
            >
              <AppIcon name="x" :size="16" />
            </button>
          </li>
        </ul>
      </div>

      <div class="toggles">
        <label class="toggle">
          <span class="small">같은 네트워크에 표시</span>
          <span class="switch">
            <input
              type="checkbox"
              :checked="share.lan"
              :disabled="share.status !== 'active'"
              @change="setShareOption(share.key, { lan: ($event.target as HTMLInputElement).checked })"
            />
            <span class="switch-track" />
          </span>
        </label>
        <label class="toggle">
          <span class="small">받는 사람마다 승인</span>
          <span class="switch">
            <input
              type="checkbox"
              :checked="share.approval"
              @change="setShareOption(share.key, { approval: ($event.target as HTMLInputElement).checked })"
            />
            <span class="switch-track" />
          </span>
        </label>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatBytes, formatCode, formatFileCount, formatSpeed, percent } from '@/lib/format';
import { closeShare, setShareOption, type MyShare, type ReceiverStatus, type ShareReceiver } from '@/lib/shares';
import { confirmDialog, copyText } from '@/lib/ui';
import AppIcon from './AppIcon.vue';
import DeviceAvatar from './DeviceAvatar.vue';
import QrCode from './QrCode.vue';

const props = defineProps<{ share: MyShare }>();
const showQr = ref(false);
const canShare = typeof navigator.share === 'function';

const heading = computed(() => {
  if (props.share.title) return props.share.title;
  const first = props.share.metas[0]?.name ?? '공유';
  return props.share.metas.length > 1 ? `${first} 외 ${props.share.metas.length - 1}개` : first;
});

function selectAll(event: FocusEvent): void {
  (event.target as HTMLInputElement).select();
}

async function nativeShare(): Promise<void> {
  try {
    await navigator.share({ title: heading.value, text: `file-share 코드 ${props.share.code}`, url: props.share.link });
  } catch {
    // cancelled
  }
}

async function stop(): Promise<void> {
  const busy = props.share.receivers.some((r) => r.status === 'sending');
  if (
    busy &&
    !(await confirmDialog({
      title: '공유를 끝낼까요?',
      message: '지금 받고 있는 사람의 전송도 멈춰요.',
      confirmText: '끝내기',
      danger: true,
    }))
  ) {
    return;
  }
  closeShare(props.share.key);
}

async function disconnect(r: ShareReceiver): Promise<void> {
  if (
    r.status === 'sending' &&
    !(await confirmDialog({ title: `${r.peer.name} 연결을 끊을까요?`, confirmText: '끊기', danger: true }))
  ) {
    return;
  }
  r.disconnect();
}

function statusText(r: ShareReceiver): string {
  const map: Record<ReceiverStatus, string> = {
    auth: '확인 중',
    approval: '승인 대기',
    browsing: '파일 고르는 중',
    sending: '보내는 중',
    done: '받기 완료',
    denied: '거절함',
    failed: '실패',
    left: '연결 끊김',
  };
  return map[r.status];
}

function statusBadge(status: ReceiverStatus): string {
  if (status === 'done') return 'badge-success';
  if (status === 'approval') return 'badge-warning';
  if (status === 'sending' || status === 'browsing') return 'badge-accent';
  if (status === 'failed' || status === 'denied') return 'badge-danger';
  return '';
}
</script>

<style scoped>
.share {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.share.full {
  border-color: var(--border);
  box-shadow: none;
}

.card-head {
  align-items: flex-start;
}

.head-text {
  min-width: 0;
}

.live {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  color: var(--success);
  font-size: var(--text-xs);
  font-weight: 700;
}

.live .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: breathe 1.8s ease-in-out infinite;
}

.live.full {
  color: var(--text-3);
}

.live.full .dot {
  animation: none;
}

@keyframes breathe {
  50% {
    box-shadow: 0 0 0 4px var(--success-soft);
  }
}

.badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: var(--s-4);
}

.badges:empty {
  display: none;
}

.link-row {
  display: flex;
  gap: var(--s-2);
}

.link {
  font-size: var(--text-sm);
  min-width: 0;
}

.link-row .btn {
  height: auto;
}

.code-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--s-3);
  margin-top: var(--s-4);
}

.code-block {
  display: grid;
}

.code {
  font-size: 32px;
  font-weight: 800;
  letter-spacing: 0.08em;
  line-height: 1.2;
  text-align: left;
  color: var(--text);
}

.code:hover {
  color: var(--accent-text);
}

.code-actions {
  display: flex;
  gap: 6px;
}

.qr-wrap {
  display: grid;
  justify-items: center;
  gap: var(--s-2);
  width: 200px;
  margin: var(--s-4) auto 0;
  text-align: center;
}

.receivers {
  margin-top: var(--s-6);
  padding-top: var(--s-4);
  border-top: 1px solid var(--border);
}

.receivers-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--s-2);
}

.receivers-head h3 {
  font-size: var(--text-sm);
}

.waiting {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding-block: var(--s-2);
}

.waiting .spinner {
  width: 14px;
  height: 14px;
}

.receiver-list {
  display: grid;
  gap: 2px;
}

.receiver {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-2) 0;
}

.receiver.approval {
  margin-inline: calc(var(--s-2) * -1);
  padding-inline: var(--s-2);
  border-radius: var(--radius);
  background: var(--warning-soft);
}

.receiver.left,
.receiver.failed,
.receiver.denied {
  opacity: 0.6;
}

.receiver-main {
  flex: 1;
  min-width: 0;
}

.receiver-line {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}

.receiver-name {
  font-size: var(--text-sm);
  font-weight: 600;
}

.progress-line {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: var(--s-2);
  margin-top: 4px;
}

.approve {
  display: flex;
  gap: 4px;
}

.toggles {
  display: grid;
  gap: var(--s-3);
  margin-top: var(--s-4);
  padding-top: var(--s-4);
  border-top: 1px solid var(--border);
}

.toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  color: var(--text-2);
  cursor: pointer;
}
</style>
