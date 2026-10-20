import type { ActivatePolyfillsOptions } from './web-features.js';

import { activatePolyfills } from './web-features.js';

/** Page startup options; worker registration and update policy remain application-owned. */
export type PrepareBrowserOptions = {
  /** Forwarded to register() only when the worker is a script URL. */
  registrationOptions?: RegistrationOptions;
  /** Abort this wait without unregistering or cancelling a native registration. */
  signal?: AbortSignal;
  /** Bounds registration and control together. Defaults to 20 seconds. */
  timeoutMs?: number;
  /** Page polyfills, activated after control with serviceWorker forced to false. */
  polyfills?: Omit<ActivatePolyfillsOptions, 'path' | 'serviceWorker' | 'onCacheCheck'>;
};

/**
 * Await an application worker controlling this page, then activate page polyfills.
 * Existing registrations use their currently active worker, even when an update
 * waits. Script URLs additionally require the controller's script URL to match.
 * Obtain registrations from this page's navigator.serviceWorker; worker object
 * identity is specific to each window, so another window's registration cannot
 * be compared to this page's controller.
 * This helper never forces worker takeover, reloads, or unregisters a worker.
 */
export async function prepareBrowser(
  worker: string | URL | ServiceWorkerRegistration,
  options: PrepareBrowserOptions = {},
): Promise<ServiceWorkerRegistration> {
  const { signal, timeoutMs = 20_000 } = options;
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('prepareBrowser: timeoutMs must be between 0 and 2147483647 milliseconds.');
  }
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    throw new Error('prepareBrowser: service workers are unavailable in this page.');
  }
  const container = navigator.serviceWorker;
  const script = typeof worker === 'string' || 'href' in worker ? new URL(worker, document.baseURI) : undefined;
  if (script !== undefined) {
    script.hash = '';
  }

  const registration = await new Promise<ServiceWorkerRegistration>((resolve, reject): void => {
    let target: ServiceWorkerRegistration | undefined;
    let settled = false;
    const cleanup = (): void => {
      settled = true;
      clearTimeout(timer);
      container.removeEventListener('controllerchange', check);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (cause: unknown): void => {
      if (settled) { return; }
      cleanup();
      reject(cause);
    };
    const check = (): void => {
      const controller = container.controller;
      if (settled || target === undefined || controller === null || controller !== target.active) { return; }
      if (script !== undefined && controller.scriptURL !== script.href) { return; }
      cleanup();
      resolve(target);
    };
    const abort = (): void => fail(signal?.reason);
    const timer = setTimeout((): void => {
      fail(new DOMException('The application service worker did not take control before the timeout.', 'TimeoutError'));
    }, timeoutMs);

    container.addEventListener('controllerchange', check);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      if (script === undefined) {
        target = worker as ServiceWorkerRegistration;
        check();
      } else {
        void container.register(script.href, options.registrationOptions).then((registered): void => {
          if (settled) { return; }
          target = registered;
          check();
        }, fail);
      }
    } catch (cause: unknown) {
      fail(cause);
    }
  });
  signal?.throwIfAborted();
  activatePolyfills({ ...options.polyfills, serviceWorker: false });
  return registration;
}
