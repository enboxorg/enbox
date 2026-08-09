import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { activatePolyfills, cacheResponse, fetchResource, getDwnEndpoints, handleEvent, parseDrlUrl } from '../src/web-features.js';

const mockResolve = vi.fn();
const resolveDid = async (...params: unknown[]): Promise<any> => ({
  didDocumentMetadata   : {},
  didResolutionMetadata : {},
  ...await mockResolve(...params),
});
const mockDidResolvers = [
  { methodName: 'dht', resolve: resolveDid },
  { methodName: 'example', resolve: resolveDid },
];

// Helper: a DID document whose DWN service has the given endpoints.
// Pass [] to get getDwnEndpoints → [].
function dwnDidDoc(endpoints: string[]): any {
  return {
    didDocument: {
      service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: endpoints }],
    },
  };
}

// ---------------------------------------------------------------------------
// Suppress expected unhandled rejections from DRL click/context-menu tests.
// The production code intentionally re-throws errors when DID resolution fails
// and these bubble up as unhandled promise rejections in the test environment.
// ---------------------------------------------------------------------------
const suppressedErrors: Error[] = [];
function suppressUnhandledRejections(e: PromiseRejectionEvent): void {
  if (
    e.reason instanceof Error &&
    (e.reason.message.includes('DID endpoint resolution failed') ||
     e.reason.message.includes('Cannot read properties of undefined'))
  ) {
    suppressedErrors.push(e.reason);
    e.preventDefault();
  }
}

// ---------------------------------------------------------------------------
// Module state note:
//
// web-features.ts has module-level guards (`elementsInjected`,
// `linkFeaturesActive`) that prevent re-execution of `injectElements()` and
// `addLinkFeatures()`.  Tests are ordered so that the FIRST call to
// `activatePolyfills()` exercises the full initialization path.
// ---------------------------------------------------------------------------

describe('web features', () => {
  beforeEach(() => {
    suppressedErrors.length = 0;
    window.addEventListener('unhandledrejection', suppressUnhandledRejections);
    mockResolve.mockReset();
    activatePolyfills({
      didResolvers  : mockDidResolvers,
      serviceWorker : false,
      injectStyles  : false,
      links         : false,
    });
  });

  afterEach(() => {
    window.removeEventListener('unhandledrejection', suppressUnhandledRejections);
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('drl-link-loading');
  });

  // -----------------------------------------------------------------------
  // activatePolyfills — initial call (MUST run first)
  // -----------------------------------------------------------------------

  describe('activatePolyfills — initial call', () => {
    it('should inject overlay, styles, and link features on first call', () => {
      activatePolyfills({ serviceWorker: false, injectStyles: true, links: true });

      const overlay = document.querySelector('.drl-loading-overlay');
      expect(overlay).not.toBeNull();

      const spinner = overlay!.querySelector('.drl-loading-spinner');
      expect(spinner).not.toBeNull();

      const cancelBtn = overlay!.querySelector('span');
      expect(cancelBtn).not.toBeNull();

      const styles = Array.from(document.querySelectorAll('style'));
      const loaderStyle = styles.find((s) => s.innerHTML.includes('drl-loading-overlay'));
      expect(loaderStyle).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // activatePolyfills — option flags
  // -----------------------------------------------------------------------

  describe('activatePolyfills — option flags', () => {
    it('should not throw when called again (all guards prevent re-init)', () => {
      expect(() => activatePolyfills({ serviceWorker: false })).not.toThrow();
    });

    it('should not throw with injectStyles disabled', () => {
      expect(() => activatePolyfills({ serviceWorker: false, injectStyles: false })).not.toThrow();
    });

    it('should not throw with links disabled', () => {
      expect(() => activatePolyfills({ serviceWorker: false, links: false })).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // cancel navigation
  // -----------------------------------------------------------------------

  describe('cancel navigation', () => {
    it('should remove drl-link-loading attribute when cancel button is clicked', () => {
      document.documentElement.setAttribute('drl-link-loading', '');
      expect(document.documentElement.hasAttribute('drl-link-loading')).toBe(true);

      const overlay = document.querySelector('.drl-loading-overlay');
      const cancelBtn = overlay!.querySelector('span');
      cancelBtn!.click();

      expect(document.documentElement.hasAttribute('drl-link-loading')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // DRL link click handling
  // -----------------------------------------------------------------------

  describe('DRL link click handling', () => {
    it('should call preventDefault on DRL anchor clicks', async () => {
      // Resolver returns empty endpoints → click handler enters error path
      // (no iframe navigation)
      mockResolve.mockResolvedValue(dwnDidDoc([]));

      const anchor = document.createElement('a');
      anchor.href = 'https://dweb/did:dht:testuser/read/records/abc';
      anchor.textContent = 'DRL Link';
      document.body.appendChild(anchor);

      let preventDefaultCalled = false;
      const handler = (e: MouseEvent): void => {
        if (e.defaultPrevented) { preventDefaultCalled = true; }
      };
      document.addEventListener('click', handler);

      anchor.click();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(preventDefaultCalled).toBe(true);

      document.removeEventListener('click', handler);
      anchor.remove();
    });

    it('should set drl-link-loading attribute after delay for same-tab DRL links', async () => {
      // Slow resolution, returns NO endpoints so no navigation occurs
      mockResolve.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(dwnDidDoc([])), 300))
      );

      const anchor = document.createElement('a');
      anchor.href = 'https://dweb/did:dht:testuser/read/records/loading';
      document.body.appendChild(anchor);

      anchor.click();

      // Wait past the 50ms setTimeout that sets the loading attribute
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(document.documentElement.hasAttribute('drl-link-loading')).toBe(true);

      // Wait for resolution + error cleanup
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(document.documentElement.hasAttribute('drl-link-loading')).toBe(false);

      anchor.remove();
    });

    it('should handle DRL click that fails DID resolution', async () => {
      mockResolve.mockResolvedValue(dwnDidDoc([]));

      const anchor = document.createElement('a');
      anchor.href = 'https://dweb/did:dht:testuser/read/records/fail';
      document.body.appendChild(anchor);

      anchor.click();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(suppressedErrors.length).toBeGreaterThan(0);
      anchor.remove();
    });

    it('should open a new tab for DRL links with target=_blank', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://dwn.example.com'],
          }],
        },
      });

      const fakeTab = {
        closed   : false,
        location : { href: '' },
        document : { write: vi.fn() },
      };
      const windowOpenSpy = spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);

      const anchor = document.createElement('a');
      anchor.href = 'https://dweb/did:dht:testuser/read/records/newtab';
      anchor.target = '_blank';
      document.body.appendChild(anchor);

      anchor.click();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(windowOpenSpy).toHaveBeenCalledWith('', '_blank');
      expect(fakeTab.document.write).toHaveBeenCalled();
      expect(fakeTab.location.href).toContain('dwn.example.com');

      windowOpenSpy.mockRestore();
      anchor.remove();
    });

    it('should not navigate a closed tab', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://dwn.example.com'],
          }],
        },
      });

      const fakeTab = {
        closed   : true, // tab was closed before resolution
        location : { href: '' },
        document : { write: vi.fn() },
      };
      spyOn(window, 'open').mockReturnValue(fakeTab as unknown as Window);

      const anchor = document.createElement('a');
      anchor.href = 'https://dweb/did:dht:testuser/read/records/closedtab';
      anchor.target = '_blank';
      document.body.appendChild(anchor);

      anchor.click();
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Tab was closed, so location.href should remain empty
      expect(fakeTab.location.href).toBe('');
      anchor.remove();
    });

    it('should not intercept clicks on non-DRL anchors', () => {
      const anchor = document.createElement('a');
      anchor.href = 'https://example.com/regular-link';
      document.body.appendChild(anchor);

      const handler = (e: MouseEvent): void => { e.preventDefault(); };
      document.addEventListener('click', handler, { capture: true });

      anchor.click();

      expect(document.documentElement.hasAttribute('drl-link-loading')).toBe(false);

      document.removeEventListener('click', handler, { capture: true });
      anchor.remove();
    });

    it('should not intercept clicks on non-anchor elements', () => {
      const div = document.createElement('div');
      document.body.appendChild(div);

      div.click();

      expect(document.documentElement.hasAttribute('drl-link-loading')).toBe(false);
      div.remove();
    });
  });

  // -----------------------------------------------------------------------
  // context menu handling
  // -----------------------------------------------------------------------

  describe('context menu handling', () => {
    it('should handle pointercancel event without error', async () => {
      expect(() => document.dispatchEvent(new PointerEvent('pointercancel', {
        bubbles    : true,
        cancelable : true,
      }))).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    it('should handle right-click on non-DRL elements', async () => {
      const div = document.createElement('div');
      document.body.appendChild(div);

      expect(() => div.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles     : true,
        cancelable  : true,
        button      : 2,
        pointerType : 'mouse',
        composed    : true,
      }))).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
      div.remove();
    });

    it('should save original src on right-click and restore resolved URL from cache', async () => {
      const cachedResponse = new Response('img', {
        headers: {
          'dwn-cache-time'   : String(Date.now()),
          'dwn-composed-url' : 'https://dwn.example.com/did:dht:testuser/read/records/ctx.png',
        },
      });
      const mockCache = {
        match : vi.fn().mockResolvedValue(cachedResponse),
        put   : vi.fn(),
      };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);

      const img = document.createElement('img');
      img.src = 'https://dweb/did:dht:testuser/read/records/ctx.png';
      document.body.appendChild(img);

      img.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles     : true,
        cancelable  : true,
        button      : 2,
        pointerType : 'mouse',
        composed    : true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect((img as any).__src__).toBeDefined();
      expect(img.src).toBe('https://dwn.example.com/did:dht:testuser/read/records/ctx.png');

      img.remove();
    });

    it('should restore src on pointerup via requestAnimationFrame', async () => {
      const cachedResponse = new Response('img', {
        headers: {
          'dwn-cache-time'   : String(Date.now()),
          'dwn-composed-url' : 'https://dwn.example.com/did:dht:testuser/read/records/pu.png',
        },
      });
      const mockCache = {
        match : vi.fn().mockResolvedValue(cachedResponse),
        put   : vi.fn(),
      };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);

      const img = document.createElement('img');
      const originalSrc = 'https://dweb/did:dht:testuser/read/records/pu.png';
      img.src = originalSrc;
      document.body.appendChild(img);

      // Right-click to set context menu target
      img.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles     : true,
        cancelable  : true,
        button      : 2,
        pointerType : 'mouse',
        composed    : true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((img as any).__src__).toBeDefined();

      // Pointer up — triggers rAF-based cleanup
      img.dispatchEvent(new PointerEvent('pointerup', {
        bubbles    : true,
        cancelable : true,
      }));
      // Wait for the rAF-based cleanup to complete.  WebKit's headless rAF
      // scheduling can be slower than Chromium/Firefox, so we poll instead
      // of using a fixed timeout to avoid intermittent CI failures.
      await vi.waitFor(() => {
        expect((img as any).__src__).toBeUndefined();
      }, { timeout: 2000, interval: 50 });
      img.remove();
    });

    it('should handle touch (isPrimary) pointerdown on DRL images', async () => {
      const cachedResponse = new Response('img', {
        headers: {
          'dwn-cache-time'   : String(Date.now()),
          'dwn-composed-url' : 'https://dwn.example.com/did:dht:testuser/read/records/touch.png',
        },
      });
      const mockCache = {
        match : vi.fn().mockResolvedValue(cachedResponse),
        put   : vi.fn(),
      };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);

      const img = document.createElement('img');
      img.src = 'https://dweb/did:dht:testuser/read/records/touch.png';
      document.body.appendChild(img);

      img.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles     : true,
        cancelable  : true,
        button      : 0,
        pointerType : 'touch',
        isPrimary   : true,
        composed    : true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect((img as any).__src__).toBeDefined();
      img.remove();
    });

    it('should reset context menu target on left-click (else branch)', async () => {
      const cachedResponse = new Response('img', {
        headers: {
          'dwn-cache-time'   : String(Date.now()),
          'dwn-composed-url' : 'https://dwn.example.com/did:dht:testuser/read/records/reset.png',
        },
      });
      const mockCache = {
        match : vi.fn().mockResolvedValue(cachedResponse),
        put   : vi.fn(),
      };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);

      const img = document.createElement('img');
      img.src = 'https://dweb/did:dht:testuser/read/records/reset.png';
      document.body.appendChild(img);

      // Right-click sets context menu target
      img.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles     : true,
        cancelable  : true,
        button      : 2,
        pointerType : 'mouse',
        composed    : true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Left-click on same target triggers the else branch
      img.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles     : true,
        cancelable  : true,
        button      : 0,
        pointerType : 'mouse',
        composed    : true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect((img as any).__src__).toBeUndefined();
      img.remove();
    });
  });

  // -----------------------------------------------------------------------
  // service worker installation (DOM context)
  // -----------------------------------------------------------------------

  describe('service worker installation (DOM context)', () => {
    it('should attempt to register a service worker when no registration exists', async () => {
      const originalSW = navigator.serviceWorker;

      const registerMock = mock(() => Promise.resolve({} as ServiceWorkerRegistration));
      const getRegistrationMock = mock(() => Promise.resolve(undefined));

      Object.defineProperty(navigator, 'serviceWorker', {
        value        : { getRegistration: getRegistrationMock, register: registerMock },
        writable     : true,
        configurable : true,
      });

      activatePolyfills({
        serviceWorker : true,
        injectStyles  : false,
        links         : false,
        path          : 'https://example.com/sw.js',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(getRegistrationMock).toHaveBeenCalledWith('/');
      expect(registerMock).toHaveBeenCalledWith('https://example.com/sw.js', { type: 'module' });

      Object.defineProperty(navigator, 'serviceWorker', {
        value        : originalSW,
        writable     : true,
        configurable : true,
      });
    });

    it('should skip registration when a service worker is already registered', async () => {
      const originalSW = navigator.serviceWorker;

      const registerMock = mock(() => Promise.resolve({} as ServiceWorkerRegistration));
      const getRegistrationMock = mock(() =>
        Promise.resolve({ active: true } as unknown as ServiceWorkerRegistration)
      );

      Object.defineProperty(navigator, 'serviceWorker', {
        value        : { getRegistration: getRegistrationMock, register: registerMock },
        writable     : true,
        configurable : true,
      });

      activatePolyfills({
        serviceWorker : true,
        injectStyles  : false,
        links         : false,
        path          : 'https://example.com/sw.js',
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(getRegistrationMock).toHaveBeenCalledWith('/');
      expect(registerMock).not.toHaveBeenCalled();

      Object.defineProperty(navigator, 'serviceWorker', {
        value        : originalSW,
        writable     : true,
        configurable : true,
      });
    });

    it('should handle registration failure gracefully', async () => {
      const originalSW = navigator.serviceWorker;
      const consoleErrorSpy = spyOn(console, 'error');

      const registerMock = mock(() => Promise.reject(new Error('SW registration failed')));
      const getRegistrationMock = mock(() => Promise.resolve(undefined));

      Object.defineProperty(navigator, 'serviceWorker', {
        value        : { getRegistration: getRegistrationMock, register: registerMock },
        writable     : true,
        configurable : true,
      });

      activatePolyfills({
        serviceWorker : true,
        injectStyles  : false,
        links         : false,
        path          : 'https://example.com/sw.js',
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(consoleErrorSpy).toHaveBeenCalled();

      Object.defineProperty(navigator, 'serviceWorker', {
        value        : originalSW,
        writable     : true,
        configurable : true,
      });
      consoleErrorSpy.mockRestore();
    });

    it('should handle missing navigator.serviceWorker gracefully', async () => {
      const originalSW = navigator.serviceWorker;
      const consoleErrorSpy = spyOn(console, 'error');

      Object.defineProperty(navigator, 'serviceWorker', {
        value        : undefined,
        writable     : true,
        configurable : true,
      });

      activatePolyfills({ serviceWorker: true, injectStyles: false, links: false });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(consoleErrorSpy).toHaveBeenCalled();

      Object.defineProperty(navigator, 'serviceWorker', {
        value        : originalSW,
        writable     : true,
        configurable : true,
      });
      consoleErrorSpy.mockRestore();
    });

    it('should register using the import.meta.url fallback when no script src is available', async () => {
      const originalSW = navigator.serviceWorker;

      const registerMock = mock(() => Promise.resolve({} as ServiceWorkerRegistration));
      const getRegistrationMock = mock(() => Promise.resolve(undefined));

      Object.defineProperty(navigator, 'serviceWorker', {
        value        : { getRegistration: getRegistrationMock, register: registerMock },
        writable     : true,
        configurable : true,
      });

      // document.currentScript is null in this context, so the install URL falls
      // back to import.meta.url (always defined for the served module).
      activatePolyfills({ serviceWorker: true, injectStyles: false, links: false });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // No existing registration + a resolvable module URL => registration is attempted.
      expect(getRegistrationMock).toHaveBeenCalled();
      expect(registerMock).toHaveBeenCalled();

      Object.defineProperty(navigator, 'serviceWorker', {
        value        : originalSW,
        writable     : true,
        configurable : true,
      });
    });
  });

  // -----------------------------------------------------------------------
  // getDwnEndpoints
  // -----------------------------------------------------------------------

  describe('getDwnEndpoints', () => {
    it('should extract DWN service endpoints from a resolved DID', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://dwn1.example.com', 'https://dwn2.example.com'],
          }],
        },
      });

      const endpoints = await getDwnEndpoints('did:example:test');
      expect(endpoints).toEqual(['https://dwn1.example.com', 'https://dwn2.example.com']);
    });

    it('should cache repeated DID resolution', async () => {
      mockResolve.mockResolvedValue(dwnDidDoc(['https://dwn.example.com']));

      await getDwnEndpoints('did:example:cached');
      await getDwnEndpoints('did:example:cached');

      expect(mockResolve).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when DWN service has empty endpoints', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: [] }],
        },
      });

      const endpoints = await getDwnEndpoints('did:example:test');
      expect(endpoints).toEqual([]);
    });

    it('should handle a single string serviceEndpoint', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : 'https://single.example.com',
          }],
        },
      });

      const endpoints = await getDwnEndpoints('did:example:test');
      expect(endpoints).toEqual(['https://single.example.com']);
    });

    it('should reject a service containing a non-http endpoint', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://valid.example.com', 'ws://invalid.example.com'],
          }],
        },
      });

      const endpoints = await getDwnEndpoints('did:example:test');
      expect(endpoints).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // handleEvent
  // -----------------------------------------------------------------------

  describe('handleEvent', () => {
    it('should return a DID resolution response when path is empty', async () => {
      const mockResult = { didDocument: { id: 'did:example:alice', service: [] } };
      mockResolve.mockResolvedValue(mockResult);

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice', headers: new Headers() },
      };

      const response = await handleEvent(mockEvent, 'did:example:alice', '', {});
      expect(response.status).toBe(200);

      const body = await response.json();
      // handleEvent wraps the full resolve() result in JSON
      expect(body.didDocument.id).toBe('did:example:alice');
    });

    it('should return cached response when offline', async () => {
      const cachedResponse = new Response('cached', {
        headers: { 'dwn-cache-time': String(Date.now()) },
      });
      const mockCache = {
        match : vi.fn().mockResolvedValue(cachedResponse),
        put   : vi.fn(),
      };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);

      const originalOnLine = navigator.onLine;
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice/records/abc', headers: new Headers() },
      };

      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/abc', {});
      expect(response).toBe(cachedResponse);

      Object.defineProperty(navigator, 'onLine', { value: originalOnLine, configurable: true });
    });

    it('should return cached response when TTL is still valid', async () => {
      const cachedResponse = new Response('cached', {
        headers: { 'dwn-cache-time': String(Date.now()) },
      });
      const mockCache = {
        match : vi.fn().mockResolvedValue(cachedResponse),
        put   : vi.fn(),
      };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice/records/ttl', headers: new Headers() },
      };
      const options = { onCacheCheck: vi.fn().mockReturnValue({ ttl: 60_000 }) };

      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/ttl', options);
      expect(response).toBe(cachedResponse);
    });

    it('should fetch fresh when cache TTL has expired', async () => {
      const expiredCacheTime = String(Date.now() - 120_000);
      const cachedResponse = new Response('old', {
        headers: { 'dwn-cache-time': expiredCacheTime },
      });
      const mockCache = {
        match : vi.fn().mockResolvedValue(cachedResponse),
        put   : vi.fn(),
      };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);

      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] }],
        },
      });
      spyOn(globalThis, 'fetch').mockResolvedValue(new Response('fresh', { status: 200 }));

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice/records/exp', headers: new Headers() },
      };
      const options = { onCacheCheck: vi.fn().mockReturnValue({ ttl: 60_000 }) };

      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/exp', options);
      expect(response!.status).toBe(200);
    });

    it('should return 530 when no DWN endpoints are found', async () => {
      const mockCache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);
      mockResolve.mockResolvedValue(dwnDidDoc([]));

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice/records/nope', headers: new Headers() },
      };

      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/nope', {});
      expect(response.status).toBe(530);
    });

    it('should return 500 when DWN fetch throws', async () => {
      const mockCache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] }],
        },
      });
      spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice/records/err', headers: new Headers() },
      };

      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/err', {});
      expect(response.status).toBe(500);
    });

    it('should return DWN error status when response is not ok', async () => {
      const mockCache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] }],
        },
      });
      spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice/records/miss', headers: new Headers() },
      };

      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/miss', {});
      expect(response.status).toBe(404);
    });

    it('should catch thrown Response objects', async () => {
      const mockCache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);
      // Use DWN service with empty endpoints so getDwnEndpoints returns []
      // → fetchResource throws Response(530) → handleEvent catches it
      mockResolve.mockResolvedValue(dwnDidDoc([]));

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice/records/x', headers: new Headers() },
      };

      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/x', {});
      expect(response.status).toBe(530);
    });

    it('should return 530 when DID resolution throws', async () => {
      const mockCache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);
      mockResolve.mockRejectedValue(new Error('DID resolution timeout'));

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice/records/to', headers: new Headers() },
      };

      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/to', {});
      expect(response.status).toBe(530);
      const body = await response.text();
      expect(body).toBe('DWeb Node resolution failed: no valid endpoints found.');
    });

    it('should normalize http to https and strip trailing slashes in DRL', async () => {
      const mockCache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] }],
        },
      });
      spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      const mockEvent = {
        request: { url: 'http://dweb/did:example:alice/records/slash/', headers: new Headers() },
      };

      const options = { onCacheCheck: vi.fn().mockReturnValue(null) };

      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/slash', options);
      expect(response!.status).toBe(200);
      expect(mockCache.match).toHaveBeenCalledWith('https://dweb/did:example:alice/records/slash');
    });

    it('should handle onCacheCheck returning null (no caching)', async () => {
      const mockCache = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn() };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] }],
        },
      });
      spyOn(globalThis, 'fetch').mockResolvedValue(new Response('content', { status: 200 }));

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice/records/nc', headers: new Headers() },
      };
      const options = { onCacheCheck: vi.fn().mockReturnValue(null) };

      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/nc', options);
      expect(response!.status).toBe(200);
    });

    it('should fetch fresh when cache exists but no onCacheCheck match', async () => {
      // When a cached response exists and onCacheCheck returns falsy, the cache
      // entry is bypassed and a fresh fetch is performed.
      const cachedResponse = new Response('cached', {
        headers: { 'dwn-cache-time': String(Date.now()) },
      });
      const mockCache = { match: vi.fn().mockResolvedValue(cachedResponse), put: vi.fn() };
      spyOn(caches, 'open').mockResolvedValue(mockCache as unknown as Cache);
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] }],
        },
      });
      spyOn(globalThis, 'fetch').mockResolvedValue(new Response('fresh', { status: 200 }));

      const mockEvent = {
        request: { url: 'https://dweb/did:example:alice/records/nocc', headers: new Headers() },
      };

      // onCacheCheck returns null → match is falsy → skip cache
      const options = { onCacheCheck: vi.fn().mockReturnValue(null) };
      const response = await handleEvent(mockEvent, 'did:example:alice', 'records/nocc', options);
      expect(response!.status).toBe(200);
    });
  });

  // -----------------------------------------------------------------------
  // cacheResponse
  // -----------------------------------------------------------------------

  describe('cacheResponse', () => {
    it('should clone the response and add cache metadata headers', async () => {
      const original = new Response('body', { headers: { 'Content-Type': 'text/plain' } });
      const putMock = vi.fn();
      const mockCache = { put: putMock };

      await cacheResponse('https://dweb/test', 'https://dwn.example.com/did/path', original, mockCache);

      expect(putMock).toHaveBeenCalledTimes(1);
      const [drl, cached] = putMock.mock.calls[0] as [string, Response];
      expect(drl).toBe('https://dweb/test');
      expect(cached.headers.get('dwn-cache-time')).toBeDefined();
      expect(cached.headers.get('dwn-composed-url')).toBe('https://dwn.example.com/did/path');
    });
  });

  // -----------------------------------------------------------------------
  // fetchResource
  // -----------------------------------------------------------------------

  describe('fetchResource', () => {
    it('should fetch from DWN endpoint and cache the response', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] }],
        },
      });
      spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data', { status: 200 }));

      const mockEvent = { request: { headers: new Headers() } };
      const putMock = vi.fn();
      const mockCache = { put: putMock };
      const options = { onCacheCheck: vi.fn().mockReturnValue({ ttl: 60000 }) };

      const response = await fetchResource(
        mockEvent, 'did:example:alice', 'https://dweb/x', 'records/x', mockCache, options
      );

      expect(response!.status).toBe(200);
      expect(putMock).toHaveBeenCalled();
    });

    it('should throw 530 Response when no endpoints are found', async () => {
      mockResolve.mockResolvedValue(dwnDidDoc([]));

      const mockEvent = { request: { headers: new Headers() } };

      try {
        await fetchResource(mockEvent, 'did:example:nobody', 'https://dweb/x', 'records/x', {}, {});
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error).toBeInstanceOf(Response);
        expect(error.status).toBe(530);
      }
    });

    it('should return 500 when endpoint fetch throws', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] }],
        },
      });
      spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));

      const mockEvent = { request: { headers: new Headers() } };

      const response = await fetchResource(
        mockEvent, 'did:example:alice', 'https://dweb/x', 'records/x', {}, {}
      );
      expect(response!.status).toBe(500);
    });

    it('should return DWN error status when response is not ok', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] }],
        },
      });
      spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Forbidden', { status: 403 }));

      const mockEvent = { request: { headers: new Headers() } };

      const response = await fetchResource(
        mockEvent, 'did:example:alice', 'https://dweb/x', 'records/x', {}, {}
      );
      expect(response!.status).toBe(403);
    });

    it('should not cache when onCacheCheck returns falsy', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com'] }],
        },
      });
      spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data', { status: 200 }));

      const mockEvent = { request: { headers: new Headers() } };
      const putMock = vi.fn();
      const mockCache = { put: putMock };
      const options = { onCacheCheck: vi.fn().mockReturnValue(null) };

      await fetchResource(
        mockEvent, 'did:example:alice', 'https://dweb/x', 'records/x', mockCache, options
      );

      expect(putMock).not.toHaveBeenCalled();
    });

    it('should strip trailing slash from endpoint URL', async () => {
      mockResolve.mockResolvedValue({
        didDocument: {
          service: [{ id: 'dwn', type: 'DecentralizedWebNode', serviceEndpoint: ['https://dwn.example.com/'] }],
        },
      });
      const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));

      const mockEvent = { request: { headers: new Headers() } };

      await fetchResource(mockEvent, 'did:example:alice', 'https://dweb/x', 'records/x', {}, {});

      const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
      expect(calledUrl).toBe('https://dwn.example.com/did:example:alice/records/x');
    });
  });

  describe('parseDrlUrl', () => {
    it('should parse an https DRL URL with DID and path', () => {
      const result = parseDrlUrl('https://dweb/did:example:alice/records/abc');
      expect(result).toEqual(['did:example:alice', 'records/abc']);
    });

    it('should parse an http DRL URL', () => {
      const result = parseDrlUrl('http://dweb/did:example:bob/path');
      expect(result).toEqual(['did:example:bob', 'path']);
    });

    it('should return empty path when URL has no path after DID', () => {
      const result = parseDrlUrl('https://dweb/did:example:alice');
      expect(result).toEqual(['did:example:alice', '']);
    });

    it('should return empty path when URL has trailing slash only', () => {
      const result = parseDrlUrl('https://dweb/did:example:alice/');
      expect(result).toEqual(['did:example:alice', '']);
    });

    it('should return null for non-DRL URLs', () => {
      expect(parseDrlUrl('https://example.com/foo')).toBeNull();
      expect(parseDrlUrl('ftp://dweb/did:example:alice')).toBeNull();
      expect(parseDrlUrl('')).toBeNull();
    });

    it('should return null when DID segment is empty', () => {
      expect(parseDrlUrl('https://dweb/')).toBeNull();
      expect(parseDrlUrl('https://dweb//path')).toBeNull();
    });

    it('should preserve nested path segments', () => {
      const result = parseDrlUrl('https://dweb/did:dht:abc/protocols/xyz/records/123');
      expect(result).toEqual(['did:dht:abc', 'protocols/xyz/records/123']);
    });
  });
});
