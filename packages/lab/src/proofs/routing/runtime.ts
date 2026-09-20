import type { Socket, TCPSocketListener } from 'bun';

import { lookup } from 'node:dns/promises';

type GatewayWebSocketData = {
  host: string;
  labId: string;
  origin: string;
};

type HttpObservation = {
  host: string;
  labId: string;
  method: string;
  origin: string;
  pathname: string;
  preflightObserved: boolean;
};

type TransportObservation = {
  error?: string;
  observedHost?: string;
  observedLabId?: string;
  observedOrigin?: string;
  pass: boolean;
  url: string;
};

type EndpointObservation = {
  addresses: string[];
  http: TransportObservation;
  websocketAttempts: TransportObservation[];
};

type DownstreamState = {
  connectTimeout: ReturnType<typeof setTimeout>;
  pending: Uint8Array[];
  pendingBytes: number;
  upstream?: Socket<UpstreamState>;
};

type UpstreamState = {
  downstream: Socket<DownstreamState>;
};

const TIMEOUT_MS = 5_000;
const FORWARDER_MAX_PENDING_BYTES = 65_536;

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = process.argv[index + 1];
  if (index === -1 || value === undefined || value.startsWith('--')) {
    throw new Error(`routing proof runtime: missing --${name}`);
  }
  return value;
}

function argumentNumber(name: string): number {
  const value = Number(argument(name));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`routing proof runtime: --${name} must be a TCP port`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = 'cause' in error ? error.cause : undefined;
  return cause === undefined ? error.message : `${error.message}; cause=${JSON.stringify(cause)}`;
}

function browserPage(): Response {
  return new Response('<!doctype html><html><head><meta charset="utf-8"><title>Enbox Lab routing proof</title></head><body>routing proof</body></html>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function serviceWorker(): Response {
  const source = `
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'probe' || typeof event.data.url !== 'string') return;
  event.waitUntil((async () => {
    try {
      const response = await fetch(event.data.url, { headers: { 'x-enbox-proof': 'service-worker' } });
      const body = await response.json();
      event.source?.postMessage({ id: event.data.id, ok: response.ok, body });
    } catch (error) {
      event.source?.postMessage({ id: event.data.id, ok: false, error: String(error) });
    }
  })());
});
`;
  return new Response(source, {
    headers: {
      'cache-control'          : 'no-store',
      'content-type'           : 'text/javascript; charset=utf-8',
      'service-worker-allowed' : '/',
    },
  });
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    'access-control-allow-headers' : 'content-type,x-enbox-proof',
    'access-control-allow-methods' : 'GET,OPTIONS',
    'access-control-max-age'       : '0',
    'cache-control'                : 'no-store',
    'vary'                         : 'origin',
  });
  const origin = request.headers.get('origin');
  if (origin !== null) {
    headers.set('access-control-allow-origin', origin);
  }
  return headers;
}

function startGateway(): void {
  const allowedHosts = new Set(argument('allowed-hosts').split(','));
  const allowedOrigins = new Set(argument('allowed-origins').split(','));
  const labId = argument('lab-id');
  const port = argumentNumber('port');
  const preflights = new Set<string>();

  const server = Bun.serve<GatewayWebSocketData>({
    fetch(request, bunServer): Response | undefined {
      const host = request.headers.get('host') ?? '';
      if (!allowedHosts.has(host)) {
        return new Response('host is outside this lab', { status: 421 });
      }
      const origin = request.headers.get('origin') ?? '';
      if (origin !== '' && !allowedOrigins.has(origin)) {
        return new Response('origin is outside this lab', { status: 403 });
      }

      const url = new URL(request.url);
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const upgraded = bunServer.upgrade(request, {
          data: {
            host,
            labId,
            origin,
          },
        });
        return upgraded ? undefined : new Response('upgrade failed', { status: 400 });
      }

      const headers = corsHeaders(request);
      if (request.method === 'OPTIONS') {
        preflights.add(`${request.headers.get('origin') ?? ''}|${host}`);
        return new Response(null, { headers, status: 204 });
      }
      if (request.method !== 'GET') {
        return new Response('method not allowed', { headers, status: 405 });
      }
      if (url.pathname === '/browser') {
        return browserPage();
      }
      if (url.pathname === '/sw.js') {
        return serviceWorker();
      }
      if (url.pathname !== '/health' && url.pathname !== '/probe') {
        return new Response('route not found', { headers, status: 404 });
      }

      const observation: HttpObservation = {
        host,
        labId,
        method            : request.method,
        origin,
        pathname          : url.pathname,
        preflightObserved : preflights.has(`${request.headers.get('origin') ?? ''}|${host}`),
      };
      headers.set('content-type', 'application/json');
      return new Response(JSON.stringify(observation), { headers });
    },
    hostname  : '0.0.0.0',
    port,
    websocket : {
      message(webSocket, message): void {
        webSocket.send(JSON.stringify({
          host    : webSocket.data.host,
          labId   : webSocket.data.labId,
          origin  : webSocket.data.origin,
          payload : typeof message === 'string' ? message : new TextDecoder().decode(message),
          type    : 'echo',
        }));
      },
      open(webSocket): void {
        webSocket.send(JSON.stringify({
          host   : webSocket.data.host,
          labId  : webSocket.data.labId,
          origin : webSocket.data.origin,
          type   : 'open',
        }));
      },
    },
  });

  console.log(JSON.stringify({ labId, mode: 'gateway', port: server.port }));
}

function startLoopbackForwarder(
  hostname: string,
  port: number,
  gatewayHost: string,
  gatewayPort: number,
): TCPSocketListener<DownstreamState> {
  return Bun.listen<DownstreamState>({
    hostname,
    port,
    socket: {
      close(downstream): void {
        clearTimeout(downstream.data.connectTimeout);
        downstream.data.upstream?.end();
      },
      data(downstream, data): void {
        const upstream = downstream.data.upstream;
        if (upstream === undefined) {
          if (downstream.data.pendingBytes + data.byteLength > FORWARDER_MAX_PENDING_BYTES) {
            downstream.end();
            return;
          }
          downstream.data.pending.push(Uint8Array.from(data));
          downstream.data.pendingBytes += data.byteLength;
        } else {
          const written = upstream.write(data);
          if (written < data.byteLength) {
            upstream.end();
            downstream.end();
          }
        }
      },
      error(downstream): void {
        clearTimeout(downstream.data.connectTimeout);
        downstream.data.upstream?.end();
      },
      open(downstream): void {
        const connectTimeout = setTimeout((): void => { downstream.end(); }, TIMEOUT_MS);
        downstream.data = { connectTimeout, pending: [], pendingBytes: 0 };
        void Bun.connect<UpstreamState>({
          data     : { downstream },
          hostname : gatewayHost,
          port     : gatewayPort,
          socket   : {
            close(upstream): void {
              clearTimeout(upstream.data.downstream.data.connectTimeout);
              upstream.data.downstream.end();
            },
            data(upstream, data): void {
              const written = upstream.data.downstream.write(data);
              if (written < data.byteLength) {
                upstream.end();
                upstream.data.downstream.end();
              }
            },
            error(upstream): void {
              clearTimeout(upstream.data.downstream.data.connectTimeout);
              upstream.data.downstream.end();
            },
            open(upstream): void {
              clearTimeout(downstream.data.connectTimeout);
              downstream.data.upstream = upstream;
              for (const pending of downstream.data.pending) {
                const written = upstream.write(pending);
                if (written < pending.byteLength) {
                  upstream.end();
                  downstream.end();
                  return;
                }
              }
              downstream.data.pending = [];
              downstream.data.pendingBytes = 0;
            },
          },
        }).catch((): void => {
          downstream.end();
        });
      },
    },
  });
}

async function httpProbe(baseUrl: string, expectedLabId: string, expectedOrigin?: string): Promise<TransportObservation> {
  const url = `${baseUrl}/probe?source=bun`;
  try {
    const response = await fetch(url, {
      headers : { 'x-enbox-proof': 'bun-runtime' },
      signal  : AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json() as HttpObservation;
    const originMatches = expectedOrigin === undefined
      ? body.origin === '' || body.origin === baseUrl
      : body.origin === expectedOrigin;
    return {
      observedHost   : body.host,
      observedLabId  : body.labId,
      observedOrigin : body.origin,
      pass           : response.ok && body.labId === expectedLabId && body.host === new URL(baseUrl).host && originMatches,
      url,
    };
  } catch (error) {
    return { error: errorMessage(error), pass: false, url };
  }
}

async function webSocketProbe(baseUrl: string, expectedLabId: string, expectedOrigin?: string): Promise<TransportObservation> {
  const url = `${baseUrl.replace(/^http:/, 'ws:')}/socket`;
  const token = crypto.randomUUID();

  return new Promise((resolve): void => {
    const socket = new WebSocket(url);
    let settled = false;
    const timeout = setTimeout((): void => {
      finish({ error: `timed out after ${TIMEOUT_MS}ms`, pass: false, url });
    }, TIMEOUT_MS);

    function finish(observation: TransportObservation): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.close();
      resolve(observation);
    }

    socket.addEventListener('error', (): void => {
      finish({ error: 'WebSocket connection failed', pass: false, url });
    });
    socket.addEventListener('message', (event): void => {
      try {
        const message = JSON.parse(String(event.data)) as {
          host?: string;
          labId?: string;
          origin?: string;
          payload?: string;
          type?: string;
        };
        if (message.type === 'open') {
          socket.send(token);
          return;
        }
        if (message.type === 'echo') {
          const originMatches = expectedOrigin === undefined
            ? message.origin === '' || message.origin === baseUrl
            : message.origin === expectedOrigin;
          finish({
            observedHost   : message.host,
            observedLabId  : message.labId,
            observedOrigin : message.origin,
            pass           : message.labId === expectedLabId && message.host === new URL(baseUrl).host &&
              originMatches && message.payload === token,
            url,
          });
        }
      } catch (error) {
        finish({ error: errorMessage(error), pass: false, url });
      }
    });
  });
}

async function endpointProbe(baseUrl: string, expectedLabId: string): Promise<EndpointObservation> {
  let addresses: string[] = [];
  try {
    addresses = (await lookup(new URL(baseUrl).hostname, { all: true })).map((entry): string => `${entry.family}:${entry.address}`);
  } catch (error) {
    addresses = [`lookup-error:${errorMessage(error)}`];
  }

  return {
    addresses,
    http              : await httpProbe(baseUrl, expectedLabId),
    websocketAttempts : [
      await webSocketProbe(baseUrl, expectedLabId),
      await webSocketProbe(baseUrl, expectedLabId),
    ],
  };
}

async function runActor(): Promise<void> {
  const aliasHost = argument('alias-host');
  const gatewayHost = argument('gateway-host');
  const gatewayPort = argumentNumber('gateway-port');
  const labId = argument('lab-id');
  const port = argumentNumber('port');
  const ipv4Forwarder = startLoopbackForwarder('127.0.0.1', port, gatewayHost, gatewayPort);
  const ipv6Forwarder = startLoopbackForwarder('::1', port, gatewayHost, gatewayPort);

  try {
    const aliasUrl = `http://${aliasHost}:${port}`;
    const ipv4LoopbackUrl = `http://127.0.0.1:${port}`;
    const ipv6LoopbackUrl = `http://[::1]:${port}`;
    const localhostUrl = `http://localhost:${port}`;
    console.log(JSON.stringify({
      alias     : await endpointProbe(aliasUrl, labId),
      forwarder : {
        bind   : `127.0.0.1:${port},[::1]:${port}`,
        target : `${gatewayHost}:${gatewayPort}`,
      },
      ipv4Loopback : await httpProbe(ipv4LoopbackUrl, labId),
      ipv6Loopback : await httpProbe(ipv6LoopbackUrl, labId),
      localhost    : await endpointProbe(localhostUrl, labId),
      runtime      : {
        architecture : process.arch,
        bun          : Bun.version,
        platform     : process.platform,
      },
    }));
  } finally {
    ipv4Forwarder.stop(true);
    ipv6Forwarder.stop(true);
  }
}

async function runReachability(): Promise<void> {
  const url = argument('url');
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    console.log(JSON.stringify({ reachable: true, status: response.status, url }));
  } catch (error) {
    console.log(JSON.stringify({ error: errorMessage(error), reachable: false, url }));
  }
}

function hold(): void {
  console.log(JSON.stringify({ mode: 'hold' }));
  setInterval((): void => {}, 60_000);
}

async function run(): Promise<void> {
  const mode = process.argv[2];
  switch (mode) {
    case 'actor':
      await runActor();
      break;
    case 'gateway':
      startGateway();
      break;
    case 'hold':
      hold();
      break;
    case 'reachability':
      await runReachability();
      break;
    default:
      throw new Error(`routing proof runtime: unsupported mode '${mode ?? ''}'`);
  }
}

await run();
