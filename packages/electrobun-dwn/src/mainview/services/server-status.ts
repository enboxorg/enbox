import type {
  AppStore,
  ConnectionSnapshot,
} from '../state/app-store.js';

const candidatePorts = [3000, 55500, 55501, 55502, 55503, 55504, 55505, 55506, 55507, 55508, 55509];
const candidateHosts = ['127.0.0.1'];
const maxRetries = 5;
const retryDelayMs = 800;

type ServerInfo = {
  server: string;
  version: string;
  webSocketSupport: boolean;
  registrationRequirements: string[];
  maxFileSize: number;
};

let activeRefreshPromise: Promise<void> | null = null;

export function ensureServerStatus(store: AppStore): Promise<void> {
  if (!activeRefreshPromise) {
    activeRefreshPromise = refreshServerStatus(store).finally(() => {
      activeRefreshPromise = null;
    });
  }

  return activeRefreshPromise;
}

async function refreshServerStatus(store: AppStore): Promise<void> {
  store.connection.markConnecting();

  const baseUrl = await resolveServerEndpoint();
  store.connection.markConnecting(baseUrl);

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const info = await fetchServerInfo(baseUrl);
    if (info) {
      store.connection.markOnline(buildConnectionSnapshot(baseUrl, info));
      return;
    }

    await delay(retryDelayMs);
  }

  store.connection.markOffline({
    endpoint  : baseUrl,
    updatedAt : formattedTime(),
  });
}

function buildConnectionSnapshot(
  baseUrl: string,
  info: ServerInfo,
): Omit<ConnectionSnapshot, 'state'> {
  return {
    endpoint      : baseUrl,
    updatedAt     : formattedTime(),
    serverUrl     : baseUrl,
    serverName    : info.server,
    serverVersion : info.version,
    wsSupport     : info.webSocketSupport ? 'Enabled' : 'Disabled',
  };
}

function formattedTime(): string {
  return new Date().toLocaleTimeString(undefined, {
    hour   : '2-digit',
    minute : '2-digit',
    second : '2-digit',
  });
}

function getEndpointFromQueryParam(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const endpoint = params.get('endpoint');
    if (endpoint?.startsWith('http')) {
      return endpoint;
    }
  } catch {
    // If URL parsing fails, fall through to probing.
  }

  return null;
}

async function detectLocalDwnBaseUrl(): Promise<string> {
  for (const port of candidatePorts) {
    for (const host of candidateHosts) {
      const infoUrl = `http://${host}:${port}/info`;

      try {
        const response = await fetch(infoUrl);
        if (!response.ok) {
          continue;
        }

        const serverInfo = await response.json();
        if (serverInfo?.server === '@enbox/dwn-server') {
          return `http://127.0.0.1:${port}`;
        }
      } catch {
        // Keep probing candidate endpoints.
      }
    }
  }

  return 'http://127.0.0.1:3000';
}

async function resolveServerEndpoint(): Promise<string> {
  const fromParam = getEndpointFromQueryParam();
  if (fromParam) {
    return fromParam;
  }

  return detectLocalDwnBaseUrl();
}

async function fetchServerInfo(baseUrl: string): Promise<ServerInfo | null> {
  try {
    const response = await fetch(`${baseUrl}/info`);
    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
