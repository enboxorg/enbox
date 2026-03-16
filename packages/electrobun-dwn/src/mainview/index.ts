import type { IdentityRuntime } from './identity-runtime.js';

import { ContextRoot } from '@lit/context';
import { Router } from '@vaadin/router';

import { createDidResolverRuntime } from './utils/dids.js';
import { createRouter } from './router.js';
import { ensureIdentityRuntime } from './identity-runtime.js';
import { ensureServerStatus } from './services/server-status.js';
import { getAppStore } from './state/app-store.js';

import './components/app-shell/index.js';
import './components/connection-badge/index.js';
import './components/identity-switcher/index.js';
import './components/notification-drawer/index.js';
import './components/toast-region/index.js';
import './components/x-accordion/index.js';
import './components/x-code/index.js';
import './index.css';
import './pages/apps/index.js';
import './pages/home/index.js';
import './pages/identity/index.js';
import './pages/permissions/index.js';
import './pages/resolver/index.js';

// Force dark mode for the dashboard shell.
localStorage.colorScheme = 'dark';
document.documentElement.classList.add('wa-dark');

if (/mac/i.test(navigator.platform)) {
  document.documentElement.classList.add('platform-macos');
}

type SearchInputElement = HTMLElement & { value?: string };
type DidResolverRuntime = ReturnType<typeof createDidResolverRuntime>;
type SyntaxHighlightNamespace = {
  config?: {
    languages?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};
type AppWindow = Window & {
  __didResolverRuntime?: DidResolverRuntime;
  __identityRuntime?: IdentityRuntime;
  she?: SyntaxHighlightNamespace;
};

function getAppWindow(): AppWindow {
  return window as AppWindow;
}

async function clearRendererStorageIfRequested(): Promise<void> {
  if (process.env.MAINVIEW_RESET_STORAGE_ON_START !== 'true') {
    return;
  }

  if (typeof globalThis.localStorage !== 'undefined') {
    try {
      globalThis.localStorage.clear();
    } catch {
      // Best-effort reset only.
    }
  }

  if (typeof globalThis.indexedDB === 'undefined') {
    return;
  }

  if (typeof globalThis.indexedDB.databases !== 'function') {
    return;
  }

  try {
    const databases = await globalThis.indexedDB.databases();
    await Promise.all(
      databases
        .map((entry): string | undefined => entry.name)
        .filter((name): name is string => !!name)
        .map((name): Promise<void> => new Promise<void>((resolveDelete: () => void): void => {
          const request = globalThis.indexedDB.deleteDatabase(name);
          request.onsuccess = (): void => resolveDelete();
          request.onerror = (): void => resolveDelete();
          request.onblocked = (): void => resolveDelete();
        })),
    );
  } catch {
    // Best-effort reset only.
  }
}

function ensureDidResolverRuntime(): DidResolverRuntime {
  const appWindow = getAppWindow();
  if (!appWindow.__didResolverRuntime) {
    appWindow.__didResolverRuntime = createDidResolverRuntime();
  }

  return appWindow.__didResolverRuntime;
}

async function ensureSyntaxHighlightElement(): Promise<void> {
  const appWindow = getAppWindow();
  const existingNamespace = appWindow.she ?? {};
  const existingConfig = existingNamespace.config ?? {};
  const existingLanguages = Array.isArray(existingConfig.languages)
    ? existingConfig.languages
    : ['markup', 'css', 'javascript'];

  appWindow.she = {
    ...existingNamespace,
    config: {
      ...existingConfig,
      languages: Array.from(new Set([...existingLanguages, 'json'])),
    },
  };

  await import('syntax-highlight-element');
}

function getDidFromLocation(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const did = (params.get('did') ?? '').trim();
    if (did.toLowerCase().startsWith('did:')) {
      return did;
    }
  } catch {
    // If URL parsing fails, preserve existing resolver state.
  }

  return null;
}

function setCurrentResolverDid(did: string): void {
  const normalizedDid = did.trim();
  if (normalizedDid.length === 0) {
    return;
  }

  getAppStore().resolver.setCurrentDid(normalizedDid);
}

function captureResolverDidFromLocation(): string | null {
  const didFromLocation = getDidFromLocation();
  if (didFromLocation) {
    setCurrentResolverDid(didFromLocation);
    return didFromLocation;
  }

  return null;
}

function installGlobalSearchHandler(
  router: { navigate: (route: 'data') => void },
): void {
  const searchInput = document.querySelector('#global-search-input');
  if (!(searchInput instanceof HTMLElement)) {
    return;
  }

  const searchInputElement = searchInput as SearchInputElement;

  searchInputElement.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.isComposing) {
      return;
    }

    event.preventDefault();

    const submittedValue = (searchInputElement.value ?? '').trim();
    searchInputElement.value = submittedValue;

    if (submittedValue.length === 0) {
      return;
    }

    if (submittedValue.toLowerCase().startsWith('did:')) {
      setCurrentResolverDid(submittedValue);
      Router.go(`/resolver?did=${encodeURIComponent(submittedValue)}`);
      return;
    }

    router.navigate('data');
  });
}

async function start(): Promise<void> {
  const contextRoot = new ContextRoot();
  if (document.body instanceof HTMLElement) {
    contextRoot.attach(document.body);
  }

  await clearRendererStorageIfRequested();
  await ensureSyntaxHighlightElement();
  const appStore = getAppStore();
  ensureDidResolverRuntime();
  ensureIdentityRuntime(getAppWindow());
  captureResolverDidFromLocation();
  void ensureServerStatus(appStore);

  const router = createRouter({
    onRouteActivated: (route) => {
      appStore.route.setActive(route);
      if (route !== 'resolver') {
        return;
      }

      captureResolverDidFromLocation();
    },
  });

  appStore.setRouter(router);
  installGlobalSearchHandler(router);
  await router.init();
}

void start();
