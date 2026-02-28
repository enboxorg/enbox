/**
 * Well-known ports and hosts for local DWN detection (browser context).
 *
 * Keep in sync with `localDwnPortCandidates` and `localDwnHostCandidates`
 * in `@enbox/agent/src/local-dwn.ts`.
 *
 * TODO(#590): Eliminate this duplicate port-probing by having the bun side
 * pass the resolved endpoint to the mainview via Electrobun RPC/IPC.
 * The mainview runs in a BrowserWindow and cannot import `@enbox/agent`.
 */
const candidatePorts = [3000, 55500, 55501, 55502, 55503, 55504, 55505, 55506, 55507, 55508, 55509];
const candidateHosts = ['127.0.0.1'];

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

async function renderServerUrl(): Promise<void> {
  const serverUrlEl = document.querySelector<HTMLAnchorElement>('#server-url');
  if (!serverUrlEl) {
    return;
  }

  const baseUrl = await detectLocalDwnBaseUrl();
  serverUrlEl.href = baseUrl;
  serverUrlEl.textContent = baseUrl;
}

void renderServerUrl();
