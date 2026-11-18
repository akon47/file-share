<template>
  <section class="card" aria-labelledby="code-title">
    <div class="card-head">
      <div>
        <h2 id="code-title">코드로 받기</h2>
        <p class="lead">보내는 사람 화면의 6자리 코드를 입력하세요.</p>
      </div>
    </div>
    <form class="card-body code-form" @submit.prevent="submit">
      <input
        v-model="code"
        class="input code-input num"
        :class="{ invalid: !!error }"
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9 ]*"
        maxlength="7"
        placeholder="000 000"
        aria-label="6자리 코드"
        @input="onInput"
      />
      <button class="btn btn-lg" type="submit" :disabled="digits.length !== 6 || busy">
        <span v-if="busy" class="spinner" />
        <template v-else>받기</template>
      </button>
      <p v-if="error" class="error-text">{{ error }}</p>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { findShareByCode } from '@/lib/receive';
import { net, RequestError } from '@/lib/signaling';

const router = useRouter();
const code = ref('');
const error = ref('');
const busy = ref(false);
const digits = computed(() => code.value.replace(/\D/g, ''));

function onInput(): void {
  error.value = '';
  const d = digits.value.slice(0, 6);
  code.value = d.length > 3 ? `${d.slice(0, 3)} ${d.slice(3)}` : d;
}

async function submit(): Promise<void> {
  if (digits.value.length !== 6 || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const share = await findShareByCode(digits.value);
    if (share.owner === net.myId) {
      error.value = '내가 공유한 코드예요.';
      return;
    }
    await router.push(`/s/${share.id}`);
  } catch (e) {
    if (e instanceof RequestError && e.code === 'not-found')
      error.value = '이 코드로 열린 공유가 없어요. 숫자를 다시 확인해 주세요.';
    else if (e instanceof RequestError && e.code === 'rate-limited')
      error.value = '너무 많이 시도했어요. 잠시 후 다시 해 주세요.';
    else error.value = '서버에 연결하지 못했어요.';
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.code-form {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--s-2);
}

.code-input {
  min-height: 48px;
  font-size: var(--text-xl);
  font-weight: 700;
  letter-spacing: 0.12em;
  text-align: center;
}

.error-text {
  grid-column: 1 / -1;
}
</style>
