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
import type { ReplicationApplyResult } from '@enbox/dwn-sdk-js';
import type {
  DidRpcRequest,
  DidRpcResponse,
  DwnReplicationApplyRequest,
  DwnRpcAuthOptions,
  DwnRpcRequest,
  DwnRpcResponse,
  EnboxRpc,
  ServerInfo,
} from '@enbox/dwn-clients';

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

export type LocalDwnEjectionRecord = {
  version: 1;
  endpoint: string;
  completedAt: number;
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
const localDwnEjectionRecordVersion = 1;
const defaultPairingTimeoutMs = 5 * 60 * 1000;
const defaultPairingPollIntervalMs = 1500;

type LocalDwnPairingValidation =
  | { status: 'paired'; serverInfo: ServerInfo }
  | { status: 'revoked' }
  | { status: 'unavailable' };

type LocalDwnServerInfoResult =
  | { status: 'found'; serverInfo: ServerInfo }
  | { status: 'invalid' }
  | { status: 'unavailable' };

/**
 * Routes paired-endpoint traffic through an authenticated client while
 * preserving the caller's existing transports for every other endpoint.
 */
class LocalDwnAuthenticatedRpcClient implements EnboxRpc {
  private readonly _authenticatedClient: EnboxRpc;
  private readonly _fallbackClient: EnboxRpc;
  private readonly _pairing: LocalDwnPairingRecord;

  public constructor(pairing: LocalDwnPairingRecord, fallbackClient: EnboxRpc) {
    const auth: DwnRpcAuthOptions = {
      getBearerToken: (dwnUrl: string): string | undefined => {
        return isSameEndpoint(dwnUrl, pairing.endpoint) ? pairing.token : undefined;
      },
    };

    this._authenticatedClient = new EnboxRpcClient([], { auth });
    this._fallbackClient = fallbackClient instanceof LocalDwnAuthenticatedRpcClient
      ? fallbackClient._fallbackClient
      : fallbackClient;
    this._pairing = pairing;
  }

  public get transportProtocols(): string[] {
    return [...new Set([
      ...this._authenticatedClient.transportProtocols,
      ...this._fallbackClient.transportProtocols,
    ])];
  }

  public matchesPairing(pairing: LocalDwnPairingRecord): boolean {
    return pairing.token === this._pairing.token
      && isSameEndpoint(pairing.endpoint, this._pairing.endpoint);
  }

  public async close(): Promise<void> {
    await Promise.all([
      this._authenticatedClient.close(),
      this._fallbackClient.close(),
    ]);
  }

  public sendDidRequest(request: DidRpcRequest): Promise<DidRpcResponse> {
    return this._fallbackClient.sendDidRequest(request);
  }

  public sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {
    return this.clientFor(request.dwnUrl).sendDwnRequest(request);
  }

  public applyReplicatedMessage(request: DwnReplicationApplyRequest): Promise<ReplicationApplyResult> {
    return this.clientFor(request.dwnUrl).applyReplicatedMessage(request);
  }

  public getServerInfo(dwnUrl: string): Promise<ServerInfo> {
    return this.clientFor(dwnUrl).getServerInfo(dwnUrl);
  }

  private clientFor(dwnUrl: string): EnboxRpc {
    return isSameEndpoint(dwnUrl, this._pairing.endpoint)
      ? this._authenticatedClient
      : this._fallbackClient;
  }
}

/**
 * Creates a DWN RPC client that attaches the pairing token only when requests
 * target the paired local-node endpoint. When a fallback client is supplied,
 * its custom transports and non-local endpoint behavior are preserved.
 */
export function createLocalDwnRpcClient(pairing: LocalDwnPairingRecord, fallbackClient?: EnboxRpc): EnboxRpc {
  if (
    fallbackClient instanceof LocalDwnAuthenticatedRpcClient
    && fallbackClient.matchesPairing(pairing)
  ) {
    return fallbackClient;
  }

  const auth: DwnRpcAuthOptions = {
    getBearerToken: (dwnUrl: string): string | undefined => {
      return isSameEndpoint(dwnUrl, pairing.endpoint) ? pairing.token : undefined;
    },
  };

  return fallbackClient === undefined
    ? new EnboxRpcClient([], { auth })
    : new LocalDwnAuthenticatedRpcClient(pairing, fallbackClient);
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

/** Reads and validates the persisted local-node ejection marker. */
export async function readLocalDwnEjectionRecord(
  storage: StorageAdapter,
): Promise<LocalDwnEjectionRecord | undefined> {
  const raw = await storage.get(STORAGE_KEYS.LOCAL_DWN_EJECTION);
  if (raw === null) {
    return undefined;
  }

  const record = parseLocalDwnEjectionRecord(raw);
  if (record === undefined) {
    await clearLocalDwnEjection(storage);
  }

  return record;
}

/** Persists the marker that allows the next session to boot against the local node. */
export async function persistLocalDwnEjectionRecord(
  storage: StorageAdapter,
  record: LocalDwnEjectionRecord,
): Promise<void> {
  await storage.set(STORAGE_KEYS.LOCAL_DWN_EJECTION, JSON.stringify({
    ...record,
    endpoint : normalizeBaseUrl(record.endpoint),
    version  : localDwnEjectionRecordVersion,
  }));
}

/** Clears the local-node ejection marker while leaving the pairing intact. */
export async function clearLocalDwnEjection(
  storage: StorageAdapter,
): Promise<void> {
  await storage.remove(STORAGE_KEYS.LOCAL_DWN_EJECTION);
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
  await Promise.all([
    storage.remove(STORAGE_KEYS.LOCAL_DWN_ENDPOINT),
    clearLocalDwnEjection(storage),
  ]);
}

/**
 * Returns the persisted ejection marker only when it belongs to the validated
 * pairing endpoint. Mismatched markers are stale and are cleared.
 */
export async function readLocalDwnEjectionRecordForPairing(
  storage: StorageAdapter,
  pairing: LocalDwnPairingRecord,
): Promise<LocalDwnEjectionRecord | undefined> {
  const ejection = await readLocalDwnEjectionRecord(storage);
  if (ejection === undefined) {
    return undefined;
  }

  if (!isSameEndpoint(ejection.endpoint, pairing.endpoint)) {
    await clearLocalDwnEjection(storage);
    return undefined;
  }

  return ejection;
}

/**
 * Returns the validated pairing only when a successful drain/ejection marker
 * exists for the same endpoint.
 */
export async function discoverEjectedLocalDwnPairing(
  storage: StorageAdapter,
  fetchOption?: FetchLike,
): Promise<LocalDwnPairingRecord | undefined> {
  const pairing = await discoverLocalDwnPairing(storage, fetchOption);
  if (pairing === undefined) {
    await clearLocalDwnEjection(storage);
    return undefined;
  }

  const ejection = await readLocalDwnEjectionRecordForPairing(storage, pairing);
  if (ejection === undefined) {
    return undefined;
  }

  return pairing;
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
    await clearLocalDwnEjection(storage);
    return undefined;
  }

  const validation = await validateLocalDwnPairing(pairing, fetchFn);
  if (validation.status === 'revoked') {
    await clearLocalDwnEndpoint(storage);
    return undefined;
  }

  if (validation.status === 'unavailable') {
    await clearLocalDwnEjection(storage);
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
  const storage = options.storage;
  const fetchFn = getFetch(options.fetch);
  if (fetchFn === undefined) {
    if (storage !== undefined) {
      await clearLocalDwnEjection(storage);
    }
    return { reason: 'no-fetch', status: 'unsupported' };
  }

  const storedPairing = storage === undefined
    ? undefined
    : await readLocalDwnPairingRecord(storage);
  if (storedPairing !== undefined && storage !== undefined) {
    const validation = await validateLocalDwnPairing(storedPairing, fetchFn, options.origin);
    if (validation.status === 'paired') {
      return {
        endpoint   : storedPairing.endpoint,
        pairing    : storedPairing,
        serverInfo : validation.serverInfo,
        status     : 'paired',
      };
    }

    if (validation.status === 'unavailable') {
      await clearLocalDwnEjection(storage);
      return { status: 'not-found' };
    }

    await clearLocalDwnEndpoint(storage);
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

function parseLocalDwnEjectionRecord(raw: string): LocalDwnEjectionRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LocalDwnEjectionRecord>;
    if (
      value.version !== localDwnEjectionRecordVersion
      || typeof value.endpoint !== 'string'
      || typeof value.completedAt !== 'number'
      || !Number.isFinite(value.completedAt)
    ) {
      return undefined;
    }

    return {
      completedAt : value.completedAt,
      endpoint    : normalizeBaseUrl(value.endpoint),
      version     : localDwnEjectionRecordVersion,
    };
  } catch {
    return undefined;
  }
}

async function validateLocalDwnPairing(
  pairing: LocalDwnPairingRecord,
  fetchFn: FetchLike,
  origin?: string,
): Promise<LocalDwnPairingValidation> {
  const infoResult = await fetchLocalDwnServerInfoResult(pairing.endpoint, fetchFn);
  if (infoResult.status === 'unavailable') {
    return infoResult;
  }

  if (infoResult.status === 'invalid' || infoResult.serverInfo.localNode !== true) {
    return { status: 'revoked' };
  }

  const status = await fetchLocalDwnStatus(pairing, fetchFn, origin);
  return status === 'paired'
    ? { serverInfo: infoResult.serverInfo, status }
    : { status };
}

async function fetchLocalDwnServerInfo(endpoint: string, fetchFn: FetchLike): Promise<ServerInfo | undefined> {
  const result = await fetchLocalDwnServerInfoResult(endpoint, fetchFn);
  return result.status === 'found' ? result.serverInfo : undefined;
}

async function fetchLocalDwnServerInfoResult(endpoint: string, fetchFn: FetchLike): Promise<LocalDwnServerInfoResult> {
  let response: Response;
  try {
    response = await fetchFn(endpointUrl(endpoint, '/info'), { method: 'GET' });
  } catch {
    return { status: 'unavailable' };
  }

  if (!response.ok) {
    return { status: isTransientHttpStatus(response.status) ? 'unavailable' : 'invalid' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: 'invalid' };
  }

  if (body === null || typeof body !== 'object') {
    return { status: 'invalid' };
  }

  const serverInfo = body as ServerInfo;
  return serverInfo.server === localDwnServerName
    ? { serverInfo, status: 'found' }
    : { status: 'invalid' };
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
): Promise<'paired' | 'revoked' | 'unavailable'> {
  let response: Response;
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${pairing.token}` };
    attachOriginHeader(headers, origin);

    response = await fetchFn(endpointUrl(pairing.endpoint, '/local/status'), {
      headers,
      method: 'GET',
    });
  } catch {
    return 'unavailable';
  }

  if (!response.ok) {
    return isTransientHttpStatus(response.status) ? 'unavailable' : 'revoked';
  }

  let body: { localNode?: unknown; paired?: unknown };
  try {
    body = await response.json() as { localNode?: unknown; paired?: unknown };
  } catch {
    return 'revoked';
  }

  return body.localNode === true && body.paired === true ? 'paired' : 'revoked';
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

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, ms);
  });
}
