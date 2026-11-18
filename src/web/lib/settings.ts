import { reactive, watch } from 'vue';
import { LIMITS } from '@shared/protocol';
import { randomName } from './names';

// Per-browser preferences in localStorage. Every access is guarded: storage can be unavailable
// (private windows, blocked site data) and the app must still work.

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  const saved = read('fs.theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const settings = reactive({
  name: read('fs.name') || randomName(),
  visible: read('fs.visible') !== '0',
  theme: initialTheme(),
});

write('fs.name', settings.name);

watch(
  () => settings.name,
  (name) => write('fs.name', name),
);
watch(
  () => settings.visible,
  (visible) => write('fs.visible', visible ? '1' : '0'),
);
watch(
  () => settings.theme,
  (theme) => {
    write('fs.theme', theme);
    applyTheme(theme);
  },
);

export function applyTheme(theme: Theme = settings.theme): void {
  document.documentElement.classList.toggle('dark-theme', theme === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f1116' : '#f6f7fa');
}

export function cleanName(value: string): string {
  return [...value.replace(/\s+/g, ' ').trim()].slice(0, LIMITS.nameMax).join('');
}
