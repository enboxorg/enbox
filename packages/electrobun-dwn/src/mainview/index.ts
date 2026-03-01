/**
 * Mainview UI for the Electrobun DWN desktop app.
 *
 * The bun process passes the resolved server endpoint via the `endpoint`
 * query parameter when constructing the BrowserWindow URL. This avoids
 * duplicate port-probing that was previously needed.
 *
 * A fallback probe is retained for defensive robustness in case the query
 * parameter is ever missing.
 *
 * Keep fallback port list in sync with `localDwnPortCandidates` and
 * `localDwnHostCandidates` in `@enbox/agent/src/local-dwn.ts`.
 */

const candidatePorts = [3000, 55500, 55501, 55502, 55503, 55504, 55505, 55506, 55507, 55508, 55509];
const candidateHosts = ['127.0.0.1'];

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

  // Fallback: probe ports (should rarely be needed).
  return detectLocalDwnBaseUrl();
}

async function renderServerUrl(): Promise<void> {
  const serverUrlEl = document.querySelector<HTMLAnchorElement>('#server-url');
  if (!serverUrlEl) {
    return;
  }

  const baseUrl = await resolveServerEndpoint();
  serverUrlEl.href = baseUrl;
  serverUrlEl.textContent = baseUrl;
}

void renderServerUrl();
