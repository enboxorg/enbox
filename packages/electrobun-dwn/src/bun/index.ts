import 'reflect-metadata';

import type { DwnServerConfig } from '@enbox/dwn-server';

import {
  buildDwnDiscoveryRedirectUrl,
  DwnDiscoveryFile,
  localDwnPortCandidates,
  parseDwnConnectUrl,
} from '@enbox/agent';
import Electrobun, { BrowserWindow, Utils } from 'electrobun/bun';

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

    eventLogPluginPath : process.env['DWN_EVENT_LOG_PLUGIN_PATH'] || process.env['DWN_EVENT_STREAM_PLUGIN_PATH'],
    messageStore       : process.env['DWN_STORAGE_MESSAGES'] || process.env['DWN_STORAGE'] || 'level://data',
    dataStore          : process.env['DWN_STORAGE_DATA'] || process.env['DWN_STORAGE'] || 'level://data',
    stateIndex         : process.env['DWN_STORAGE_STATE_INDEX'] || process.env['DWN_STORAGE'] || 'level://data',
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

// Note: electrobun's views:// protocol handler does not strip query
// parameters before resolving the file path, so passing ?endpoint=...
// causes a "file not found" error.  The mainview discovers the server
// endpoint by probing well-known ports via fetch('/info').
const mainWindow = new BrowserWindow({
  title : 'Enbox DWN Server',
  url   : 'views://mainview/index.html',
  frame : {
    width  : 860,
    height : 620,
    x      : 200,
    y      : 120,
  },
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

async function shutdown(): Promise<void> {
  if (isShuttingDown) { return; }
  isShuttingDown = true;

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

  Utils.quit();
}

mainWindow.on('close', () => {
  void shutdown();
});

// Clean up the discovery file on signal-based termination (e.g. `kill`).
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
