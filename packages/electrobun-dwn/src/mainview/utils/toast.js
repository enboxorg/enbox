import { getAppStore } from '../state/app-store.js';

/**
 * @param {import('../state/app-store.js').ToastOptions} options
 */
export function notifyToast(options) {
  getAppStore().toast.notify(options);
}

/**
 * @param {import('../state/app-store.js').ToastOptions} options
 */
export function emitToast(options) {
  notifyToast(options);
}
