/**
 * Mainview UI for the Electrobun DWN desktop app.
 *
 * Discovers the running DWN server by probing well-known ports on
 * `127.0.0.1` and fetching `/info`. A query-parameter shortcut is
 * supported as a future optimization if electrobun's `views://`
 * protocol handler gains query-string stripping.
 *
 * Keep port list in sync with `localDwnPortCandidates` and
 * `localDwnHostCandidates` in `@enbox/agent/src/local-dwn.ts`.
 */

const candidatePorts = [3000, 55500, 55501, 55502, 55503, 55504, 55505, 55506, 55507, 55508, 55509];
const candidateHosts = ['127.0.0.1'];

interface ServerInfo {
  server: string;
  version: string;
  webSocketSupport: boolean;
  registrationRequirements: string[];
  maxFileSize: number;
}

/**
 * Try to read the endpoint from the query string set by the bun process.
 */
function getEndpointFromQueryParam(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const endpoint = params.get('endpoint');
    if (endpoint && endpoint.startsWith('http')) {
      return endpoint;
    }
  } catch {
    // Defensive: if URL parsing fails, fall through to probing.
  }
  return null;
}

/**
 * Fallback: probe well-known ports to find the running DWN server.
 */
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

  // Primary path: probe ports to find the running DWN server.
  return detectLocalDwnBaseUrl();
}

/**
 * Fetch server info from the `/info` endpoint and return it, or `null` on
 * failure.
 */
async function fetchServerInfo(baseUrl: string): Promise<ServerInfo | null> {
  try {
    const response = await fetch(`${baseUrl}/info`);
    if (!response.ok) {
      return null;
    }
    return await response.json() as ServerInfo;
  } catch {
    return null;
  }
}

/**
 * Set a text element's content by ID, with a fallback of `'--'`.
 */
function setText(id: string, value: string | undefined): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value ?? '--';
  }
}

/**
 * Update all UI elements with the resolved server info.
 */
function applyServerInfo(
  baseUrl: string,
  info: ServerInfo | null,
): void {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status');
  const serverUrlEl = document.querySelector<HTMLAnchorElement>('#server-url');

  if (info) {
    // Server is reachable — show online state.
    if (statusDot) {
      statusDot.classList.remove('offline');
    }
    if (statusText) {
      statusText.textContent = 'Running at ';
    }
    if (serverUrlEl) {
      serverUrlEl.href = baseUrl;
      serverUrlEl.textContent = baseUrl;
    }

    setText('endpoint', baseUrl);
    setText('server-name', info.server);
    setText('server-version', info.version);
    setText('ws-support', info.webSocketSupport ? 'Enabled' : 'Disabled');
  } else {
    // Server unreachable — show offline state.
    if (statusDot) {
      statusDot.classList.add('offline');
    }
    if (statusText) {
      statusText.textContent = 'Unable to reach server';
    }
    if (serverUrlEl) {
      serverUrlEl.href = '#';
      serverUrlEl.textContent = '';
    }

    setText('endpoint', baseUrl);
    setText('server-name', '--');
    setText('server-version', '--');
    setText('ws-support', '--');
  }
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 800;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Initialize the UI: resolve the server endpoint, fetch `/info` (with
 * retries to handle race conditions on startup), and populate all
 * status elements.
 */
async function initUI(): Promise<void> {
  const baseUrl = await resolveServerEndpoint();

  // The DWN server should be running before the webview loads, but
  // retry a few times in case the HTTP listener isn't ready yet.
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const info = await fetchServerInfo(baseUrl);
    if (info) {
      applyServerInfo(baseUrl, info);
      return;
    }
    await delay(RETRY_DELAY_MS);
  }

  // All retries exhausted — show offline state.
  applyServerInfo(baseUrl, null);
}

void initUI();
