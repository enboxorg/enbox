/**
 * Browser local-node discovery and pairing helpers.
 *
 * The browser SDK never silently sweeps localhost during startup. A stored
 * pairing is revalidated passively; explicit probing/pairing is exposed for
 * user-gesture flows such as "Use local node".
 *
 * @see https://github.com/enboxorg/enbox/issues/1165
 * @module
 */

import type { EnboxUserAgent } from '@enbox/agent';
import type { DwnRpcAuthOptions, ServerInfo } from '@enbox/dwn-clients';

import type { AuthEventEmitter } from './events.js';
import type { StorageAdapter } from './types.js';

import { EnboxRpcClient } from '@enbox/dwn-clients';
import { localDwnPortCandidates, localDwnServerName, normalizeBaseUrl } from '@enbox/agent';

import { STORAGE_KEYS } from './types.js';

type FetchLike = typeof fetch;

export type LocalDwnPairingRecord = {
  version: 1;
  endpoint: string;
  token: string;
  pairedOrigin: string;
  localNodeId?: string;
  createdAt: number;
};

export type LocalDwnUnsupportedReason = 'no-fetch' | 'insecure-context' | 'safari';

export type LocalDwnProbeResult =
  | { status: 'unsupported'; reason: LocalDwnUnsupportedReason }
  | { status: 'not-found' }
  | { status: 'found-unpaired'; endpoint: string; serverInfo: ServerInfo }
  | { status: 'paired'; endpoint: string; pairing: LocalDwnPairingRecord; serverInfo: ServerInfo };

export type ProbeLocalDwnOptions = {
  fetch?: FetchLike;
  hostname?: string;
  origin?: string;
  portCandidates?: readonly number[];
  scanPorts?: boolean;
  storage?: StorageAdapter;
};

export type LocalDwnPairingInitiateResult =
  | { status: 'pending'; endpoint: string; requestId: string; pollUrl: string; serverInfo: ServerInfo }
  | { status: 'rate-limited'; retryAfterSec: number };

export type LocalDwnPairingPollResult =
  | { status: 'pending'; origin: string }
  | { status: 'approved'; origin: string; token?: string }
  | { status: 'denied'; origin: string }
  | { status: 'expired'; origin: string };

export type InitiateLocalDwnPairingOptions = {
  endpoint: string;
  fetch?: FetchLike;
  origin?: string;
  serverInfo?: ServerInfo;
};

export type PollLocalDwnPairingOptions = {
  endpoint: string;
  fetch?: FetchLike;
  origin?: string;
  pollUrl: string;
};

export type RequestLocalDwnPairingOptions = {
  endpoint?: string;
  fetch?: FetchLike;
  hostname?: string;
  origin?: string;
  portCandidates?: readonly number[];
  pollIntervalMs?: number;
  scanPorts?: boolean;
  storage: StorageAdapter;
  timeoutMs?: number;
};

export type LocalDwnPairingRequestResult =
  | { status: 'paired'; endpoint: string; pairing: LocalDwnPairingRecord; serverInfo: ServerInfo }
  | { status: 'unsupported'; reason: LocalDwnUnsupportedReason }
  | { status: 'not-found' }
  | { status: 'rate-limited'; retryAfterSec: number }
  | { status: 'denied'; endpoint: string; origin: string }
  | { status: 'expired'; endpoint: string; origin: string }
  | { status: 'timeout'; endpoint: string; requestId: string; pollUrl: string };

const localDwnPairingRecordVersion = 1;
const defaultPairingTimeoutMs = 5 * 60 * 1000;
const defaultPairingPollIntervalMs = 1500;

/**
 * Creates a DWN RPC client that attaches the pairing token only when requests
 * target the paired local-node endpoint.
 */
export function createLocalDwnRpcClient(pairing: LocalDwnPairingRecord): EnboxRpcClient {
  const auth: DwnRpcAuthOptions = {
    getBearerToken: (dwnUrl: string): string | undefined => {
      return isSameEndpoint(dwnUrl, pairing.endpoint) ? pairing.token : undefined;
    },
  };

  return new EnboxRpcClient([], { auth });
}

/** Reads and validates the persisted local-node pairing record. */
export async function readLocalDwnPairingRecord(
  storage: StorageAdapter,
): Promise<LocalDwnPairingRecord | undefined> {
  const raw = await storage.get(STORAGE_KEYS.LOCAL_DWN_ENDPOINT);
  if (raw === null) {
    return undefined;
  }

  const record = parseLocalDwnPairingRecord(raw);
  if (record === undefined) {
    await clearLocalDwnEndpoint(storage);
  }

  return record;
}

/** Persists the versioned local-node pairing record. */
export async function persistLocalDwnPairingRecord(
  storage: StorageAdapter,
  record: LocalDwnPairingRecord,
): Promise<void> {
  await storage.set(STORAGE_KEYS.LOCAL_DWN_ENDPOINT, JSON.stringify({
    ...record,
    endpoint : normalizeBaseUrl(record.endpoint),
    version  : localDwnPairingRecordVersion,
  }));
}

/**
 * Clear the persisted local DWN pairing from auth storage.
 *
 * The storage key retains its historical name so existing installs can be
 * migrated by clearing legacy endpoint-only values.
 */
export async function clearLocalDwnEndpoint(
  storage: StorageAdapter,
): Promise<void> {
  await storage.remove(STORAGE_KEYS.LOCAL_DWN_ENDPOINT);
}

/**
 * Revalidates a stored pairing without sweeping localhost ports.
 *
 * @returns The pairing record when the local node confirms the token,
 *   otherwise `undefined`. Stale or legacy values are cleared.
 */
export async function discoverLocalDwnPairing(
  storage: StorageAdapter,
  fetchOption?: FetchLike,
): Promise<LocalDwnPairingRecord | undefined> {
  const pairing = await readLocalDwnPairingRecord(storage);
  if (pairing === undefined) {
    return undefined;
  }

  const fetchFn = getFetch(fetchOption);
  if (fetchFn === undefined) {
    return undefined;
  }

  const serverInfo = await fetchLocalDwnServerInfo(pairing.endpoint, fetchFn);
  const isPaired = serverInfo !== undefined
    && serverInfo.localNode === true
    && await fetchLocalDwnStatus(pairing, fetchFn);

  if (!isPaired) {
    await clearLocalDwnEndpoint(storage);
    return undefined;
  }

  return pairing;
}

/**
 * Backwards-compatible endpoint getter used by existing AuthManager boot code.
 * New code should use {@link discoverLocalDwnPairing} so the token travels with
 * the endpoint.
 */
export async function discoverLocalDwn(
  storage: StorageAdapter,
): Promise<string | undefined> {
  return (await discoverLocalDwnPairing(storage))?.endpoint;
}

/**
 * Restore a previously paired local DWN endpoint and inject it into the agent's
 * discovery cache. Legacy endpoint-only values are cleared.
 */
export async function restoreLocalDwnEndpoint(
  agent: EnboxUserAgent,
  storage: StorageAdapter,
): Promise<boolean> {
  const pairing = await readLocalDwnPairingRecord(storage);
  if (pairing === undefined) {
    return false;
  }

  const accepted = await agent.dwn.setCachedLocalDwnEndpoint(pairing.endpoint);
  if (!accepted) {
    await clearLocalDwnEndpoint(storage);
    return false;
  }

  return true;
}

/**
 * Reapply a stored local-node pairing to a running agent.
 *
 * Browser pairing is explicit via {@link probeLocalDwn},
 * {@link initiateLocalDwnPairing}, and {@link requestLocalDwnPairing}.
 */
export async function applyLocalDwnDiscovery(
  agent: EnboxUserAgent,
  storage: StorageAdapter,
  emitter?: AuthEventEmitter,
): Promise<boolean> {
  const restored = await restoreLocalDwnEndpoint(agent, storage);

  if (restored) {
    const pairing = await readLocalDwnPairingRecord(storage);
    if (pairing !== undefined) {
      emitter?.emit('local-dwn-available', { endpoint: pairing.endpoint, paired: true });
    }
  } else {
    emitter?.emit('local-dwn-unavailable', {});
  }

  return restored;
}

/**
 * Explicitly probe localhost for a local-node profile. This should be called
 * only from a user gesture unless a stored pairing exists.
 */
export async function probeLocalDwn(options: ProbeLocalDwnOptions = {}): Promise<LocalDwnProbeResult> {
  const fetchFn = getFetch(options.fetch);
  if (fetchFn === undefined) {
    return { reason: 'no-fetch', status: 'unsupported' };
  }

  const storedPairing = options.storage === undefined
    ? undefined
    : await readLocalDwnPairingRecord(options.storage);
  if (storedPairing !== undefined) {
    const serverInfo = await fetchLocalDwnServerInfo(storedPairing.endpoint, fetchFn);
    if (serverInfo !== undefined && await fetchLocalDwnStatus(storedPairing, fetchFn, options.origin)) {
      return {
        endpoint : storedPairing.endpoint,
        pairing  : storedPairing,
        serverInfo,
        status   : 'paired',
      };
    }
    await options.storage?.remove(STORAGE_KEYS.LOCAL_DWN_ENDPOINT);
  }

  const unsupportedReason = getUnsupportedReason();
  if (unsupportedReason !== undefined) {
    return { reason: unsupportedReason, status: 'unsupported' };
  }

  if (options.scanPorts === false) {
    return { status: 'not-found' };
  }

  const hostname = options.hostname ?? '127.0.0.1';
  const portCandidates = options.portCandidates ?? localDwnPortCandidates;
  for (const port of portCandidates) {
    const endpoint = `http://${hostname}:${port}`;
    const serverInfo = await fetchLocalDwnServerInfo(endpoint, fetchFn);
    if (serverInfo?.localNode === true) {
      return {
        endpoint : normalizeBaseUrl(endpoint),
        serverInfo,
        status   : 'found-unpaired',
      };
    }
  }

  return { status: 'not-found' };
}

/** Initiates a local-node pairing request and returns the poll URL. */
export async function initiateLocalDwnPairing(
  options: InitiateLocalDwnPairingOptions,
): Promise<LocalDwnPairingInitiateResult> {
  const fetchFn = requireFetch(options.fetch);
  const endpoint = normalizeBaseUrl(options.endpoint);
  const serverInfo = options.serverInfo ?? await requireLocalDwnServerInfo(endpoint, fetchFn);
  const pairUrl = serverInfo.localPairing?.pairUrl ?? endpointUrl(endpoint, '/local/pair');

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  attachOriginHeader(headers, options.origin);

  const response = await fetchFn(pairUrl, {
    body   : '{}',
    headers,
    method : 'POST',
  });

  if (response.status === 429) {
    return {
      retryAfterSec : Number.parseInt(response.headers.get('retry-after') ?? '1', 10),
      status        : 'rate-limited',
    };
  }

  if (!response.ok) {
    throw new Error(`LocalDwnDiscovery: pairing request failed with HTTP ${response.status}.`);
  }

  const body = await response.json() as { requestId?: unknown; status?: unknown };
  if (typeof body.requestId !== 'string' || body.status !== 'pending') {
    throw new Error('LocalDwnDiscovery: malformed pairing response.');
  }

  return {
    endpoint,
    pollUrl   : pollUrlForRequest(serverInfo, endpoint, body.requestId),
    requestId : body.requestId,
    serverInfo,
    status    : 'pending',
  };
}

/** Polls a local-node pairing request once. */
export async function pollLocalDwnPairing(
  options: PollLocalDwnPairingOptions,
): Promise<LocalDwnPairingPollResult> {
  const fetchFn = requireFetch(options.fetch);
  const headers: Record<string, string> = {};
  attachOriginHeader(headers, options.origin);

  const response = await fetchFn(options.pollUrl, { headers, method: 'GET' });
  if (!response.ok) {
    throw new Error(`LocalDwnDiscovery: pairing poll failed with HTTP ${response.status}.`);
  }

  const body = await response.json() as LocalDwnPairingPollResult;
  if (!isPairingPollResult(body)) {
    throw new Error('LocalDwnDiscovery: malformed pairing poll response.');
  }

  return body;
}

/**
 * Runs probe + pairing initiation + polling until the local node returns a
 * token or a terminal status is reached.
 */
export async function requestLocalDwnPairing(
  options: RequestLocalDwnPairingOptions,
): Promise<LocalDwnPairingRequestResult> {
  const fetchFn = getFetch(options.fetch);
  if (fetchFn === undefined) {
    return { reason: 'no-fetch', status: 'unsupported' };
  }

  const probe = options.endpoint === undefined
    ? await probeLocalDwn({ ...options, fetch: fetchFn })
    : await probeEndpointForPairing(options.endpoint, fetchFn);

  if (probe.status === 'unsupported' || probe.status === 'not-found') {
    return probe;
  }

  if (probe.status === 'paired') {
    return probe;
  }

  const initiated = await initiateLocalDwnPairing({
    endpoint   : probe.endpoint,
    fetch      : fetchFn,
    origin     : options.origin,
    serverInfo : probe.serverInfo,
  });
  if (initiated.status === 'rate-limited') {
    return initiated;
  }

  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? defaultPairingTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? defaultPairingPollIntervalMs;

  while (Date.now() - startedAt <= timeoutMs) {
    const pollResult = await pollLocalDwnPairing({
      endpoint : initiated.endpoint,
      fetch    : fetchFn,
      origin   : options.origin,
      pollUrl  : initiated.pollUrl,
    });

    if (pollResult.status === 'pending') {
      await sleep(pollIntervalMs);
      continue;
    }

    if (pollResult.status === 'approved') {
      if (pollResult.token === undefined) {
        throw new Error('LocalDwnDiscovery: approved pairing did not include a token.');
      }

      const pairing: LocalDwnPairingRecord = {
        createdAt    : Date.now(),
        endpoint     : initiated.endpoint,
        pairedOrigin : pollResult.origin,
        token        : pollResult.token,
        version      : localDwnPairingRecordVersion,
      };
      await persistLocalDwnPairingRecord(options.storage, pairing);

      return {
        endpoint   : initiated.endpoint,
        pairing,
        serverInfo : initiated.serverInfo,
        status     : 'paired',
      };
    }

    return {
      endpoint : initiated.endpoint,
      origin   : pollResult.origin,
      status   : pollResult.status,
    };
  }

  return {
    endpoint  : initiated.endpoint,
    pollUrl   : initiated.pollUrl,
    requestId : initiated.requestId,
    status    : 'timeout',
  };
}

function parseLocalDwnPairingRecord(raw: string): LocalDwnPairingRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LocalDwnPairingRecord>;
    if (
      value.version !== localDwnPairingRecordVersion
      || typeof value.endpoint !== 'string'
      || typeof value.token !== 'string'
      || typeof value.pairedOrigin !== 'string'
      || typeof value.createdAt !== 'number'
      || (value.localNodeId !== undefined && typeof value.localNodeId !== 'string')
    ) {
      return undefined;
    }

    return {
      createdAt    : value.createdAt,
      endpoint     : normalizeBaseUrl(value.endpoint),
      pairedOrigin : value.pairedOrigin,
      token        : value.token,
      version      : localDwnPairingRecordVersion,
      ...(value.localNodeId === undefined ? {} : { localNodeId: value.localNodeId }),
    };
  } catch {
    return undefined;
  }
}

async function fetchLocalDwnServerInfo(endpoint: string, fetchFn: FetchLike): Promise<ServerInfo | undefined> {
  try {
    const response = await fetchFn(endpointUrl(endpoint, '/info'), { method: 'GET' });
    if (!response.ok) {
      return undefined;
    }

    const serverInfo = await response.json() as ServerInfo;
    return serverInfo.server === localDwnServerName ? serverInfo : undefined;
  } catch {
    return undefined;
  }
}

async function requireLocalDwnServerInfo(endpoint: string, fetchFn: FetchLike): Promise<ServerInfo> {
  const serverInfo = await fetchLocalDwnServerInfo(endpoint, fetchFn);
  if (serverInfo?.localNode !== true) {
    throw new Error('LocalDwnDiscovery: endpoint is not an Enbox local node.');
  }

  return serverInfo;
}

async function fetchLocalDwnStatus(
  pairing: LocalDwnPairingRecord,
  fetchFn: FetchLike,
  origin?: string,
): Promise<boolean> {
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${pairing.token}` };
    attachOriginHeader(headers, origin);

    const response = await fetchFn(endpointUrl(pairing.endpoint, '/local/status'), {
      headers,
      method: 'GET',
    });
    if (!response.ok) {
      return false;
    }

    const body = await response.json() as { localNode?: unknown; paired?: unknown };
    return body.localNode === true && body.paired === true;
  } catch {
    return false;
  }
}

async function probeEndpointForPairing(endpoint: string, fetchFn: FetchLike): Promise<Extract<LocalDwnProbeResult, { status: 'found-unpaired' }> | { status: 'not-found' }> {
  const normalizedEndpoint = normalizeBaseUrl(endpoint);
  const serverInfo = await fetchLocalDwnServerInfo(normalizedEndpoint, fetchFn);
  if (serverInfo?.localNode !== true) {
    return { status: 'not-found' };
  }

  return {
    endpoint : normalizedEndpoint,
    serverInfo,
    status   : 'found-unpaired',
  };
}

function getFetch(fetchOption?: FetchLike): FetchLike | undefined {
  if (fetchOption !== undefined) {
    return fetchOption;
  }

  return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
}

function requireFetch(fetchOption?: FetchLike): FetchLike {
  const fetchFn = getFetch(fetchOption);
  if (fetchFn === undefined) {
    throw new Error('LocalDwnDiscovery: fetch is not available.');
  }

  return fetchFn;
}

function getUnsupportedReason(): LocalDwnUnsupportedReason | undefined {
  if (isBrowserLike() && globalThis.isSecureContext === false) {
    return 'insecure-context';
  }

  if (isSafari()) {
    return 'safari';
  }

  return undefined;
}

function isBrowserLike(): boolean {
  return globalThis.location !== undefined && globalThis.navigator !== undefined;
}

function isSafari(): boolean {
  const userAgent = globalThis.navigator?.userAgent;
  if (typeof userAgent !== 'string') {
    return false;
  }

  return /\bSafari\//.test(userAgent) && !/\b(Chrome|Chromium|CriOS|FxiOS|Firefox|Edg)\//.test(userAgent);
}

function endpointUrl(endpoint: string, path: string): string {
  const base = new URL(`${normalizeBaseUrl(endpoint)}/`);
  return new URL(path.replace(/^\//, ''), base).toString();
}

function pollUrlForRequest(serverInfo: ServerInfo, endpoint: string, requestId: string): string {
  const template = serverInfo.localPairing?.pollUrlTemplate;
  if (template !== undefined) {
    return template.replace('{requestId}', encodeURIComponent(requestId));
  }

  return endpointUrl(endpoint, `/local/pair/${encodeURIComponent(requestId)}`);
}

function attachOriginHeader(headers: Record<string, string>, origin?: string): void {
  if (origin !== undefined) {
    headers.origin = origin;
  }
}

function isPairingPollResult(value: LocalDwnPairingPollResult): boolean {
  if (value === null || typeof value !== 'object' || typeof value.status !== 'string' || typeof value.origin !== 'string') {
    return false;
  }

  if (value.status === 'pending' || value.status === 'denied' || value.status === 'expired') {
    return true;
  }

  return value.status === 'approved' && (value.token === undefined || typeof value.token === 'string');
}

function isSameEndpoint(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableEndpoint(left);
  const normalizedRight = normalizeComparableEndpoint(right);

  return normalizedLeft !== undefined && normalizedRight !== undefined && normalizedLeft === normalizedRight;
}

function normalizeComparableEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') {
      url.protocol = 'http:';
    } else if (url.protocol === 'wss:') {
      url.protocol = 'https:';
    }
    url.hash = '';
    url.search = '';
    return normalizeBaseUrl(url.toString());
  } catch {
    return undefined;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, ms);
  });
}
