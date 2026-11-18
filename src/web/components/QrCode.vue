<template>
  <div class="qr" role="img" :aria-label="label" v-html="svg" />
</template>

<script setup lang="ts">
import { ref, watchEffect } from 'vue';
import QRCode from 'qrcode';

const props = withDefaults(defineProps<{ value: string; label?: string }>(), { label: 'QR 코드' });
const svg = ref('');

watchEffect(async () => {
  try {
    svg.value = await QRCode.toString(props.value, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#171b24', light: '#ffffff' },
    });
  } catch {
    svg.value = '';
  }
});
</script>

<style scoped>
.qr {
  width: 100%;
  aspect-ratio: 1;
  padding: 8px;
  border-radius: var(--radius);
  background: #fff;
  border: 1px solid var(--border);
}

.qr :deep(svg) {
  width: 100%;
  height: 100%;
}
</style>
