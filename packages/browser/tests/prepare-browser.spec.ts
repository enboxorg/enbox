import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { activatePolyfills } from '../src/web-features.js';
import { prepareBrowser } from '../src/prepare-browser.js';

vi.mock('../src/web-features.js', { spy: true });

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise): void => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function worker(path = '/app-worker.js', state: ServiceWorkerState = 'activated'): ServiceWorker {
  return Object.assign(new EventTarget(), {
    scriptURL     : new URL(path, document.baseURI).href,
    state,
    onstatechange : null,
    onerror       : null,
    postMessage   : vi.fn(),
  }) as ServiceWorker;
}

class Registration extends EventTarget {
  public active: ServiceWorker | null = null;
  public installing: ServiceWorker | null = null;
  public waiting: ServiceWorker | null = null;
  public readonly update = vi.fn();
  public readonly unregister = vi.fn();

  public constructor(public readonly scope = new URL('/', document.baseURI).href) {
    super();
  }

  public get native(): ServiceWorkerRegistration {
    return this as unknown as ServiceWorkerRegistration;
  }
}

/** Model control independently of registration or activation, as browsers do. */
class Container extends EventTarget {
  public controller: ServiceWorker | null = null;
  public readonly readiness = deferred<ServiceWorkerRegistration>();
  public readonly ready = this.readiness.promise;
  public readonly register = vi.fn<(
    scriptURL: string | URL,
    options?: RegistrationOptions,
  ) => Promise<ServiceWorkerRegistration>>();

  public claim(registration: Registration, controller: ServiceWorker): void {
    registration.active = controller;
    this.controller = controller;
    this.dispatchEvent(new Event('controllerchange'));
  }
}

describe('prepareBrowser', () => {
  let container: Container;
  let registration: Registration;
  let originalServiceWorker: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(activatePolyfills).mockReset().mockImplementation((): void => {});
    originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    container = new Container();
    registration = new Registration();
    container.register.mockResolvedValue(registration.native);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalServiceWorker === undefined) {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    } else {
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker);
    }
  });

  it('uses an already controlling registration without registering or forcing a waiting update', async () => {
    container.claim(registration, worker());
    registration.waiting = worker('/next-worker.js', 'installed');
    const polyfills = { injectStyles: false, links: false };
    const ready = await prepareBrowser(registration.native, { polyfills });

    expect(ready).toBe(registration.native);
    expect(container.register).not.toHaveBeenCalled();
    expect(registration.update).not.toHaveBeenCalled();
    expect(registration.unregister).not.toHaveBeenCalled();
    expect(registration.waiting.postMessage).not.toHaveBeenCalled();
    expect(activatePolyfills).toHaveBeenCalledTimes(1);
    expect(activatePolyfills).toHaveBeenCalledWith({ ...polyfills, serviceWorker: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('registers the normalized URL with the host options and does not consult global ready', async () => {
    container.claim(registration, worker('/app-worker.js?v=1'));
    const registrationOptions: RegistrationOptions = { type: 'module', scope: '/', updateViaCache: 'none' };
    const ready = await prepareBrowser(new URL('/app-worker.js?v=1#fragment', document.baseURI), { registrationOptions });

    expect(ready).toBe(registration.native);
    expect(container.register).toHaveBeenCalledTimes(1);
    expect(container.register).toHaveBeenCalledWith(registration.active!.scriptURL, registrationOptions);
    expect(activatePolyfills).toHaveBeenCalledTimes(1);
    expect(activatePolyfills).toHaveBeenCalledWith({ serviceWorker: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a URL created in another window', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    try {
      const frameWindow = frame.contentWindow as Window & typeof globalThis;
      const script = new frameWindow.URL('/app-worker.js', document.baseURI);
      expect(script).not.toBeInstanceOf(URL);
      container.claim(registration, worker());

      expect(await prepareBrowser(script)).toBe(registration.native);
      expect(container.register).toHaveBeenCalledWith(script.href, undefined);
      expect(activatePolyfills).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      frame.remove();
    }
  });

  it('waits for first-install control after registration and activation', async () => {
    const installed = worker('/app-worker.js', 'installing');
    registration.installing = installed;
    const pending = prepareBrowser('/app-worker.js');
    await Promise.resolve();
    registration.installing = null;
    Object.assign(installed, { state: 'activated' });
    registration.active = installed;
    container.readiness.resolve(registration.native);
    await Promise.resolve();
    expect(activatePolyfills).not.toHaveBeenCalled();

    container.claim(registration, installed);
    expect(await pending).toBe(registration.native);
    expect(activatePolyfills).toHaveBeenCalledTimes(1);
  });

  it('does not accept a different registration controlling an overlapping scope with the same script', async () => {
    const expected = worker();
    registration.active = expected;
    const overlapping = new Registration(new URL('./', document.baseURI).href);
    container.claim(overlapping, worker());
    const pending = prepareBrowser('/app-worker.js');
    await Promise.resolve();
    container.dispatchEvent(new Event('controllerchange'));
    await Promise.resolve();
    expect(activatePolyfills).not.toHaveBeenCalled();

    container.claim(registration, expected);
    expect(await pending).toBe(registration.native);
  });

  it('waits for the requested script instead of the old controller on the same registration', async () => {
    container.claim(registration, worker('/old-worker.js'));
    const pending = prepareBrowser('/app-worker.js');
    await Promise.resolve();
    expect(activatePolyfills).not.toHaveBeenCalled();

    container.claim(registration, worker());
    expect(await pending).toBe(registration.native);
  });

  it('bounds a hanging native registration and ignores its late success', async () => {
    const opening = deferred<ServiceWorkerRegistration>();
    container.register.mockReturnValue(opening.promise);
    const removed = vi.spyOn(container, 'removeEventListener');
    const rejected = expect(prepareBrowser('/app-worker.js', { timeoutMs: 25 })).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(removed).toHaveBeenCalledWith('controllerchange', expect.any(Function));

    container.claim(registration, worker());
    opening.resolve(registration.native);
    await Promise.resolve();
    expect(activatePolyfills).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a 20-second bound when ready never settles and the page remains uncontrolled', async () => {
    registration.active = worker();
    const rejected = expect(prepareBrowser(registration.native)).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(activatePolyfills).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors a pre-aborted caller before registering', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(prepareBrowser('/app-worker.js', { signal: abort.signal })).rejects.toBe(abort.signal.reason);
    expect(container.register).not.toHaveBeenCalled();
    expect(activatePolyfills).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, 0, new Error('page retired')])('preserves the abort reason during registration: %s', async (reason) => {
    const opening = deferred<ServiceWorkerRegistration>();
    container.register.mockReturnValue(opening.promise);
    const abort = new AbortController();
    const rejected = expect(prepareBrowser('/app-worker.js', { signal: abort.signal })).rejects.toBe(reason);
    abort.abort(reason);
    await rejected;
    container.claim(registration, worker());
    opening.resolve(registration.native);
    await Promise.resolve();
    expect(activatePolyfills).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a caller aborted after registration but before control', async () => {
    const abort = new AbortController();
    const removed = vi.spyOn(container, 'removeEventListener');
    const removeAbort = vi.spyOn(abort.signal, 'removeEventListener');
    const rejected = expect(prepareBrowser('/app-worker.js', { signal: abort.signal })).rejects.toBeInstanceOf(DOMException);
    await Promise.resolve();
    abort.abort();
    await rejected;
    expect(removed).toHaveBeenCalledWith('controllerchange', expect.any(Function));
    expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
    container.claim(registration, worker());
    expect(activatePolyfills).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not activate polyfills if another controllerchange listener aborts the successful wait', async () => {
    const abort = new AbortController();
    const reason = new Error('page retired during control notification');
    const rejected = expect(prepareBrowser(registration.native, { signal: abort.signal })).rejects.toBe(reason);
    const retire = (): void => abort.abort(reason);
    container.addEventListener('controllerchange', retire);
    container.claim(registration, worker());
    await rejected;
    container.removeEventListener('controllerchange', retire);
    expect(activatePolyfills).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves registration errors and handles a late rejection after abort', async () => {
    const failure = new DOMException('Worker scope is not allowed.', 'SecurityError');
    container.register.mockRejectedValueOnce(failure);
    await expect(prepareBrowser('/app-worker.js')).rejects.toBe(failure);
    expect(activatePolyfills).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const opening = deferred<ServiceWorkerRegistration>();
    container.register.mockReturnValue(opening.promise);
    const abort = new AbortController();
    const rejected = expect(prepareBrowser('/app-worker.js', { signal: abort.signal })).rejects.toBeInstanceOf(DOMException);
    abort.abort();
    await rejected;
    opening.reject(failure);
    await Promise.resolve();
    expect(activatePolyfills).not.toHaveBeenCalled();
  });

  it.each([-1, Infinity, NaN, 2_147_483_648])('rejects an invalid timeout before registering: %s', async (timeoutMs) => {
    await expect(prepareBrowser('/app-worker.js', { timeoutMs })).rejects.toBeInstanceOf(RangeError);
    expect(container.register).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
