/*
  This file is run in dual environments to make installation of the Service Worker code easier.
  Be mindful that code placed in any open excution space may be evaluated multiple times in different contexts,
  so take care to gate additions to only activate code in the right env, such as a Service Worker scope or page window.
*/

import type { DidMethodResolver } from '@enbox/dids';

import { DidDht, DidWeb, UniversalResolver } from '@enbox/dids';

/**
 * Result returned by the `onCacheCheck` callback.
 * When returned, it signals that the response for the given DRL should be cached.
 */
export type CacheCheckResult = {
  /** Time-to-live for the cached DRL response, in milliseconds. */
  ttl?: number;
};

/**
 * Callback invoked to determine whether a DRL response should be cached and for how long.
 * Returning a truthy `CacheCheckResult` opts in to caching; returning a falsy value skips it.
 */
export type CacheCheckCallback = (
  event: FetchEvent | Event,
  drl: string,
) => CacheCheckResult | undefined | null | Promise<CacheCheckResult | undefined | null>;

/**
 * Configuration options for {@link activatePolyfills}.
 */
export type ActivatePolyfillsOptions = {
  /**
   * Path to the script to register as a Service Worker.
   * Falls back to `document.currentScript.src` or `import.meta.url`.
   *
   * **Required in strict CSP environments** where `new Function()` is blocked and `import.meta`
   * cannot be evaluated dynamically.
   */
  path?: string;
  /** Set to `false` to skip Service Worker installation. Defaults to `true`. */
  serviceWorker?: boolean;
  /** Set to `false` to skip injection of DRL loading-overlay styles. Defaults to `true`. */
  injectStyles?: boolean;
  /** Set to `false` to skip activation of DRL anchor/link click handling. Defaults to `true`. */
  links?: boolean;
  /** Callback to control per-request caching behaviour. */
  onCacheCheck?: CacheCheckCallback;
  /**
   * DID method resolvers to use for DRL resolution. Defaults to `[DidDht, DidWeb]`.
   * Pass a custom array to add or replace DID methods (e.g., `[DidDht, DidWeb, DidJwk]`).
   */
  didResolvers?: DidMethodResolver[];
};

/**
 * An `HTMLElement` that has a `src` property (e.g., `<img>`, `<video>`, `<audio>`).
 * Extended with `__src__` to stash the original DRL src during context-menu swaps.
 */
interface DrlMediaElement extends HTMLElement {
  src: string;
  __src__?: string;
}

// This is in place to prevent our `bundler-bonanza` repo from failing for Node CJS builds
// Not sure if this is working as expected in all environments, crated an issue
// TODO: https://github.com/enboxorg/enbox/issues/767
function importMetaIfSupported(): { url: string } | undefined {
  try {
    return new Function('return import.meta')() as { url: string };
  } catch {
    return undefined;
  }
}

let didResolver = new UniversalResolver({ didResolvers: [DidDht, DidWeb] });
const didUrlRegex = /^https?:\/\/dweb\/([^/]+)\/?(.*)?$/;
const httpToHttpsRegex = /^http:/;
const trailingSlashRegex = /\/$/;
const DRL_CACHE_NAME = 'drl';

/** @internal Exported for testing. Resolves DWN service endpoints from a DID. */
export async function getDwnEndpoints(did: string): Promise<string[]> {
  const { didDocument } = await didResolver.resolve(did);
  const endpoints = didDocument?.service?.find(
    (service) => service.type === 'DecentralizedWebNode'
  )?.serviceEndpoint;
  if (!endpoints) {return [];}
  return (Array.isArray(endpoints) ? endpoints : [endpoints]).filter(
    (url) => typeof url === 'string' && url.startsWith('http')
  );
}

/** Returns an open DRL cache, or `undefined` if the Cache API is unavailable. */
async function openDrlCache(): Promise<Cache | undefined> {
  if (typeof caches === 'undefined') {return undefined;}
  return caches.open(DRL_CACHE_NAME);
}

/** @internal Exported for testing. Handles a DRL fetch event. */
export async function handleEvent(
  event: FetchEvent, did: string, path: string, options?: ActivatePolyfillsOptions
): Promise<Response> {
  const drl = event.request.url
    .replace(httpToHttpsRegex, 'https:')
    .replace(trailingSlashRegex, '');
  const responseCache = await openDrlCache();
  const cachedResponse = await responseCache?.match(drl);
  if (cachedResponse) {
    if (!navigator.onLine) {return cachedResponse;}
    const match = await options?.onCacheCheck?.(event, drl);
    if (match) {
      const cacheTime = cachedResponse.headers.get('dwn-cache-time');
      if (
        cacheTime &&
        Date.now() < Number(cacheTime) + (Number(match.ttl) || 0)
      ) {
        return cachedResponse;
      }
    }
  }
  try {
    if (!path) {
      const response = await didResolver.resolve(did);
      return new Response(JSON.stringify(response), {
        status  : 200,
        headers : {
          'Content-Type': 'application/json',
        },
      });
    } else
    {return await fetchResource(event, did, drl, path, responseCache, options);}
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.log(`Error in DID URL fetch: ${error}`);
    return new Response('DID URL fetch error', { status: 500 });
  }
}

/** @internal Exported for testing. Fetches a resource from DWN endpoints. */
export async function fetchResource(
  event: FetchEvent, did: string, drl: string, path: string,
  responseCache: Cache | undefined, options?: ActivatePolyfillsOptions
): Promise<Response> {
  const endpoints = await getDwnEndpoints(did);
  if (!endpoints?.length) {
    throw new Response(
      'DWeb Node resolution failed: no valid endpoints found.',
      { status: 530 }
    );
  }
  let lastError: Response | undefined;
  for (const endpoint of endpoints) {
    try {
      const url = `${endpoint.replace(trailingSlashRegex, '')}/${did}/${path}`;
      const response = await fetch(url, { headers: event.request.headers });
      if (response.ok) {
        const match = await options?.onCacheCheck?.(event, drl);
        if (match && responseCache) {
          cacheResponse(drl, url, response, responseCache);
        }
        return response;
      }
      console.log(`DWN endpoint error: ${response.status}`);
      lastError = new Response('DWeb Node request failed', {
        status: response.status,
      });
    } catch (error) {
      console.log(`DWN endpoint error: ${error}`);
      lastError = new Response('DWeb Node request failed', {
        status: 500,
      });
    }
  }
  return lastError!;
}

/** @internal Exported for testing. Caches a DRL response with metadata headers. */
export async function cacheResponse(drl: string, url: string, response: Response, cache: Cache): Promise<void> {
  try {
    const clonedResponse = response.clone();
    const headers = new Headers(clonedResponse.headers);
    headers.append('dwn-cache-time', Date.now().toString());
    headers.append('dwn-composed-url', url);
    const modifiedResponse = new Response(clonedResponse.body, { headers });
    await cache.put(drl, modifiedResponse);
  } catch (error) {
    console.log(`Failed to cache DRL response: ${error}`);
  }
}

/* Service Worker-based features */

async function installWorker(options: ActivatePolyfillsOptions = {}): Promise<void> {
  try {
    // Check to see if we are in a Service Worker already, if so, proceed
    // You can call the activatePolyfills() function in your own worker, or standalone as a root worker
    if (
      typeof ServiceWorkerGlobalScope !== 'undefined' &&
      self instanceof ServiceWorkerGlobalScope
    ) {
      const workerSelf = self as unknown as ServiceWorkerGlobalScope;
      workerSelf.skipWaiting();
      workerSelf.addEventListener('activate', (event: ExtendableEvent) => {
        // Claim clients to make the service worker take control immediately
        event.waitUntil(workerSelf.clients.claim());
      });
      workerSelf.addEventListener('fetch', (event: FetchEvent) => {
        const match = event.request.url.match(didUrlRegex);
        if (match) {
          event.respondWith(handleEvent(event, match[1], match[2], options));
        }
      });
    }
    // If the code gets here, it is not a SW env, it is likely DOM, but check to be sure
    else if (globalThis?.navigator?.serviceWorker) {
      const registration = await navigator.serviceWorker.getRegistration('/');
      // You can only have one worker per path, so check to see if one is already registered
      if (!registration) {
        const installUrl: string | undefined =
        options.path ||
        (globalThis.document
          ? (document?.currentScript as HTMLScriptElement | null)?.src
          : importMetaIfSupported()?.url);
        if (installUrl)
        {navigator.serviceWorker
          .register(installUrl, { type: 'module' })
          .catch((error: unknown) => {
            console.error(
              'DWeb networking feature installation failed: ',
              error
            );
          });}
      }
    } else {
      throw new Error(
        'DWeb networking features are not available for install in this environment'
      );
    }
  } catch (error) {
    console.error('Error in installing networking features:', error);
  }
}

/* DOM Environment Features */

const loaderStyles = `
  .drl-loading-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    flex-wrap: wrap;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-size: 22px;
    color: #fff;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(15px);
    -webkit-backdrop-filter: blur(15px);
    z-index: 1000000;
  }

  .drl-loading-overlay > div {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .drl-loading-spinner {
    display: flex;
    align-items: center;
    justify-content: center;
  }

    .drl-loading-spinner div {
      position: relative;
      width: 2em;
      height: 2em;
      margin: 0.1em 0.25em 0 0;
    }
    .drl-loading-spinner div::after,
    .drl-loading-spinner div::before {
      content: '';  
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      border: 0.1em solid #FFF;
      position: absolute;
      left: 0;
      top: 0;
      opacity: 0;
      animation: drl-loading-spinner 2s linear infinite;
    }
    .drl-loading-spinner div::after {
      animation-delay: 1s;
    }

  .drl-loading-overlay span {
    --text-opacity: 2;
    display: flex;
    align-items: center;
    margin: 2em auto 0;
    padding: 0.2em 0.75em 0.25em;
    text-align: center;
    border-radius: 5em;
    background: rgba(255 255 255 / 8%);
    opacity: 0.8;
    transition: opacity 0.3s ease;
    cursor: pointer;
  }

    .drl-loading-overlay span:focus {
      opacity: 1;
    }

    .drl-loading-overlay span:hover {
      opacity: 1;
    }

    .drl-loading-overlay span::before {
      content: '✕ ';
      margin: 0 0.4em 0 0;
      color: red;
      font-size: 65%;
      font-weight: bold;
    }

    .drl-loading-overlay span::after {
      content: 'stop';
      display: block;
      font-size: 60%;
      line-height: 0;
      color: rgba(255 255 255 / 60%);
    }

    .drl-loading-overlay.new-tab-overlay span::after {
      content: 'close';
    }
  
  @keyframes drl-loading-spinner {
    0% {
      transform: scale(0);
      opacity: 1;
    }
    100% {
      transform: scale(1);
      opacity: 0;
    }
  }
`;
const tabContent = `
<!DOCTYPE html>
<html lang='en'>
<head>
  <meta charset='UTF-8'>
  <meta name='viewport' content='width=device-width, initial-scale=1.0'>
  <title>Loading DRL...</title>
  <style>
    html, body {
      background-color: #151518;
      height: 100%;
      margin: 0;
      padding: 0;
      font-family: Arial, sans-serif;
      text-align: center;
    }
    ${loaderStyles}
  </style>
</head>
<body>
  <div class='drl-loading-overlay new-tab-overlay'>
    <div class='drl-loading-spinner'>
      <div></div>
      Loading DRL
    </div>
    <span onclick='window.close()' tabindex='0'></span>
  </div>
</body>
</html>
`;

let elementsInjected = false;
let overlayElement: HTMLDivElement | null = null;
let styleElement: HTMLStyleElement | null = null;

function injectElements(): void {
  if (elementsInjected) {return;}
  styleElement = document.createElement('style');
  styleElement.innerHTML = `
    ${loaderStyles}

    .drl-loading-overlay {
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
    }

    :root[drl-link-loading] .drl-loading-overlay {
      opacity: 1;
      pointer-events: all;
    }
  `;
  document.head.append(styleElement);

  overlayElement = document.createElement('div');
  overlayElement.classList.add('drl-loading-overlay');
  overlayElement.innerHTML = `
    <div class='drl-loading-spinner'>
      <div></div>
      Loading DRL
    </div> 
    <span tabindex='0'></span>
  `;
  overlayElement.lastElementChild!.addEventListener('click', cancelNavigation);
  document.body.prepend(overlayElement);
  elementsInjected = true;
}

function removeElements(): void {
  if (!elementsInjected) {return;}
  styleElement?.remove();
  styleElement = null;
  overlayElement?.remove();
  overlayElement = null;
  elementsInjected = false;
}

function cancelNavigation(): void {
  document.documentElement.removeAttribute('drl-link-loading');
  activeNavigation = null;
}

let activeNavigation: string | null = null;
let linkFeaturesActive = false;

// Stored references for listener cleanup in deactivatePolyfills()
let clickHandler: ((event: MouseEvent) => Promise<void>) | null = null;
let pointerdownHandler: ((event: PointerEvent) => Promise<void>) | null = null;

function addLinkFeatures(): void {
  if (!linkFeaturesActive) {
    clickHandler = async (event: MouseEvent): Promise<void> => {
      const anchor = (event.target as Element)?.closest('a');
      if (anchor) {
        const href = anchor.href;
        const match = href.match(didUrlRegex);
        if (match) {
          const did = match[1];
          const path = match[2];
          const openAsTab = anchor.target === '_blank';
          event.preventDefault();
          try {
            let tab: Window | null = null;
            if (openAsTab) {
              tab = window.open('', '_blank');
              if (tab) {tab.document.write(tabContent);}
            } else {
              activeNavigation = path;
              // this is to allow for cached DIDs to instantly load without any flash of loading UI
              setTimeout(
                () =>
                  document.documentElement.setAttribute('drl-link-loading', ''),
                50
              );
            }
            const endpoints = await getDwnEndpoints(did);
            if (!endpoints.length) {
              throw new Error('no valid DWN endpoints found');
            }
            const url = `${endpoints[0].replace(
              trailingSlashRegex,
              ''
            )}/${did}/${path}`;
            if (openAsTab) {
              if (tab && !tab.closed) {tab.location.href = url;}
            } else if (activeNavigation === path) {
              window.location.href = url;
            }
          } catch {
            if (activeNavigation === path) {
              cancelNavigation();
            }
            throw new Error(
              `DID endpoint resolution failed for the DRL: ${href}`
            );
          }
        }
      }
    };

    pointerdownHandler = async (event: PointerEvent): Promise<void> => {
      const target = event.composedPath()[0] as DrlMediaElement | undefined;
      if (
        (event.pointerType === 'mouse' && event.button === 2) ||
        (event.pointerType === 'touch' && event.isPrimary)
      ) {
        resetContextMenuTarget();
        if (target?.src?.match(didUrlRegex)) {
          contextMenuTarget = target;
          target.__src__ = target.src;
          const drl = target.src
            .replace(httpToHttpsRegex, 'https:')
            .replace(trailingSlashRegex, '');
          const responseCache = await openDrlCache();
          const response = await responseCache?.match(drl);
          if (response) {
            const url = response.headers.get('dwn-composed-url');
            if (url) {target.src = url;}
          }
          target.addEventListener('pointerup', resetContextMenuTarget, {
            once: true,
          });
        }
      } else if (target === contextMenuTarget) {
        resetContextMenuTarget();
      }
    };

    document.addEventListener('click', clickHandler);
    document.addEventListener('pointercancel', resetContextMenuTarget);
    document.addEventListener('pointerdown', pointerdownHandler);

    linkFeaturesActive = true;
  }
}

function removeLinkFeatures(): void {
  if (!linkFeaturesActive) {return;}
  if (clickHandler) {
    document.removeEventListener('click', clickHandler);
    clickHandler = null;
  }
  if (pointerdownHandler) {
    document.removeEventListener('pointerdown', pointerdownHandler);
    pointerdownHandler = null;
  }
  document.removeEventListener('pointercancel', resetContextMenuTarget);
  resetContextMenuTarget();
  cancelNavigation();
  linkFeaturesActive = false;
}

let contextMenuTarget: DrlMediaElement | null = null;
async function resetContextMenuTarget(e?: Event): Promise<void> {
  if (e?.type === 'pointerup') {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  if (contextMenuTarget) {
    contextMenuTarget.src = contextMenuTarget.__src__!;
    delete contextMenuTarget.__src__;
    contextMenuTarget = null;
  }
}

/**
 * Activates various polyfills to enable Web5 features in Web environments.
 *
 * @param options - Configuration options to control the activation of polyfills.
 *
 * @example
 * // Activate all polyfills with default options, and cache every DRL for 1 minute
 * activatePolyfills({
 *   onCacheCheck(event, route){
 *     return {
 *       ttl: 60_000
 *     }
 *   }
 * });
 *
 * @example
 * // Activate polyfills, but without Service Worker activation
 * activatePolyfills({ serviceWorker: false });
 *
 * @example
 * // Use custom DID resolvers
 * activatePolyfills({ didResolvers: [DidDht, DidWeb, DidJwk] });
 */
export function activatePolyfills(options: ActivatePolyfillsOptions = {}): void {
  if (options.didResolvers) {
    didResolver = new UniversalResolver({ didResolvers: options.didResolvers });
  }
  if (options.serviceWorker !== false) {
    installWorker(options);
  }
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    if (options.injectStyles !== false) {
      if (document.readyState !== 'loading') {injectElements();}
      else {
        document.addEventListener('DOMContentLoaded', injectElements, {
          once: true,
        });
      }
    }
    if (options.links !== false) {addLinkFeatures();}
  }
}

/**
 * Removes all polyfill event listeners, injected DOM elements, and resets internal state.
 * Call this to fully clean up after {@link activatePolyfills}.
 *
 * Does **not** unregister an installed Service Worker — use
 * `navigator.serviceWorker.getRegistration('/').then(r => r?.unregister())` for that.
 */
export function deactivatePolyfills(): void {
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    removeLinkFeatures();
    removeElements();
  }
}

/**
 * Deletes the entire DRL response cache.
 * Useful for clearing stale cached DWN responses.
 *
 * @returns `true` if the cache existed and was deleted, `false` otherwise.
 *          Returns `false` if the Cache API is unavailable.
 */
export async function clearDrlCache(): Promise<boolean> {
  if (typeof caches === 'undefined') {return false;}
  return caches.delete(DRL_CACHE_NAME);
}
