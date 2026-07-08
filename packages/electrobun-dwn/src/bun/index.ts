import type { DwnServerConfig } from '@enbox/dwn-server';

import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

import {
  buildDwnDiscoveryRedirectUrl,
  DwnDiscoveryFile,
  localDwnPortCandidates,
  parseDwnConnectUrl,
} from '@enbox/agent';
import Electrobun, { ApplicationMenu, BrowserWindow, Tray, Utils } from 'electrobun/bun';

function selectPortCandidates(): number[] {
  const envPort = Bun.env['DS_PORT'];
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return [parsed];
    }
  }

  return [...localDwnPortCandidates];
}

const webSocketSupport = (
  { on: true, off: false } as const
)[process.env['DS_WEBSOCKET_SERVER'] ?? ''] ?? true;

function resolveDwnServerPackageJsonPath(): string {
  const envPath = process.env['DWN_SERVER_PACKAGE_JSON'];
  if (envPath) {
    return envPath;
  }

  try {
    const resolvedPath = import.meta.require.resolve(
      '@enbox/dwn-server/package.json',
    );
    if (typeof resolvedPath === 'string' && resolvedPath.length > 0) {
      return resolvedPath;
    }
  } catch {
    // Fall back to the server package default path.
  }

  return '/dwn-server/package.json';
}

/**
 * Build a partial DwnServerConfig for the local desktop server.
 *
 * Only the properties relevant to local operation are set here; the
 * remaining fields (rate-limiting, admin UI, provider-auth, etc.)
 * keep their defaults from the dwn-server `config` module.
 */
function createDwnServerConfig(port: number): Partial<DwnServerConfig> {
  return {
    serverName        : process.env['DWN_SERVER_PACKAGE_NAME'] || '@enbox/dwn-server',
    baseUrl           : process.env['DWN_BASE_URL'] || `http://127.0.0.1:${port}`,
    port,
    ttlCacheUrl       : process.env['DWN_TTL_CACHE_URL'] || 'sqlite://',
    packageJsonPath   : resolveDwnServerPackageJsonPath(),
    maxRecordDataSize : 1_073_741_824, // 1 GB
    webSocketSupport,

    eventBusPluginPath : process.env['DWN_EVENT_BUS_PLUGIN_PATH'],
    messageStore       : process.env['DWN_STORAGE_MESSAGES'] || process.env['DWN_STORAGE'] || 'level://data',
    dataStore          : process.env['DWN_STORAGE_DATA'] || process.env['DWN_STORAGE'] || 'level://data',
    resumableTaskStore : process.env['DWN_STORAGE_RESUMABLE_TASKS'] || process.env['DWN_STORAGE'] || 'level://data',

    registrationStoreUrl                  : process.env['DWN_REGISTRATION_STORE_URL'] || process.env['DWN_STORAGE'],
    registrationProofOfWorkSeed           : process.env['DWN_REGISTRATION_PROOF_OF_WORK_SEED'],
    registrationProofOfWorkEnabled        : process.env['DWN_REGISTRATION_PROOF_OF_WORK_ENABLED'] === 'true',
    registrationProofOfWorkInitialMaxHash : process.env['DWN_REGISTRATION_PROOF_OF_WORK_INITIAL_MAX_HASH'],
    termsOfServiceFilePath                : process.env['DWN_TERMS_OF_SERVICE_FILE_PATH'],

    logLevel: process.env['DWN_SERVER_LOG_LEVEL'] || 'INFO',

    // Forward writes to the tenant's remote DWN endpoints listed in their
    // DID document, ensuring the local node is not a dead-end silo.
    forwardingEnabled : true,
    deliveryEnabled   : true,
  };
}

// TODO: Consolidate all persistent storage under ~/.enbox so a single
// `rm -rf ~/.enbox` cleanly resets the app.  Currently the DWN server
// stores its LevelDB data under ~/.enbox, but the WKWebView persists
// localStorage, IndexedDB, and cookies under ~/Library/WebKit/<app-id>/
// (macOS) which is controlled by the native WebKit data store.  Electrobun
// does not yet expose a way to configure the WKWebsiteDataStore path.
// Options: (1) upstream Electrobun feature to set the data store directory,
// (2) symlink ~/Library/WebKit/org.enbox.electrobun-dwn → ~/.enbox/webview,
// (3) clear webview storage programmatically on startup when ~/.enbox is
// missing (detect orphaned browser state).
function resolveLevelStoreRoot(storeUrl: string | undefined): string | undefined {
  if (!storeUrl) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(storeUrl);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'level:') {
    return undefined;
  }

  const levelPath = `${parsed.host}${parsed.pathname}`;
  if (!levelPath) {
    return undefined;
  }

  // `level://foo` is relative; `level:///foo` is absolute.
  return levelPath.startsWith('/')
    ? levelPath
    : resolve(process.cwd(), levelPath);
}

function isSafeResetPath(path: string): boolean {
  if (!path) {
    return false;
  }

  if (path === '/' || path === '/Users' || path === process.env.HOME) {
    return false;
  }

  return true;
}

function resetDwnStorageIfRequested(portCandidates: number[]): void {
  if (process.env.DWN_RESET_ON_START !== 'true') {
    return;
  }

  const config = createDwnServerConfig(portCandidates[0] ?? 3000);
  const candidateRoots = new Set<string>();
  const storageTargets = [
    config.messageStore,
    config.dataStore,
    config.resumableTaskStore,
    config.registrationStoreUrl,
  ];

  for (const storeUrl of storageTargets) {
    const storeRoot = resolveLevelStoreRoot(storeUrl);
    if (storeRoot) {
      candidateRoots.add(storeRoot);
    }
  }

  for (const targetPath of candidateRoots) {
    if (!isSafeResetPath(targetPath) || !existsSync(targetPath)) {
      continue;
    }

    rmSync(targetPath, { recursive: true, force: true });
    console.log(`[electrobun-dwn] Reset storage path: ${targetPath}`);
  }
}

// ─── Discovery file ──────────────────────────────────────────────
//
// Write ~/.enbox/dwn.json on startup so CLI/native apps can discover
// the local DWN server without port probing.  Uses the shared
// `DwnDiscoveryFile` class from `@enbox/agent` for consistent
// validation, permissions (0600), and path resolution.

const discoveryFile = new DwnDiscoveryFile();

// ─── Port selection ──────────────────────────────────────────────

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  if (typeof maybeCode === 'string' && maybeCode === 'EADDRINUSE') {
    return true;
  }

  const maybeMessage = (error as { message?: unknown }).message;
  if (
    typeof maybeMessage === 'string' &&
    (maybeMessage.includes('EADDRINUSE') ||
      maybeMessage.toLowerCase().includes('address already in use'))
  ) {
    return true;
  }

  const maybeCause = (error as { cause?: unknown }).cause;
  return isAddressInUseError(maybeCause);
}

const { DwnServer } = await import('@enbox/dwn-server');
const portCandidates = selectPortCandidates();
resetDwnStorageIfRequested(portCandidates);

let selectedPort: number | undefined;
let dwnServer: InstanceType<typeof DwnServer> | undefined;

for (const port of portCandidates) {
  const candidateServer = new DwnServer({ config: createDwnServerConfig(port) as DwnServerConfig });
  try {
    await candidateServer.start();
    selectedPort = port;
    dwnServer = candidateServer;
    break;
  } catch (error) {
    const isAddressInUse = isAddressInUseError(error);
    if (!isAddressInUse || Bun.env['DS_PORT']) {
      throw error;
    }

    try {
      await candidateServer.dwn?.close();
    } catch (closeError) {
      console.warn(
        `[electrobun-dwn] Failed to clean up after port ${port} probe`,
        closeError,
      );
    }

    console.warn(
      `[electrobun-dwn] Port ${port} is busy, trying next candidate`,
    );
  }
}

if (!dwnServer || selectedPort === undefined) {
  throw new Error(
    `No available port found in ${portCandidates.join(', ')} for local DWN server.`,
  );
}

const serverEndpoint = `http://127.0.0.1:${selectedPort}`;
console.log(
  `[electrobun-dwn] DWN server listening on ${serverEndpoint}`,
);

// Write the discovery file so CLI/native apps can find us.
const capabilities = webSocketSupport ? ['http', 'ws'] : ['http'];
await discoveryFile.write({ endpoint: serverEndpoint, pid: process.pid, capabilities });
console.log(`[electrobun-dwn] Discovery file written: ${discoveryFile.path}`);

let mainWindow: BrowserWindow | undefined;
const mainviewUrl = 'views://mainview/index.html';
const mainviewInitialLoadDelayMs = 120;
const mainviewLoadRetryDelayMs = 350;
const mainviewLoadMaxAttempts = 6;

ApplicationMenu.setApplicationMenu([
  {
    label   : 'electrobun-dwn',
    submenu : [
      { role: 'about' },
      { type: 'divider' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'showAll' },
      { type: 'divider' },
      { role: 'quit' },
    ],
  },
  {
    label   : 'Edit',
    submenu : [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'divider' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'selectAll' },
    ],
  },
  {
    label   : 'Window',
    submenu : [
      { role: 'minimize' },
      { role: 'zoom' },
      { role: 'close' },
    ],
  },
]);

function createMainWindow(): BrowserWindow {
  // Note: electrobun's views:// protocol handler does not strip query
  // parameters before resolving the file path, so passing ?endpoint=...
  // causes a "file not found" error.  The mainview discovers the server
  // endpoint by probing well-known ports via fetch('/info').
  const window = new BrowserWindow({
    title           : 'Enbox DWN Server',
    // Delay the initial `views://` navigation until the webview exists.
    // Creating the window with the URL inline can race the native views
    // registration and intermittently yield an empty response for index.html.
    url             : null,
    // Work around Electrobun 1.15.1's macOS resize bug for default titled windows.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    navigationRules : [
      '^*',
      'views://*',
      'about:*',
      'data:*',
      'blob:*',
      'http://127.0.0.1:*/*',
      'http://localhost:*/*',
      // Allow did:web resolution against arbitrary public HTTPS hosts.
      'https://*/*',
    ],
    frame: {
      width  : 1200,
      height : 1000,
      x      : 200,
      y      : 120,
    },
  });

  loadMainviewWhenReady(window);

  window.on('close', () => {
    if (mainWindow?.id === window.id) {
      mainWindow = undefined;
    }
  });

  return window;
}

function loadMainviewWhenReady(window: BrowserWindow): void {
  let hasDomReady = false;
  let loadAttempts = 0;

  window.webview.on('dom-ready', () => {
    hasDomReady = true;
  });

  const attemptLoad = (): void => {
    if (hasDomReady) {
      return;
    }

    const liveWindow = BrowserWindow.getById(window.id);
    if (!liveWindow) {
      return;
    }

    const webview = liveWindow.webview;
    if (!webview) {
      return;
    }

    loadAttempts += 1;

    try {
      console.log(
        `[electrobun-dwn] Loading mainview ${loadAttempts}/${mainviewLoadMaxAttempts}: ${mainviewUrl}`,
      );
      webview.loadURL(mainviewUrl);
    } catch (error) {
      console.warn(
        `[electrobun-dwn] Failed to issue mainview load attempt ${loadAttempts}`,
        error,
      );
    }

    if (loadAttempts >= mainviewLoadMaxAttempts) {
      console.error(
        `[electrobun-dwn] Mainview did not reach dom-ready after ${loadAttempts} load attempts`,
      );
      return;
    }

    setTimeout(() => {
      if (!hasDomReady) {
        attemptLoad();
      }
    }, mainviewLoadRetryDelayMs);
  };

  setTimeout(attemptLoad, mainviewInitialLoadDelayMs);
}

function showMainWindow(): void {
  if (!mainWindow || !BrowserWindow.getById(mainWindow.id)) {
    mainWindow = createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.unminimize();
  }

  mainWindow.show();
}

mainWindow = createMainWindow();

const tray = new Tray({
  image    : 'views://mainview/assets/logo.svg',
  template : true,
  width    : 20,
  height   : 16,
});
tray.setMenu([
  { type: 'normal', label: 'Open Dashboard', action: 'open-main-window' },
  { type: 'divider' },
  { type: 'normal', label: 'Shutdown', action: 'quit-app' },
]);

tray.on('tray-clicked', (event: { data: { action?: string } }) => {
  const action = event.data.action;
  if (action === 'quit-app') {
    void shutdown({ quitApp: true });
    return;
  }

  // Default tray click + explicit "open-main-window" both raise the UI.
  showMainWindow();
});

// ─── dwn:// protocol handler ────────────────────────────────────
//
// When the OS opens a `dwn://connect?callback=<url>` URL, we parse
// the callback, build a redirect URL with the local DWN endpoint
// encoded in the fragment, and open it in the user's default browser.

Electrobun.events.on('open-url', (e: { data: { url: string } }) => {
  const params = parseDwnConnectUrl(e.data.url);
  if (!params) {
    console.warn(`[electrobun-dwn] Ignoring unrecognised dwn:// URL: ${e.data.url}`);
    return;
  }

  const redirectUrl = buildDwnDiscoveryRedirectUrl(params.callback, { endpoint: serverEndpoint });
  console.log(`[electrobun-dwn] dwn://connect redirect → ${redirectUrl}`);

  Utils.openExternal(redirectUrl);
});

let isShuttingDown = false;

async function shutdown(options: { quitApp?: boolean } = {}): Promise<void> {
  if (isShuttingDown) { return; }
  isShuttingDown = true;

  try {
    tray.remove();
  } catch {
    // Best-effort cleanup — tray may not exist on this platform.
  }

  // Remove the discovery file before stopping the server.
  try {
    await discoveryFile.remove();
    console.log(`[electrobun-dwn] Discovery file removed: ${discoveryFile.path}`);
  } catch {
    // Best-effort cleanup — the file may already be gone.
  }

  try {
    await dwnServer!.stop();
  } catch (error) {
    console.error('[electrobun-dwn] Failed to stop DWN server cleanly', error);
  }

  if (options.quitApp) {
    Utils.quit();
  }
}

Electrobun.events.on('before-quit', (event: { response: { allow: boolean } }) => {
  // Cancel the first quit attempt so we can remove discovery metadata and
  // stop the DWN server cleanly before requesting the final process exit.
  if (isShuttingDown) {
    return;
  }

  event.response = { allow: false };
  void shutdown({ quitApp: true });
});

// Clean up the discovery file on signal-based termination (e.g. `kill`).
process.on('SIGTERM', () => { void shutdown({ quitApp: true }); });
process.on('SIGINT', () => { void shutdown({ quitApp: true }); });
