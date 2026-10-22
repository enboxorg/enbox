/** DWN tenant registration shared by explicit requests and identity creation. */

import type { ServerInfo } from '@enbox/dwn-clients';
import type { EnboxUserAgent, SecretStore } from '@enbox/agent';

import type {
  DwnTenantRegistrationOptions,
  DwnTenantRegistrationPair,
  DwnTenantRegistrationResult,
  RegistrationOptions,
  RegistrationTokenData,
} from './types.js';

import { Convert } from '@enbox/common';
import { DwnRegistrar } from '@enbox/dwn-clients';
import { normalizeDwnEndpointUrls } from '@enbox/dids';

import { DwnTenantRegistrationError } from './errors.js';
import { STORAGE_KEYS } from './types.js';

/** @internal */
export type RegistrationContext = {
  userAgent: EnboxUserAgent;
  operationSignal: AbortSignal;
  /** Throws when teardown or session replacement invalidates the request. */
  assertActive: () => void;
  /** Serializes mutations against the owning manager's lifecycle. */
  runMutation: <T>(operation: () => Promise<T>) => Promise<T>;
};

type RegistrationFlight<T> = {
  assertActive: () => void;
  promise: Promise<T>;
};

type PairRegistrationResult = {
  unpreparedOwner?: boolean;
  usedProviderAuth?: boolean;
  succeeded: boolean;
  error?: unknown;
};

type ReservedRegistrationPair = DwnTenantRegistrationPair & {
  operation: Promise<PairRegistrationResult>;
  ownsFlight: boolean;
};

type RegistrationCredential = {
  token?: RegistrationTokenData;
  /** Compare encrypted storage against this value before saving an uncommitted rotation. */
  baseline?: RegistrationTokenData;
  dirty: boolean;
};

type RegistrationState = {
  controller: AbortController;
  pairFlights: Map<string, RegistrationFlight<PairRegistrationResult>>;
  tokenFlights: Map<string, RegistrationFlight<void>>;
  tokenTail: Promise<void>;
  callbackTail: Promise<void>;
  credentials: Map<string, RegistrationCredential>;
  seeded: WeakSet<RegistrationOptions>;
  observedStorage: boolean;
};

const registrationStates = new WeakMap<EnboxUserAgent, RegistrationState>();

class RegistrationTokenStorageError extends Error {
  constructor(cause: unknown) {
    super('DWN registration credentials could not be read or saved.', { cause });
    this.name = 'RegistrationTokenStorageError';
  }
}

class RegistrationOwnerError extends Error {
  constructor(did: string) {
    super(`DWN tenant registration requires a locally managed owner DID: '${did}'.`);
    this.name = 'RegistrationOwnerError';
  }
}

function stateFor(agent: EnboxUserAgent): RegistrationState {
  let state = registrationStates.get(agent);
  if (state === undefined) {
    state = {
      controller      : new AbortController(),
      pairFlights     : new Map(),
      tokenFlights    : new Map(),
      tokenTail       : Promise.resolve(),
      callbackTail    : Promise.resolve(),
      credentials     : new Map(),
      seeded          : new WeakSet(),
      observedStorage : false,
    };
    registrationStates.set(agent, state);
  }
  return state;
}

/** Cancel captured requests and erase credentials after preceding writes, retaining consumed seed tracking. @internal */
export async function clearRegistrationCredentials(agent: EnboxUserAgent, registration?: RegistrationOptions): Promise<void> {
  const state = stateFor(agent);
  const previous = state.tokenTail;
  let release!: () => void;
  state.tokenTail = new Promise<void>((resolve): void => { release = resolve; });
  const controller = state.controller;
  state.controller = new AbortController();
  state.credentials.clear();
  state.pairFlights.clear();
  state.tokenFlights.clear();
  state.observedStorage = true;
  if (registration !== undefined) {
    state.seeded.add(registration);
  }
  // Reserve deletion before abort listeners can start a new registration.
  controller.abort();
  try {
    await previous;
    await agent.secrets.delete(STORAGE_KEYS.REGISTRATION_TOKENS).catch(() => {});
  } finally {
    release();
  }
}

function assertActive(ctx: RegistrationContext): void {
  ctx.assertActive();
  ctx.operationSignal.throwIfAborted();
  if (ctx.userAgent.vault.isLocked()) {
    throw new Error('DWN tenant registration requires an unlocked vault.');
  }
}

async function runMutation<T>(ctx: RegistrationContext, operation: () => T | Promise<T>): Promise<T> {
  const guardedOperation = async (): Promise<T> => {
    assertActive(ctx);
    const result = await operation();
    assertActive(ctx);
    return result;
  };
  return ctx.runMutation(guardedOperation);
}

/** Authorize and issue network work under the lifecycle fence, then release it while awaiting I/O. */
async function runRequest<T>(
  ctx: RegistrationContext,
  request: () => Promise<T>,
  did?: string,
): Promise<T> {
  const pending = await runMutation(ctx, async (): Promise<{ response: Promise<T> }> => {
    if (did !== undefined) {
      await assertOwner(ctx, did);
    }
    assertActive(ctx);
    const response = request();
    // Teardown can invalidate the mutation after dispatch, before its boxed
    // promise reaches the caller. Keep that abandoned response handled too.
    void response.catch((): void => {});
    return { response };
  });
  const response = await pending.response;
  assertActive(ctx);
  return response;
}

async function assertOwner(ctx: RegistrationContext, did: string): Promise<void> {
  if (did === ctx.userAgent.agentDid.uri) {
    return;
  }
  const identity = await ctx.userAgent.identity.get({ didUri: did });
  if (identity === undefined || identity.did.uri !== did || identity.metadata.connectedDid !== undefined) {
    throw new RegistrationOwnerError(did);
  }
}

function activeFlight<T>(
  flights: Map<string, RegistrationFlight<T>>,
  key: string,
): RegistrationFlight<T> | undefined {
  const flight = flights.get(key);
  if (flight !== undefined) {
    try {
      flight.assertActive();
      return flight;
    } catch {
      flights.delete(key);
    }
  }
  return undefined;
}

function singleFlight<T>(
  flights: Map<string, RegistrationFlight<T>>,
  key: string,
  ctx: RegistrationContext,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = activeFlight(flights, key);
  if (previous !== undefined) {
    return previous.promise;
  }
  const flight = { assertActive: (): void => assertActive(ctx), promise: operation() };
  flights.set(key, flight);
  const release = (): void => {
    if (flights.get(key) === flight) {
      flights.delete(key);
    }
  };
  void flight.promise.then(release, release);
  return flight.promise;
}

/** Serialize read/merge/write transactions without holding a lock across provider UI. */
async function mutateTokens<T>(ctx: RegistrationContext, operation: () => T | Promise<T>): Promise<T> {
  // Take the manager lifecycle lock before the shared token queue, as erasure does.
  return runMutation(ctx, async (): Promise<T> => {
    const state = stateFor(ctx.userAgent);
    const previous = state.tokenTail;
    let release!: () => void;
    state.tokenTail = new Promise<void>((resolve): void => { release = resolve; });
    await previous;
    try {
      assertActive(ctx);
      return await operation();
    } catch (error: unknown) {
      assertActive(ctx);
      throw new RegistrationTokenStorageError(error);
    } finally {
      release();
    }
  });
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isTokenData(value: unknown): value is RegistrationTokenData {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const token = value as Record<string, unknown>;
  return typeof token.registrationToken === 'string'
    && token.registrationToken.length > 0
    && (token.refreshToken === undefined || typeof token.refreshToken === 'string')
    && (token.refreshUrl === undefined || isHttpUrl(token.refreshUrl))
    && (token.expiresAt === undefined || (typeof token.expiresAt === 'number' && Number.isFinite(token.expiresAt)));
}

function validateTokens(value: unknown): Record<string, RegistrationTokenData> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored DWN registration credentials are invalid.');
  }
  const normalized: Record<string, RegistrationTokenData> = {};
  for (const [endpoint, token] of Object.entries(value)) {
    const endpoints = normalizeDwnEndpointUrls([endpoint]);
    if (endpoints === undefined || !isTokenData(token)) {
      throw new Error('Stored DWN registration credentials are invalid.');
    }
    const canonicalEndpoint = endpoints[0];
    if (normalized[canonicalEndpoint] !== undefined && !sameToken(normalized[canonicalEndpoint], token)) {
      throw new Error(`Conflicting DWN registration credentials for '${canonicalEndpoint}'.`);
    }
    normalized[canonicalEndpoint] = token;
  }
  return normalized;
}

async function loadTokens(secretStore: SecretStore): Promise<Record<string, RegistrationTokenData>> {
  const bytes = await secretStore.get(STORAGE_KEYS.REGISTRATION_TOKENS);
  return bytes === undefined ? {} : validateTokens(JSON.parse(Convert.uint8Array(bytes).toString()));
}

function sameToken(left: RegistrationTokenData | undefined, right: RegistrationTokenData | undefined): boolean {
  return left === right || (left?.registrationToken === right?.registrationToken
    && left?.refreshToken === right?.refreshToken
    && left?.refreshUrl === right?.refreshUrl
    && left?.expiresAt === right?.expiresAt);
}

function snapshotTokens(state: RegistrationState): Record<string, RegistrationTokenData> {
  return Object.fromEntries([...state.credentials].flatMap(([endpoint, credential]) =>
    credential.token === undefined ? [] : [[endpoint, { ...credential.token }]]));
}

/** Order caller-owned persistence without holding token or lifecycle mutation locks. */
async function commitTokenCallback(ctx: RegistrationContext, registration: RegistrationOptions): Promise<void> {
  const callback = registration.onRegistrationTokens;
  if (callback === undefined) {
    return;
  }
  const state = stateFor(ctx.userAgent);
  const commit = state.callbackTail.then(async (): Promise<void> => {
    assertActive(ctx);
    await prepareTokens(ctx, registration);
    assertActive(ctx);
    await callback(snapshotTokens(state));
    assertActive(ctx);
  });
  state.callbackTail = commit.catch((): void => {});
  return commit;
}

function reconcileTokens(state: RegistrationState, stored: Record<string, RegistrationTokenData>): void {
  for (const endpoint of new Set([...state.credentials.keys(), ...Object.keys(stored)])) {
    const credential = state.credentials.get(endpoint);
    const token = stored[endpoint];
    if (credential?.dirty && (sameToken(token, credential.baseline) || (!state.observedStorage && token === undefined))) {
      // Keep a local rotation only while storage still has its observed prior
      // value. The first encrypted caller may join a manual-only rotation.
      credential.baseline = token;
    } else if (credential !== undefined) {
      credential.token = token;
      credential.baseline = token;
      credential.dirty = false;
    } else {
      state.credentials.set(endpoint, { token, baseline: token, dirty: false });
    }
  }
  state.observedStorage = true;
}

async function prepareTokens(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
): Promise<void> {
  return mutateTokens(ctx, async (): Promise<void> => {
    const state = stateFor(ctx.userAgent);
    if (registration.persistTokens !== false) {
      const stored = await loadTokens(ctx.userAgent.secrets);
      assertActive(ctx);
      reconcileTokens(state, stored);
      return;
    }
    if (state.seeded.has(registration)) {
      return;
    }
    const seeds = validateTokens(registration.registrationTokens ?? {});
    for (const [endpoint, token] of Object.entries(seeds)) {
      if (!state.credentials.has(endpoint)) {
        const initial = { ...token };
        state.credentials.set(endpoint, { token: initial, baseline: state.observedStorage ? undefined : initial, dirty: true });
      }
    }
    state.seeded.add(registration);
  });
}

async function saveToken(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
  endpoint: string,
): Promise<RegistrationTokenData> {
  return mutateTokens(ctx, async (): Promise<RegistrationTokenData> => {
    const state = stateFor(ctx.userAgent);
    const stored = registration.persistTokens === false ? undefined : await loadTokens(ctx.userAgent.secrets);
    assertActive(ctx);
    if (stored !== undefined) {
      reconcileTokens(state, stored);
    }
    const credential = state.credentials.get(endpoint);
    if (credential?.token === undefined) {
      throw new Error(`DWN '${endpoint}' registration credentials were cleared; retry authorization.`);
    }
    const token = credential.token;
    if (stored !== undefined) {
      const merged = { ...stored, [endpoint]: token };
      if (!sameToken(stored[endpoint], token)) {
        assertActive(ctx);
        await ctx.userAgent.secrets.put(STORAGE_KEYS.REGISTRATION_TOKENS, Convert.string(JSON.stringify(merged)).toUint8Array());
        assertActive(ctx);
      }
      credential.baseline = token;
      credential.dirty = false;
    }
    return token;
  });
}

async function commitTokenRotation(
  ctx: RegistrationContext,
  endpoint: string,
  credential: RegistrationCredential,
  previous: RegistrationTokenData | undefined,
  replacement: RegistrationTokenData,
): Promise<void> {
  return mutateTokens(ctx, (): void => {
    if (stateFor(ctx.userAgent).credentials.get(endpoint) !== credential) {
      throw new Error(`DWN '${endpoint}' registration credentials changed during authorization; retry.`);
    }
    if (sameToken(credential.token, previous)) {
      credential.token = replacement;
      credential.dirty = true;
    }
    if (credential.token === undefined) {
      throw new Error(`DWN '${endpoint}' registration credentials were cleared; retry authorization.`);
    }
  });
}

async function obtainToken(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
  endpoint: string,
  serverInfo: ServerInfo,
): Promise<RegistrationTokenData> {
  const state = stateFor(ctx.userAgent);
  await singleFlight(state.tokenFlights, endpoint, ctx, async (): Promise<void> => {
    await prepareTokens(ctx, registration);
    let credential = state.credentials.get(endpoint);
    if (credential === undefined) {
      credential = { dirty: false };
      state.credentials.set(endpoint, credential);
    }
    const token = credential.token;
    if (token !== undefined && (token.expiresAt === undefined || token.expiresAt > Date.now())) {
      return;
    }

    let replacement: RegistrationTokenData;
    if (token?.refreshToken !== undefined && token.refreshUrl !== undefined) {
      const refreshed = await runRequest(ctx, () => DwnRegistrar.refreshRegistrationToken(token.refreshUrl!, token.refreshToken!));
      replacement = {
        registrationToken : refreshed.registrationToken,
        refreshToken      : refreshed.refreshToken ?? token.refreshToken,
        refreshUrl        : token.refreshUrl,
        expiresAt         : refreshed.expiresIn === undefined ? undefined : Date.now() + refreshed.expiresIn * 1000,
      };
    } else {
      if (registration.onProviderAuthRequired === undefined) {
        throw new Error(`DWN '${endpoint}' requires provider authorization; supply onProviderAuthRequired.`);
      }
      const provider = serverInfo.providerAuth!;
      const csrfState = crypto.randomUUID();
      const authorizeUrl = new URL(provider.authorizeUrl);
      authorizeUrl.searchParams.set('redirect_uri', endpoint);
      authorizeUrl.searchParams.set('state', csrfState);
      assertActive(ctx);
      const authorization = await registration.onProviderAuthRequired({ authorizeUrl: authorizeUrl.href, dwnEndpoint: endpoint, state: csrfState });
      assertActive(ctx);
      if (authorization.state !== csrfState) {
        throw new Error('Provider auth state mismatch — possible CSRF attack.');
      }
      const response = await runRequest(ctx, () => DwnRegistrar.exchangeAuthCode(provider.tokenUrl, authorization.code, endpoint));
      replacement = {
        registrationToken : response.registrationToken,
        refreshToken      : response.refreshToken,
        expiresAt         : response.expiresIn === undefined ? undefined : Date.now() + response.expiresIn * 1000,
        refreshUrl        : provider.refreshUrl,
      };
    }
    validateTokens({ [endpoint]: replacement });
    return commitTokenRotation(ctx, endpoint, credential, token, replacement);
  });
  // Resolve the current credential at each caller's commit, including callers
  // with a different persistence policy from the token flight's owner.
  return saveToken(ctx, registration, endpoint);
}

async function registerPair(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
  did: string,
  endpoint: string,
  serverInfo: ServerInfo,
): Promise<PairRegistrationResult> {
  let token: RegistrationTokenData | undefined;
  try {
    const requirements = serverInfo.registrationRequirements;
    if (requirements.length === 0) {
      return { succeeded: true };
    }
    const hasProviderAuth = requirements.includes('provider-auth-v0') && serverInfo.providerAuth !== undefined;
    const hasProofOfWork = requirements.includes('proof-of-work-sha256-v0');
    const seed = stateFor(ctx.userAgent).credentials.get(endpoint)?.token;
    const useProviderAuth = hasProviderAuth && (registration.onProviderAuthRequired !== undefined || seed !== undefined || !hasProofOfWork);
    token = useProviderAuth ? await obtainToken(ctx, registration, endpoint, serverInfo) : undefined;
    if (token === undefined && !hasProofOfWork) {
      throw new Error(`DWN '${endpoint}' advertises no supported tenant registration method.`);
    }
    await runRequest(ctx, (): Promise<void> => token !== undefined
      ? DwnRegistrar.registerTenantWithToken(endpoint, did, token.registrationToken)
      : DwnRegistrar.registerTenant(endpoint, did, { signal: ctx.operationSignal }), did);
    return { succeeded: true, usedProviderAuth: token !== undefined };
  } catch (error: unknown) {
    assertActive(ctx);
    return { succeeded: false, usedProviderAuth: token !== undefined, error };
  }
}

/** Validate the whole request before any endpoint work can start. */
function prepareRegistration(
  ctx: RegistrationContext,
  options: DwnTenantRegistrationOptions,
  registration: RegistrationOptions,
): { dids: string[]; endpoints: string[]; prepared: Promise<void> } {
  const dids = [...new Set(options.dids)];
  const endpoints = normalizeDwnEndpointUrls([...options.dwnEndpoints]);
  if (dids.length === 0 || dids.some((did): boolean => typeof did !== 'string' || !did.startsWith('did:')) || endpoints === undefined) {
    throw new TypeError('DWN tenant registration requires owner DIDs and non-empty HTTP(S) endpoints without queries or fragments.');
  }
  const prepared = runMutation(ctx, () => Promise.all(dids.map((did) => assertOwner(ctx, did))))
    .then((): Promise<void> => prepareTokens(ctx, registration));
  return { dids, endpoints, prepared };
}

/** Pair work is already concurrent; collect in request order to fence each caller's credential commits. */
async function collectRegistrationResults(
  ctx: RegistrationContext,
  registration: RegistrationOptions,
  pairs: ReservedRegistrationPair[],
  reservePair: (did: string, endpoint: string) => ReservedRegistrationPair,
): Promise<DwnTenantRegistrationResult> {
  const result: DwnTenantRegistrationResult = { registered: [], failed: [] };

  for (const reserved of pairs) {
    const { did, endpoint } = reserved;
    let request = reserved;
    let pair = await request.operation; // NOSONAR S9382: pair work is concurrent; collect credential outcomes in request order.
    assertActive(ctx);
    if (!request.ownsFlight && pair.unpreparedOwner) {
      // The originating batch never passed ownership checks. This caller's
      // complete batch did, so reserve using its own validated preparation.
      request = reservePair(did, endpoint);
      pair = await request.operation; // NOSONAR S9382: finish the authorized retry before committing its credentials.
      assertActive(ctx);
    }
    if (pair.usedProviderAuth) {
      // A tenant response may outlive a later credential rotation.
      await saveToken(ctx, registration, endpoint); // NOSONAR S9382: ordered caller-owned credential commit.
    }
    if (pair.error instanceof RegistrationTokenStorageError) {
      throw pair.error;
    }
    if (pair.succeeded) {
      result.registered.push({ did, endpoint });
    } else {
      result.failed.push({ did, endpoint, error: pair.error });
    }
  }
  return result;
}

/**
 * Register exactly the requested managed owner DIDs at the requested endpoints.
 * Successful token rotations are saved before partial failures are reported.
 * @internal
 */
export async function registerDwnTenants(
  ctx: RegistrationContext,
  options: DwnTenantRegistrationOptions,
  registration: RegistrationOptions = {},
): Promise<DwnTenantRegistrationResult> {
  const state = stateFor(ctx.userAgent);
  ctx = { ...ctx, operationSignal: AbortSignal.any([ctx.operationSignal, state.controller.signal]) };
  assertActive(ctx);
  const { dids, endpoints, prepared } = prepareRegistration(ctx, options, registration);
  const discovery = new Map<string, Promise<ServerInfo>>();

  // Reserve every pair synchronously, before ownership/token preparation or
  // endpoint discovery can yield. All overlapping callers share that outcome.
  const reservePair = (did: string, endpoint: string): ReservedRegistrationPair => {
    let ownsFlight = false;
    const operation = singleFlight(state.pairFlights, JSON.stringify([did, endpoint]), ctx, async (): Promise<PairRegistrationResult> => {
      ownsFlight = true;
      let ownerPrepared = false;
      try {
        await prepared;
        ownerPrepared = true;
        assertActive(ctx);
        let info = discovery.get(endpoint);
        if (info === undefined) {
          info = ctx.userAgent.rpc.getServerInfo(endpoint);
          discovery.set(endpoint, info);
        }
        const serverInfo = await info;
        assertActive(ctx);
        return registerPair(ctx, registration, did, endpoint, serverInfo);
      } catch (error: unknown) {
        assertActive(ctx);
        return { succeeded: false, error, unpreparedOwner: !ownerPrepared && error instanceof RegistrationOwnerError };
      }
    });
    return { did, endpoint, operation, ownsFlight };
  };
  const pairs = endpoints.flatMap((endpoint) => dids.map((did) => reservePair(did, endpoint)));
  await prepared;
  const result = await collectRegistrationResults(ctx, registration, pairs, reservePair);

  assertActive(ctx);
  await commitTokenCallback(ctx, registration);
  if (result.failed.length > 0) {
    throw new DwnTenantRegistrationError(result);
  }
  return result;
}
