import { getAppStore } from '../state/app-store.js';

/**
 * @typedef {import('../identity-runtime.js').IdentityRuntime} IdentityRuntime
 * @typedef {import('../identity-runtime.js').IdentityWalletSnapshot} IdentityWalletSnapshot
 * @typedef {import('../state/app-store.js').AppStore['toast']} ToastStore
 */

/**
 * @param {IdentityWalletSnapshot | null | undefined} snapshot
 * @returns {string}
 */
function resolveActiveManagedDid(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return '';
  }

  const fromSnapshot = typeof snapshot.activeManagedDidUri === 'string'
    ? snapshot.activeManagedDidUri.trim()
    : '';
  if (fromSnapshot) {
    return fromSnapshot;
  }

  const identities = Array.isArray(snapshot.identities) ? snapshot.identities : [];
  const activeIdentity = identities.find((identity) => identity?.active === true && typeof identity.didUri === 'string');
  return activeIdentity?.didUri?.trim() ?? '';
}

/**
 * @param {ToastStore} toastStore
 * @param {'neutral' | 'brand' | 'success' | 'warning' | 'danger'} tone
 * @param {string} message
 */
function notify(toastStore, tone, message) {
  const trimmedMessage = String(message ?? '').trim();
  if (!trimmedMessage) {
    return;
  }

  toastStore.notify({
    tone,
    message: trimmedMessage,
    dedupeWindowMs: 1200,
    allowDuplicate: false,
  });
}

/**
 * @param {{
 *   runtime: IdentityRuntime | null | undefined;
 *   didUri: string;
 *   previousActiveDid?: string;
 *   toastStore?: ToastStore | null;
 * }} options
 * @returns {Promise<{ snapshot: IdentityWalletSnapshot | null; activeDid: string; switched: boolean }>}
 */
export async function switchDidWithToast(options) {
  const runtime = options?.runtime ?? null;
  const didUri = String(options?.didUri ?? '').trim();
  const previousActiveDid = String(options?.previousActiveDid ?? '').trim();
  const toastStore = options?.toastStore ?? getAppStore().toast;

  if (!didUri) {
    return {
      snapshot : null,
      activeDid: previousActiveDid,
      switched : false,
    };
  }

  if (!runtime || typeof runtime.switchDid !== 'function') {
    notify(toastStore, 'danger', 'Identity runtime is not available yet.');
    return {
      snapshot : null,
      activeDid: previousActiveDid,
      switched : false,
    };
  }

  try {
    const snapshot = await runtime.switchDid(didUri);
    const nextActiveDid = resolveActiveManagedDid(snapshot);

    if (nextActiveDid === didUri) {
      notify(toastStore, 'success', `Active DID switched to ${didUri}.`);
      return {
        snapshot,
        activeDid: nextActiveDid,
        switched: true,
      };
    }

    const resolvedDid = nextActiveDid || previousActiveDid || 'none';
    notify(toastStore, 'warning', `Switch requested for ${didUri}, but active DID is ${resolvedDid}.`);
    return {
      snapshot,
      activeDid: nextActiveDid,
      switched: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    notify(toastStore, 'danger', `Failed to switch DID: ${message}`);
    return {
      snapshot : null,
      activeDid: previousActiveDid,
      switched : false,
    };
  }
}
