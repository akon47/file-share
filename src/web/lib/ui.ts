import { reactive } from 'vue';

// Toasts and modal dialogs (rendered by components/DialogHost.vue). No browser alert/confirm/prompt.

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface DialogField {
  type: 'text' | 'password';
  value: string;
  placeholder?: string;
  maxLength?: number;
}

export interface Dialog {
  id: number;
  title: string;
  message?: string;
  confirmText: string;
  cancelText: string;
  danger?: boolean;
  field?: DialogField;
  resolve: (value: string | boolean | null) => void;
}

let nextId = 1;

export const ui = reactive({
  toasts: [] as Toast[],
  dialogs: [] as Dialog[],
});

function push(kind: Toast['kind'], message: string, ms = 3200): void {
  const id = nextId++;
  ui.toasts.push({ id, kind, message });
  if (ui.toasts.length > 4) ui.toasts.shift();
  setTimeout(() => {
    const index = ui.toasts.findIndex((t) => t.id === id);
    if (index >= 0) ui.toasts.splice(index, 1);
  }, ms);
}

export const toast = {
  info: (message: string) => push('info', message),
  success: (message: string) => push('success', message),
  error: (message: string) => push('error', message, 5000),
};

export function confirmDialog(options: {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    ui.dialogs.push({
      id: nextId++,
      confirmText: '확인',
      cancelText: '취소',
      ...options,
      resolve: (value) => resolve(value === true),
    });
  });
}

export function promptDialog(options: {
  title: string;
  message?: string;
  confirmText?: string;
  value?: string;
  placeholder?: string;
  password?: boolean;
  maxLength?: number;
}): Promise<string | null> {
  return new Promise((resolve) => {
    ui.dialogs.push({
      id: nextId++,
      title: options.title,
      message: options.message,
      confirmText: options.confirmText ?? '확인',
      cancelText: '취소',
      field: {
        type: options.password ? 'password' : 'text',
        value: options.value ?? '',
        placeholder: options.placeholder,
        maxLength: options.maxLength,
      },
      resolve: (value) => resolve(typeof value === 'string' ? value : null),
    });
  });
}

export async function copyText(text: string, done = '복사했어요'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error('복사하지 못했어요. 직접 선택해서 복사해 주세요.');
  }
}
