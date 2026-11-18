<template>
  <Teleport to="body">
    <div class="toasts" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="t.kind" role="status">
          <AppIcon :name="t.kind === 'success' ? 'check-circle' : t.kind === 'error' ? 'alert' : 'info'" :size="18" />
          <span>{{ t.message }}</span>
        </div>
      </TransitionGroup>
    </div>

    <Transition name="fade">
      <div v-if="dialog" class="overlay" @mousedown.self="answer(dialog, null)">
        <form
          class="dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="`dialog-title-${dialog.id}`"
          @submit.prevent="answer(dialog, dialog.field ? dialog.field.value : true)"
          @keydown.esc="answer(dialog, null)"
        >
          <h2 :id="`dialog-title-${dialog.id}`">{{ dialog.title }}</h2>
          <p v-if="dialog.message" class="message">{{ dialog.message }}</p>
          <input
            v-if="dialog.field"
            ref="input"
            v-model="dialog.field.value"
            class="input"
            :type="dialog.field.type"
            :placeholder="dialog.field.placeholder"
            :maxlength="dialog.field.maxLength"
            autocomplete="off"
          />
          <div class="buttons">
            <button class="btn btn-ghost" type="button" @click="answer(dialog, null)">{{ dialog.cancelText }}</button>
            <button
              class="btn"
              :class="{ 'btn-danger': dialog.danger }"
              type="submit"
              :disabled="!!dialog.field && !dialog.field.value.trim()"
            >
              {{ dialog.confirmText }}
            </button>
          </div>
        </form>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ui, type Dialog } from '@/lib/ui';
import AppIcon from './AppIcon.vue';

const input = ref<HTMLInputElement | null>(null);
const dialog = computed<Dialog | undefined>(() => ui.dialogs[0]);

watch(
  () => dialog.value?.id,
  async () => {
    await nextTick();
    if (input.value) {
      input.value.focus();
      input.value.select();
    } else {
      (document.querySelector('.dialog .btn[type="submit"]') as HTMLButtonElement | null)?.focus();
    }
  },
);

function answer(d: Dialog, value: string | boolean | null): void {
  const index = ui.dialogs.indexOf(d);
  if (index >= 0) ui.dialogs.splice(index, 1);
  d.resolve(value);
}
</script>

<style scoped>
.toasts {
  position: fixed;
  left: 50%;
  bottom: calc(24px + env(safe-area-inset-bottom, 0px));
  z-index: 300;
  display: grid;
  justify-items: center;
  gap: 8px;
  width: min(92vw, 440px);
  transform: translateX(-50%);
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: var(--radius);
  background: var(--text);
  color: var(--bg);
  font-size: var(--text-sm);
  font-weight: 500;
  box-shadow: var(--shadow-lg);
}

.toast.success svg {
  color: var(--success);
}

.toast.error svg {
  color: var(--danger);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.2s,
    transform 0.2s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

.overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  padding: 16px;
  background: var(--overlay);
}

.dialog {
  display: grid;
  gap: var(--s-4);
  width: min(100%, 400px);
  padding: var(--s-6);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}

.dialog h2 {
  font-size: var(--text-lg);
}

.message {
  color: var(--text-2);
  font-size: var(--text-sm);
  white-space: pre-line;
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
