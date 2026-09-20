import type { Server } from 'bun';
import type { Browser, Page } from 'playwright';
import type { LabCheck, LabCheckStatus, LabProofReport } from '../../proof-result.js';

import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { chromium } from 'playwright';

import { createProofReport } from '../../proof-result.js';

type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type RoutingProofDependencies = {
  allocatePort?: () => Promise<number>;
  browserExecutablePath?: string;
  now?: () => Date;
  randomUuid?: () => string;
  runCommand?: (command: string[], cwd?: string) => Promise<CommandResult>;
  workspaceRoot?: string;
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

type ActorObservation = {
  alias: EndpointObservation;
  forwarder: {
    bind: string;
    target: string;
  };
  ipv4Loopback: TransportObservation;
  ipv6Loopback: TransportObservation;
  localhost: EndpointObservation;
  runtime: {
    architecture: string;
    bun: string;
    platform: string;
  };
};

type ReachabilityObservation = {
  error?: string;
  reachable: boolean;
  status?: number;
  url: string;
};

type BrowserObservation = {
  browserName?: string;
  browserVersion?: string;
  error?: string;
  executablePath?: string;
  page?: {
    host: string;
    labId: string;
    origin: string;
    preflightObserved: boolean;
  };
  popupOrigin?: string;
  secureContext?: boolean;
  serviceWorker?: {
    controlled: boolean;
    host: string;
    labId: string;
    origin: string;
    preflightObserved: boolean;
  };
  status: LabCheckStatus;
  websocketAttempts?: TransportObservation[];
};

type LabFixture = {
  actorAlias: string;
  actorContainerName: string;
  appAlias: string;
  appPort: number;
  gatewayContainerId: string;
  gatewayContainerName: string;
  gatewayNetworkAlias: string;
  ingressNetworkName: string;
  labId: string;
  networkName: string;
  ownerId: string;
  port: number;
  volumeName: string;
  walletAlias: string;
  walletPort: number;
};

type PortSentinel = {
  mode: 'created' | 'pre-existing';
  stop: () => void;
  token?: string;
};

const ACTOR_LABEL = 'org.enbox.lab.actor-id';
const DISPLAY_LABEL = 'org.enbox.lab.display-name';
const LAB_LABEL = 'org.enbox.lab.lab-id';
const OWNER_LABEL = 'org.enbox.lab.ownership-id';
const PROOF_LABEL = 'org.enbox.lab.proof-run-id';
const PROOF_DISPLAY_NAME = 'Routing Proof Lab';
const PROOF_IMAGE_BASE = 'enbox-lab-routing-proof';
const TIMEOUT_MS = 5_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultRunCommand(command: string[], cwd?: string): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd,
    stderr : 'pipe',
    stdout : 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
}

async function expectCommand(
  runner: NonNullable<RoutingProofDependencies['runCommand']>,
  command: string[],
  cwd?: string,
): Promise<CommandResult> {
  const result = await runner(command, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`${command.slice(0, 3).join(' ')} failed (${result.exitCode}): ${result.stderr || result.stdout || 'no output'}`);
  }
  return result;
}

function lastJsonLine<T>(output: string): T {
  const lines = output.split('\n').map((line): string => line.trim()).filter(Boolean);
  const line = lines.at(-1);
  if (line === undefined) {
    throw new Error('command returned no JSON output');
  }
  return JSON.parse(line) as T;
}

function token(value: string): string {
  return value.replaceAll('-', '').slice(0, 12).toLowerCase();
}

function labelArguments(runId: string, fixture: Pick<LabFixture, 'labId' | 'ownerId'>, actorId: string): string[] {
  return [
    '--label', `${ACTOR_LABEL}=${actorId}`,
    '--label', `${DISPLAY_LABEL}=${PROOF_DISPLAY_NAME}`,
    '--label', `${LAB_LABEL}=${fixture.labId}`,
    '--label', `${OWNER_LABEL}=${fixture.ownerId}`,
    '--label', `${PROOF_LABEL}=${runId}`,
  ];
}

function endpointPassed(observation: EndpointObservation): boolean {
  return observation.http.pass && observation.websocketAttempts.length >= 2 &&
    observation.websocketAttempts.every((attempt): boolean => attempt.pass);
}

function endpointDetails(observation: EndpointObservation): Record<string, boolean | number | string> {
  return {
    addresses         : JSON.stringify(observation.addresses),
    http              : observation.http.pass,
    httpError         : observation.http.error ?? '',
    observedHost      : observation.http.observedHost ?? '',
    observedLabId     : observation.http.observedLabId ?? '',
    observedOrigin    : observation.http.observedOrigin ?? '',
    websocketAttempts : JSON.stringify(observation.websocketAttempts),
  };
}

async function allocateLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 30_000 + Math.floor(Math.random() * 20_000);
    try {
      const server = Bun.serve({
        fetch    : (): Response => new Response('port allocation sentinel'),
        hostname : '127.0.0.1',
        port,
      });
      server.stop(true);
      return port;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !error.message.includes('port')) {
        throw error;
      }
    }
  }
  throw new Error('Unable to allocate an unused loopback port after 20 attempts');
}

async function allocateDistinctPorts(count: number, allocatePort: () => Promise<number>): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) {
    ports.add(await allocatePort());
  }
  return [...ports];
}

async function tcpReachable(port: number): Promise<boolean> {
  return new Promise((resolveReachability): void => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const timeout = setTimeout((): void => {
      socket.destroy();
      resolveReachability(false);
    }, 1_000);
    socket.once('connect', (): void => {
      clearTimeout(timeout);
      socket.destroy();
      resolveReachability(true);
    });
    socket.once('error', (): void => {
      clearTimeout(timeout);
      resolveReachability(false);
    });
  });
}

async function startConventionalPortSentinel(): Promise<PortSentinel> {
  const tokenValue = crypto.randomUUID();
  let server: Server<undefined>;
  try {
    server = Bun.serve({
      fetch    : (): Response => Response.json({ token: tokenValue }),
      hostname : '127.0.0.1',
      port     : 3_000,
    });
  } catch (error) {
    if (await tcpReachable(3_000)) {
      return { mode: 'pre-existing', stop: (): void => {} };
    }
    throw error;
  }

  return {
    mode  : 'created',
    stop  : (): void => { void server.stop(true); },
    token : tokenValue,
  };
}

async function verifyPortSentinel(sentinel: PortSentinel): Promise<boolean> {
  if (sentinel.mode === 'pre-existing') {
    return tcpReachable(3_000);
  }

  try {
    const response = await fetch('http://127.0.0.1:3000', { signal: AbortSignal.timeout(1_000) });
    const body = await response.json() as { token?: string };
    return response.ok && body.token === sentinel.token;
  } catch {
    return false;
  }
}

async function httpProbe(baseUrl: string, expectedLabId: string, expectedOrigin?: string): Promise<TransportObservation> {
  const url = `${baseUrl}/probe?source=host`;
  try {
    const response = await fetch(url, {
      headers : { 'x-enbox-proof': 'host-bun-runtime' },
      signal  : AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json() as { host?: string; labId?: string; origin?: string };
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
  const probeToken = crypto.randomUUID();

  return new Promise((resolveObservation): void => {
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
      resolveObservation(observation);
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
          socket.send(probeToken);
        } else if (message.type === 'echo') {
          const originMatches = expectedOrigin === undefined
            ? message.origin === '' || message.origin === baseUrl
            : message.origin === expectedOrigin;
          finish({
            observedHost   : message.host,
            observedLabId  : message.labId,
            observedOrigin : message.origin,
            pass           : message.labId === expectedLabId && message.host === new URL(baseUrl).host &&
              originMatches && message.payload === probeToken,
            url,
          });
        }
      } catch (error) {
        finish({ error: errorMessage(error), pass: false, url });
      }
    });
  });
}

async function hostEndpointProbe(baseUrl: string, expectedLabId: string): Promise<EndpointObservation> {
  const { lookup } = await import('node:dns/promises');
  let addresses: string[];
  try {
    addresses = (await lookup(new URL(baseUrl).hostname, { all: true })).map((entry): string => `${entry.family}:${entry.address}`);
  } catch (error) {
    addresses = [`lookup-error:${errorMessage(error)}`];
  }

  return {
    addresses,
    http              : await httpProbe(baseUrl, expectedLabId),
    websocketAttempts : [await webSocketProbe(baseUrl, expectedLabId), await webSocketProbe(baseUrl, expectedLabId)],
  };
}

async function rejectsForeignOrigin(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/probe?source=foreign-origin`, {
      headers : { Origin: 'http://localhost:1' },
      signal  : AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.status === 403;
  } catch {
    return false;
  }
}

function findBrowserExecutable(explicitPath?: string): string | undefined {
  const candidates = [
    explicitPath,
    process.env.ENBOX_LAB_CHROMIUM_PATH,
    chromium.executablePath(),
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  return candidates.find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
}

async function pageWebSocketProbe(
  page: Page,
  baseUrl: string,
  expectedLabId: string,
  expectedOrigin: string,
): Promise<TransportObservation> {
  return page.evaluate(async ({ baseUrl: evaluatedBaseUrl, expectedLabId: evaluatedLabId, expectedOrigin: evaluatedOrigin, timeoutMs }) => {
    const url = `${evaluatedBaseUrl.replace(/^http:/, 'ws:')}/socket`;
    const probeToken = crypto.randomUUID();
    return new Promise((resolveObservation): void => {
      const socket = new WebSocket(url);
      let settled = false;
      const timeout = setTimeout((): void => {
        finish({ error: `timed out after ${timeoutMs}ms`, pass: false, url });
      }, timeoutMs);
      function finish(observation: TransportObservation): void {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.close();
        resolveObservation(observation);
      }
      socket.addEventListener('error', (): void => finish({ error: 'WebSocket connection failed', pass: false, url }));
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
            socket.send(probeToken);
          } else if (message.type === 'echo') {
            finish({
              observedHost   : message.host,
              observedLabId  : message.labId,
              observedOrigin : message.origin,
              pass           : message.labId === evaluatedLabId && message.host === new URL(evaluatedBaseUrl).host &&
                message.origin === evaluatedOrigin && message.payload === probeToken,
              url,
            });
          }
        } catch (error) {
          finish({ error: String(error), pass: false, url });
        }
      });
    });
  }, { baseUrl, expectedLabId, expectedOrigin, timeoutMs: TIMEOUT_MS });
}

async function browserNetworkProbe(fixture: LabFixture, executablePath?: string): Promise<BrowserObservation> {
  const selectedExecutable = findBrowserExecutable(executablePath);
  if (selectedExecutable === undefined) {
    return {
      status : 'unsupported',
      error  : 'No managed or system Chromium executable was found',
    };
  }

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: selectedExecutable, headless: true });
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    const appBaseUrl = `http://${fixture.appAlias}:${fixture.appPort}`;
    const targetBaseUrl = `http://${fixture.actorAlias}:${fixture.port}`;
    const walletBaseUrl = `http://${fixture.walletAlias}:${fixture.walletPort}`;
    await page.goto(`${appBaseUrl}/browser`, { waitUntil: 'domcontentloaded' });

    const pageAndWorker = await page.evaluate(async ({ targetBaseUrl: evaluatedTarget, timeoutMs }) => {
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller === null) {
        await new Promise<void>((resolveControl, rejectControl): void => {
          const timeout = setTimeout((): void => rejectControl(new Error('service worker did not take control')), timeoutMs);
          navigator.serviceWorker.addEventListener('controllerchange', (): void => {
            clearTimeout(timeout);
            resolveControl();
          }, { once: true });
        });
      }

      const pageResponse = await fetch(`${evaluatedTarget}/probe?source=browser-page`, {
        headers: { 'x-enbox-proof': 'browser-page' },
      });
      const pageBody = await pageResponse.json() as {
        host: string;
        labId: string;
        origin: string;
        preflightObserved: boolean;
      };

      const id = crypto.randomUUID();
      const workerResult = await new Promise<{
        body?: { host: string; labId: string; origin: string; preflightObserved: boolean };
        error?: string;
        ok: boolean;
      }>((resolveWorker, rejectWorker): void => {
        const timeout = setTimeout((): void => rejectWorker(new Error('service worker probe timed out')), timeoutMs);
        navigator.serviceWorker.addEventListener('message', (event): void => {
          if (event.data?.id === id) {
            clearTimeout(timeout);
            resolveWorker(event.data);
          }
        });
        (navigator.serviceWorker.controller ?? registration.active)?.postMessage({
          id,
          type : 'probe',
          url  : `${evaluatedTarget}/probe?source=service-worker`,
        });
      });

      return {
        page          : pageBody,
        secureContext : window.isSecureContext,
        serviceWorker : {
          controlled        : navigator.serviceWorker.controller !== null,
          host              : workerResult.body?.host ?? '',
          labId             : workerResult.body?.labId ?? '',
          origin            : workerResult.body?.origin ?? '',
          preflightObserved : workerResult.body?.preflightObserved ?? false,
        },
      };
    }, { targetBaseUrl, timeoutMs: TIMEOUT_MS });

    const popupPromise = page.waitForEvent('popup');
    await page.evaluate((url): void => {
      window.open(url, 'enbox-routing-proof-popup');
    }, `${walletBaseUrl}/browser?popup=1`);
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    const popupOrigin = await popup.evaluate((): string => location.origin);
    await popup.close();

    const websocketAttempts = [
      await pageWebSocketProbe(page, targetBaseUrl, fixture.labId, appBaseUrl),
      await pageWebSocketProbe(page, targetBaseUrl, fixture.labId, appBaseUrl),
    ];
    const pass = pageAndWorker.secureContext && pageAndWorker.page.labId === fixture.labId &&
      pageAndWorker.page.host === `${fixture.actorAlias}:${fixture.port}` && pageAndWorker.page.origin === appBaseUrl &&
      pageAndWorker.page.preflightObserved &&
      pageAndWorker.serviceWorker.controlled && pageAndWorker.serviceWorker.labId === fixture.labId &&
      pageAndWorker.serviceWorker.host === `${fixture.actorAlias}:${fixture.port}` &&
      pageAndWorker.serviceWorker.origin === appBaseUrl && pageAndWorker.serviceWorker.preflightObserved && popupOrigin === walletBaseUrl &&
      websocketAttempts.every((attempt): boolean => attempt.pass);

    return {
      browserName    : chromium.name(),
      browserVersion : browser.version(),
      executablePath : selectedExecutable,
      page           : pageAndWorker.page,
      popupOrigin,
      secureContext  : pageAndWorker.secureContext,
      serviceWorker  : pageAndWorker.serviceWorker,
      status         : pass ? 'pass' : 'fail',
      websocketAttempts,
    };
  } catch (error) {
    return {
      error          : errorMessage(error),
      executablePath : selectedExecutable,
      status         : 'fail',
    };
  } finally {
    await browser?.close();
  }
}

function workspaceRootFrom(start: string): string {
  let directory = resolve(start);
  while (true) {
    const packageJson = resolve(directory, 'package.json');
    if (existsSync(packageJson)) {
      try {
        const value = JSON.parse(readFileSync(packageJson, 'utf8')) as { name?: string; workspaces?: unknown };
        if (value.name === 'enbox' && Array.isArray(value.workspaces)) {
          return directory;
        }
      } catch {
        // Continue toward the filesystem root.
      }
    }
    const parent = resolve(directory, '..');
    if (parent === directory) {
      throw new Error(`Unable to find the Enbox workspace above ${start}`);
    }
    directory = parent;
  }
}

async function createLabFixture(params: {
  appPort: number;
  image: string;
  index: string;
  ownerId: string;
  port: number;
  runId: string;
  runner: NonNullable<RoutingProofDependencies['runCommand']>;
  walletPort: number;
}): Promise<LabFixture> {
  const fixtureToken = token(crypto.randomUUID());
  const labId = `lab-${params.index}-${fixtureToken}`;
  const baseName = `enbox-routing-${token(params.runId)}-${params.index}`;
  const actorAlias = 'localhost';
  const appAlias = 'localhost';
  const walletAlias = 'localhost';
  const partial = { labId, ownerId: params.ownerId };
  const networkName = `${baseName}-network`;
  const ingressNetworkName = `${baseName}-ingress`;
  const volumeName = `${baseName}-data`;
  const gatewayContainerName = `${baseName}-gateway`;
  const actorContainerName = `${baseName}-actor`;
  const gatewayNetworkAlias = `${baseName}-gateway.internal`;

  await expectCommand(params.runner, [
    'docker', 'network', 'create', '--internal',
    ...labelArguments(params.runId, partial, 'network'),
    networkName,
  ]);
  await expectCommand(params.runner, [
    'docker', 'network', 'create',
    ...labelArguments(params.runId, partial, 'ingress-network'),
    ingressNetworkName,
  ]);
  await expectCommand(params.runner, [
    'docker', 'volume', 'create',
    ...labelArguments(params.runId, partial, 'gateway-data'),
    volumeName,
  ]);
  const gateway = await expectCommand(params.runner, [
    'docker', 'run', '--detach',
    '--name', gatewayContainerName,
    '--network', ingressNetworkName,
    '--publish', `127.0.0.1:${params.port}:${params.port}`,
    '--publish', `127.0.0.1:${params.appPort}:${params.port}`,
    '--publish', `127.0.0.1:${params.walletPort}:${params.port}`,
    '--mount', `type=volume,source=${volumeName},target=/state`,
    ...labelArguments(params.runId, partial, 'gateway'),
    params.image,
    'gateway',
    '--allowed-hosts', [
      `localhost:${params.port}`,
      `localhost:${params.appPort}`,
      `localhost:${params.walletPort}`,
      `127.0.0.1:${params.port}`,
      `[::1]:${params.port}`,
    ].join(','),
    '--allowed-origins', [params.port, params.appPort, params.walletPort]
      .map((actorPort): string => `http://localhost:${actorPort}`).join(','),
    '--lab-id', labId,
    '--port', String(params.port),
  ]);
  await expectCommand(params.runner, [
    'docker', 'network', 'connect',
    '--alias', gatewayNetworkAlias,
    networkName,
    gatewayContainerName,
  ]);

  return {
    actorAlias,
    actorContainerName,
    appAlias,
    appPort            : params.appPort,
    gatewayContainerId : gateway.stdout,
    gatewayContainerName,
    gatewayNetworkAlias,
    ingressNetworkName,
    labId,
    networkName,
    ownerId            : params.ownerId,
    port               : params.port,
    volumeName,
    walletAlias,
    walletPort         : params.walletPort,
  };
}

async function waitForGateway(fixture: LabFixture): Promise<void> {
  const url = `http://127.0.0.1:${fixture.port}/health`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return;
      }
    } catch {
      // The container may still be starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`gateway ${fixture.gatewayContainerName} did not become ready at ${url}`);
}

async function runActorProbe(
  runner: NonNullable<RoutingProofDependencies['runCommand']>,
  runId: string,
  image: string,
  fixture: LabFixture,
): Promise<ActorObservation> {
  const command = await expectCommand(runner, [
    'docker', 'run',
    '--name', fixture.actorContainerName,
    '--network', fixture.networkName,
    ...labelArguments(runId, fixture, 'bun-actor'),
    image,
    'actor',
    '--alias-host', fixture.actorAlias,
    '--gateway-host', fixture.gatewayNetworkAlias,
    '--gateway-port', String(fixture.port),
    '--lab-id', fixture.labId,
    '--port', String(fixture.port),
  ]);
  return lastJsonLine<ActorObservation>(command.stdout);
}

async function runReachabilityProbe(params: {
  actorId: string;
  containerName: string;
  fixture: LabFixture;
  image: string;
  runId: string;
  runner: NonNullable<RoutingProofDependencies['runCommand']>;
  url: string;
}): Promise<ReachabilityObservation> {
  const command = await expectCommand(params.runner, [
    'docker', 'run',
    '--name', params.containerName,
    '--network', params.fixture.networkName,
    ...labelArguments(params.runId, params.fixture, params.actorId),
    params.image,
    'reachability', '--url', params.url,
  ]);
  return lastJsonLine<ReachabilityObservation>(command.stdout);
}

async function filteredResourceNames(
  runner: NonNullable<RoutingProofDependencies['runCommand']>,
  type: 'container' | 'network' | 'volume',
  label: string,
): Promise<string[]> {
  const command = type === 'container'
    ? ['docker', 'ps', '--all', '--quiet', '--filter', `label=${label}`]
    : ['docker', type, 'ls', '--quiet', '--filter', `label=${label}`];
  const result = await expectCommand(runner, command);
  return result.stdout.split('\n').map((entry): string => entry.trim()).filter(Boolean);
}

async function removeOwnedResources(
  runner: NonNullable<RoutingProofDependencies['runCommand']>,
  ownerId: string,
): Promise<{ containers: string[]; networks: string[]; volumes: string[] }> {
  const ownershipLabel = `${OWNER_LABEL}=${ownerId}`;
  const containers = await filteredResourceNames(runner, 'container', ownershipLabel);
  const networks = await filteredResourceNames(runner, 'network', ownershipLabel);
  const volumes = await filteredResourceNames(runner, 'volume', ownershipLabel);
  if (containers.length > 0) {
    await expectCommand(runner, ['docker', 'rm', '--force', ...containers]);
  }
  if (networks.length > 0) {
    await expectCommand(runner, ['docker', 'network', 'rm', ...networks]);
  }
  if (volumes.length > 0) {
    await expectCommand(runner, ['docker', 'volume', 'rm', ...volumes]);
  }
  return { containers, networks, volumes };
}

async function existsInDocker(
  runner: NonNullable<RoutingProofDependencies['runCommand']>,
  type: 'container' | 'network' | 'volume',
  name: string,
): Promise<boolean> {
  const command = type === 'container'
    ? ['docker', 'inspect', name]
    : ['docker', type, 'inspect', name];
  return (await runner(command)).exitCode === 0;
}

async function cleanupExact(
  runner: NonNullable<RoutingProofDependencies['runCommand']>,
  resources: {
    containers: string[];
    image?: string;
    networks: string[];
    volumes: string[];
  },
): Promise<string[]> {
  const errors: string[] = [];
  const commands = [
    ...resources.containers.map((name): string[] => ['docker', 'rm', '--force', name]),
    ...resources.networks.map((name): string[] => ['docker', 'network', 'rm', name]),
    ...resources.volumes.map((name): string[] => ['docker', 'volume', 'rm', name]),
    ...(resources.image === undefined ? [] : [['docker', 'image', 'rm', resources.image]]),
  ];
  for (const command of commands) {
    const result = await runner(command);
    if (result.exitCode !== 0 && !/No such|not found|does not exist/i.test(result.stderr)) {
      errors.push(`${command.slice(0, 4).join(' ')}: ${result.stderr || result.stdout}`);
    }
  }
  return errors;
}

function browserCheck(observation: BrowserObservation): LabCheck {
  return {
    details: {
      browserName       : observation.browserName ?? '',
      browserVersion    : observation.browserVersion ?? '',
      error             : observation.error ?? '',
      executablePath    : observation.executablePath ?? '',
      page              : JSON.stringify(observation.page ?? {}),
      popupOrigin       : observation.popupOrigin ?? '',
      secureContext     : observation.secureContext ?? false,
      serviceWorker     : JSON.stringify(observation.serviceWorker ?? {}),
      websocketAttempts : JSON.stringify(observation.websocketAttempts ?? []),
    },
    id      : 'A02-browser-policy',
    status  : observation.status,
    summary : observation.status === 'pass'
      ? 'Chromium used the canonical origins for CORS, service-worker, popup and WebSocket traffic'
      : observation.status === 'unsupported'
        ? 'Chromium routing proof is unsupported on this host'
        : 'Chromium could not complete the canonical-origin routing proof',
  };
}

/**
 * Runs the P0 addressing and ownership spike against isolated Docker resources.
 * Every created resource has a random proof identity and cleanup targets exact names or ownership labels.
 */
export async function runRoutingProof(dependencies: RoutingProofDependencies = {}): Promise<LabProofReport> {
  const now = dependencies.now ?? ((): Date => new Date());
  const startedAt = now();
  const randomUuid = dependencies.randomUuid ?? ((): string => crypto.randomUUID());
  const runner = dependencies.runCommand ?? defaultRunCommand;
  const allocatePort = dependencies.allocatePort ?? allocateLoopbackPort;
  const workspaceRoot = dependencies.workspaceRoot ?? workspaceRootFrom(process.cwd());
  const runId = randomUuid();
  const runToken = token(runId);
  const image = `${PROOF_IMAGE_BASE}:${runToken}`;
  const ownerA = randomUuid();
  const ownerB = randomUuid();
  const sentinelContainer = `enbox-routing-${runToken}-unmanaged`;
  const sentinelVolume = `enbox-routing-${runToken}-unmanaged-data`;
  const checks: LabCheck[] = [];
  const cleanupResources = {
    containers : [sentinelContainer],
    image,
    networks   : [] as string[],
    volumes    : [sentinelVolume],
  };
  let sentinel: PortSentinel | undefined;
  let fixtureA: LabFixture | undefined;
  let fixtureB: LabFixture | undefined;

  const dockerVersion = await runner(['docker', 'version', '--format', '{{json .}}']);
  if (dockerVersion.exitCode !== 0) {
    return createProofReport({
      checks: [{
        details : { error: dockerVersion.stderr || dockerVersion.stdout },
        id      : 'A04-docker-engine',
        status  : 'unsupported',
        summary : 'Docker Engine is unavailable, so container routing and ownership were not exercised',
      }],
      finishedAt : now(),
      proof      : 'p0-addressing-ownership',
      startedAt,
    });
  }

  try {
    sentinel = await startConventionalPortSentinel();
    const baseImage = process.env.ENBOX_LAB_PROOF_BUN_IMAGE
      ?? 'oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4';
    const dockerfile = resolve(workspaceRoot, 'packages/lab/src/proofs/routing/Dockerfile');
    await expectCommand(runner, [
      'docker', 'build',
      '--build-arg', `BUN_IMAGE=${baseImage}`,
      '--file', dockerfile,
      '--label', `${PROOF_LABEL}=${runId}`,
      '--tag', image,
      workspaceRoot,
    ], workspaceRoot);
    const imageInspection = lastJsonLine<{
      Architecture?: string;
      Id?: string;
      Os?: string;
      RepoDigests?: string[];
    }>((await expectCommand(runner, ['docker', 'image', 'inspect', image, '--format', '{{json .}}'])).stdout);

    await expectCommand(runner, [
      'docker', 'volume', 'create',
      '--label', `${DISPLAY_LABEL}=${PROOF_DISPLAY_NAME}`,
      '--label', `${PROOF_LABEL}=${runId}`,
      sentinelVolume,
    ]);
    await expectCommand(runner, [
      'docker', 'run', '--detach',
      '--name', sentinelContainer,
      '--network', 'none',
      '--label', `${DISPLAY_LABEL}=${PROOF_DISPLAY_NAME}`,
      '--label', `${PROOF_LABEL}=${runId}`,
      image, 'hold',
    ]);

    const [portA, appPortA, walletPortA, portB, appPortB, walletPortB] = await allocateDistinctPorts(6, allocatePort);
    fixtureA = await createLabFixture({
      appPort: appPortA, image, index: 'a', ownerId: ownerA, port: portA, runId, runner, walletPort: walletPortA,
    });
    fixtureB = await createLabFixture({
      appPort: appPortB, image, index: 'b', ownerId: ownerB, port: portB, runId, runner, walletPort: walletPortB,
    });
    cleanupResources.containers.push(
      fixtureA.gatewayContainerName, fixtureA.actorContainerName,
      fixtureB.gatewayContainerName, fixtureB.actorContainerName,
    );
    cleanupResources.networks.push(
      fixtureA.networkName, fixtureA.ingressNetworkName,
      fixtureB.networkName, fixtureB.ingressNetworkName,
    );
    cleanupResources.volumes.push(fixtureA.volumeName, fixtureB.volumeName);
    await Promise.all([waitForGateway(fixtureA), waitForGateway(fixtureB)]);

    const canonicalUrl = `http://${fixtureA.actorAlias}:${fixtureA.port}`;
    const [hostObservation, actorObservation, browserObservation, foreignOriginRejected] = await Promise.all([
      hostEndpointProbe(canonicalUrl, fixtureA.labId),
      runActorProbe(runner, runId, image, fixtureA),
      browserNetworkProbe(fixtureA, dependencies.browserExecutablePath),
      rejectsForeignOrigin(canonicalUrl),
    ]);
    const actorBObservation = await runActorProbe(runner, runId, image, fixtureB);

    checks.push({
      details : endpointDetails(hostObservation),
      id      : 'A01-host-canonical-url',
      status  : endpointPassed(hostObservation) ? 'pass' : 'fail',
      summary : endpointPassed(hostObservation)
        ? 'Host Bun used the actor localhost URL for HTTP and two WebSocket connections'
        : 'Host Bun could not use the actor localhost URL for HTTP and WebSocket traffic',
    });
    checks.push({
      details: {
        ...endpointDetails(actorObservation.alias),
        forwarder        : JSON.stringify(actorObservation.forwarder),
        ipv4Loopback     : JSON.stringify(actorObservation.ipv4Loopback),
        ipv6Loopback     : JSON.stringify(actorObservation.ipv6Loopback),
        localhostControl : JSON.stringify(actorObservation.localhost),
        runtime          : JSON.stringify(actorObservation.runtime),
      },
      id     : 'A01-container-canonical-url',
      status : endpointPassed(actorObservation.alias) && endpointPassed(actorObservation.localhost) &&
        actorObservation.ipv4Loopback.pass && actorObservation.ipv6Loopback.pass ? 'pass' : 'fail',
      summary: endpointPassed(actorObservation.alias) && endpointPassed(actorObservation.localhost) &&
        actorObservation.ipv4Loopback.pass && actorObservation.ipv6Loopback.pass
        ? 'Container Bun used the identical actor localhost URL through its loopback forwarder'
        : 'Container Bun could not use the canonical URL through its loopback forwarder',
    });
    checks.push(browserCheck(browserObservation));
    checks.push({
      details : { foreignOrigin: 'http://localhost:1' },
      id      : 'A02-origin-enforcement',
      status  : foreignOriginRejected ? 'pass' : 'fail',
      summary : foreignOriginRejected
        ? 'The gateway rejected a request from an origin outside the actor allowlist'
        : 'The gateway admitted or failed to classify a foreign origin',
    });

    const crossContainer = `enbox-routing-${runToken}-cross-a`;
    const externalContainer = `enbox-routing-${runToken}-external-a`;
    cleanupResources.containers.push(crossContainer, externalContainer);
    const [crossLab, publicEgress] = await Promise.all([
      runReachabilityProbe({
        actorId       : 'cross-lab-probe',
        containerName : crossContainer,
        fixture       : fixtureA,
        image,
        runId,
        runner,
        url           : `http://${fixtureB.gatewayNetworkAlias}:${fixtureB.port}/health`,
      }),
      runReachabilityProbe({
        actorId       : 'external-egress-probe',
        containerName : externalContainer,
        fixture       : fixtureA,
        image,
        runId,
        runner,
        url           : 'https://example.com/',
      }),
    ]);
    checks.push({
      details: {
        crossLab     : JSON.stringify(crossLab),
        publicEgress : JSON.stringify(publicEgress),
      },
      id      : 'A03-actor-network-egress-subcheck',
      status  : !crossLab.reachable && !publicEgress.reachable ? 'pass' : 'fail',
      summary : !crossLab.reachable && !publicEgress.reachable
        ? 'The internal lab network could reach its gateway but not another lab or the public network'
        : 'The lab actor reached a forbidden cross-lab or public target',
    });
    checks.push({
      id      : 'A03-host-default-and-did-miss-containment',
      status  : 'unsupported',
      summary : 'Host-default targets, redirect escape and fresh DID miss containment still require the integrated runtime proof',
    });

    const ownerAContainers = await filteredResourceNames(runner, 'container', `${OWNER_LABEL}=${ownerA}`);
    const ownerANetworks = await filteredResourceNames(runner, 'network', `${OWNER_LABEL}=${ownerA}`);
    const ownerAVolumes = await filteredResourceNames(runner, 'volume', `${OWNER_LABEL}=${ownerA}`);
    const ownerBContainers = await filteredResourceNames(runner, 'container', `${OWNER_LABEL}=${ownerB}`);
    const ownershipLabelsPass = ownerAContainers.length === 4 && ownerANetworks.length === 2 && ownerAVolumes.length === 1 &&
      ownerBContainers.length === 2 && await existsInDocker(runner, 'container', sentinelContainer) &&
      await existsInDocker(runner, 'volume', sentinelVolume);
    checks.push({
      details: {
        displayName      : PROOF_DISPLAY_NAME,
        ownerA           : ownerA,
        ownerAContainers : JSON.stringify(ownerAContainers),
        ownerANetworks   : JSON.stringify(ownerANetworks),
        ownerAVolumes    : JSON.stringify(ownerAVolumes),
        ownerB           : ownerB,
        ownerBContainers : JSON.stringify(ownerBContainers),
      },
      id      : 'A05-ownership-labels',
      status  : ownershipLabelsPass ? 'pass' : 'fail',
      summary : ownershipLabelsPass
        ? 'Identically named labs and unmanaged sentinels had distinct ownership selections'
        : 'Ownership labels did not select the expected isolated resources',
    });

    const removedA = await removeOwnedResources(runner, ownerA);
    const [labAExists, labBExists, unmanagedContainerExists, unmanagedVolumeExists] = await Promise.all([
      existsInDocker(runner, 'container', fixtureA.gatewayContainerName),
      existsInDocker(runner, 'container', fixtureB.gatewayContainerName),
      existsInDocker(runner, 'container', sentinelContainer),
      existsInDocker(runner, 'volume', sentinelVolume),
    ]);
    const postDeleteB = await hostEndpointProbe(`http://${fixtureB.actorAlias}:${fixtureB.port}`, fixtureB.labId);
    const portSentinelAlive = await verifyPortSentinel(sentinel);
    const cleanupPass = !labAExists && labBExists && unmanagedContainerExists && unmanagedVolumeExists &&
      endpointPassed(postDeleteB) && portSentinelAlive;
    checks.push({
      details: {
        labAExists,
        labBExists,
        port3000Mode   : sentinel.mode,
        portSentinelAlive,
        postDeleteLabB : JSON.stringify(postDeleteB),
        removedA       : JSON.stringify(removedA),
        unmanagedContainerExists,
        unmanagedVolumeExists,
      },
      id      : 'A05-owned-cleanup',
      status  : cleanupPass ? 'pass' : 'fail',
      summary : cleanupPass
        ? 'Deleting lab A preserved lab B, explicit unmanaged sentinels and occupied port 3000'
        : 'Deleting lab A affected another resource or left owned resources running',
    });

    checks.push({
      details: {
        baseImage,
        dockerVersion       : dockerVersion.stdout,
        imageArchitecture   : imageInspection.Architecture ?? '',
        imageId             : imageInspection.Id ?? '',
        imageOs             : imageInspection.Os ?? '',
        imageRepoDigests    : JSON.stringify(imageInspection.RepoDigests ?? []),
        runtimeArchitecture : process.arch,
        runtimePlatform     : process.platform,
      },
      id      : 'A04-current-platform',
      status  : ['linux', 'darwin'].includes(process.platform) && ['arm64', 'x64'].includes(process.arch) ? 'pass' : 'unsupported',
      summary : `Recorded Docker, Bun and image identity on ${process.platform}/${process.arch}`,
    });
    checks.push({
      details : { currentPlatform: process.platform, requiredPlatform: 'darwin' },
      id      : 'A04-macos-evidence',
      status  : process.platform === 'darwin' ? 'pass' : 'unsupported',
      summary : process.platform === 'darwin'
        ? 'The routing proof ran natively on macOS'
        : 'Native macOS evidence must be collected on a macOS runner',
    });

    const addressFamilies = new Set([
      ...hostObservation.addresses,
      ...actorObservation.alias.addresses,
      ...actorBObservation.alias.addresses,
    ].map((address): string => address.split(':', 1)[0]));
    checks.push({
      details: {
        actorAAddresses  : JSON.stringify(actorObservation.alias.addresses),
        actorBAddresses  : JSON.stringify(actorBObservation.alias.addresses),
        hostAddresses    : JSON.stringify(hostObservation.addresses),
        selectedFamilies : JSON.stringify([...addressFamilies]),
      },
      id      : 'A01-address-family-observation',
      status  : addressFamilies.has('4') && addressFamilies.has('6') ? 'pass' : 'fail',
      summary : addressFamilies.has('4') && addressFamilies.has('6')
        ? 'Actor runtimes resolved and exercised both IPv4 and IPv6 loopback paths'
        : 'Both loopback address families were not observed',
    });
  } catch (error) {
    const gatewayDiagnostics: Record<string, string> = {};
    for (const fixture of [fixtureA, fixtureB]) {
      if (fixture !== undefined) {
        const logs = await runner(['docker', 'logs', fixture.gatewayContainerName]);
        gatewayDiagnostics[fixture.gatewayContainerName] = logs.stderr || logs.stdout;
      }
    }
    checks.push({
      details: {
        error              : errorMessage(error),
        gatewayDiagnostics : JSON.stringify(gatewayDiagnostics),
      },
      id      : 'routing-proof-execution',
      status  : 'fail',
      summary : 'The addressing and ownership proof stopped before completing all observations',
    });
  } finally {
    sentinel?.stop();
    const proofLabel = `${PROOF_LABEL}=${runId}`;
    const [runContainers, runNetworks, runVolumes] = await Promise.all([
      filteredResourceNames(runner, 'container', proofLabel).catch((): string[] => []),
      filteredResourceNames(runner, 'network', proofLabel).catch((): string[] => []),
      filteredResourceNames(runner, 'volume', proofLabel).catch((): string[] => []),
    ]);
    cleanupResources.containers.push(...runContainers);
    cleanupResources.networks.push(...runNetworks);
    cleanupResources.volumes.push(...runVolumes);
    cleanupResources.containers = [...new Set(cleanupResources.containers)];
    cleanupResources.networks = [...new Set(cleanupResources.networks)];
    cleanupResources.volumes = [...new Set(cleanupResources.volumes)];
    const cleanupErrors = await cleanupExact(runner, cleanupResources);
    checks.push({
      details : { errors: JSON.stringify(cleanupErrors), resourcePrefix: `enbox-routing-${runToken}` },
      id      : 'proof-resource-cleanup',
      status  : cleanupErrors.length === 0 ? 'pass' : 'fail',
      summary : cleanupErrors.length === 0
        ? 'The proof removed only its exact generated resources'
        : 'One or more generated proof resources could not be removed',
    });
  }

  return createProofReport({
    checks,
    finishedAt : now(),
    proof      : 'p0-addressing-ownership',
    startedAt,
  });
}

export const routingProofInternals = {
  endpointPassed,
  labelArguments,
};
