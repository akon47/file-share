<template>
  <footer class="app-footer">
    <div class="container footer-inner">
      <p class="promise">
        <AppIcon name="shield" :size="16" />
        파일은 서버에 올라가지 않고 브라우저끼리 직접, 암호화된 연결로 전송돼요.
      </p>
      <nav class="links" aria-label="바닥글">
        <RouterLink to="/terms">이용약관</RouterLink>
        <RouterLink to="/privacy"><strong>개인정보처리방침</strong></RouterLink>
        <a href="https://github.com/akon47/file-share" target="_blank" rel="noopener">GitHub</a>
        <a href="https://screenshare.kimhwan.com" target="_blank" rel="noopener">Screen Share</a>
        <a href="https://kimhwan.com" target="_blank" rel="noopener">kimhwan.com</a>
      </nav>
    </div>
  </footer>
</template>

<script setup lang="ts">
import AppIcon from './AppIcon.vue';
</script>

<style scoped>
.app-footer {
  border-top: 1px solid var(--border);
  background: var(--surface);
  padding-block: var(--s-6) calc(var(--s-6) + env(safe-area-inset-bottom, 0px));
}

.footer-inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3) var(--s-6);
  color: var(--text-3);
  font-size: var(--text-sm);
}

.promise {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2) var(--s-4);
}

.links a {
  color: var(--text-2);
}
</style>
