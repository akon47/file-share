import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import './css/base.css';
import App from './App.vue';
import { startApp } from './lib/app';
import { applyTheme } from './lib/settings';
import HomeView from './views/HomeView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomeView },
    { path: '/s/:id([A-Za-z0-9_-]{22})', component: () => import('./views/ReceiveView.vue') },
    { path: '/:pathMatch(.*)*', component: () => import('./views/NotFoundView.vue') },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

applyTheme();
startApp();
createApp(App).use(router).mount('#app');
