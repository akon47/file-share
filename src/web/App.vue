<template>
  <AppHeader />
  <RouterView :key="$route.path" />
  <AppFooter />
  <IncomingPushDialog />
  <TransferTray />
  <DialogHost />
</template>

<script setup lang="ts">
import AppFooter from '@/components/AppFooter.vue';
import AppHeader from '@/components/AppHeader.vue';
import DialogHost from '@/components/DialogHost.vue';
import IncomingPushDialog from '@/components/IncomingPushDialog.vue';
import TransferTray from '@/components/TransferTray.vue';
</script>
