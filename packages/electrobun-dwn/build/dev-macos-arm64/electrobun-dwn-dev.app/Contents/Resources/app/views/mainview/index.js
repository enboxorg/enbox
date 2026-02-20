// src/mainview/index.ts
var candidatePorts = [3000, 55555, 55556, 55557, 55558, 55559];
var candidateHosts = ["127.0.0.1", "localhost"];
async function detectLocalDwnBaseUrl() {
  for (const port of candidatePorts) {
    for (const host of candidateHosts) {
      const infoUrl = `http://${host}:${port}/info`;
      try {
        const response = await fetch(infoUrl);
        if (!response.ok) {
          continue;
        }
        const serverInfo = await response.json();
        if (serverInfo?.server === "@enbox/dwn-server") {
          return `http://localhost:${port}`;
        }
      } catch {}
    }
  }
  return "http://localhost:3000";
}
async function renderServerUrl() {
  const serverUrlEl = document.querySelector("#server-url");
  if (!serverUrlEl) {
    return;
  }
  const baseUrl = await detectLocalDwnBaseUrl();
  serverUrlEl.href = baseUrl;
  serverUrlEl.textContent = baseUrl;
}
renderServerUrl();
