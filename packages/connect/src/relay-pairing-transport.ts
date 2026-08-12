import type { ConnectPairingReveal } from './pairing.js';
import type { FetchFn } from './relay-transport.js';

import { CryptoUtils } from '@enbox/crypto';
import { Convert, sleep } from '@enbox/common';

const RELAY_PAIRING_VERSION = '3' as const;
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000;
const MAX_FRAME_BYTES = 256 * 1024;

class RetryablePairingError extends Error {}

type RelayPairingRole = 'client' | 'wallet';
type RelayPairingStage = 'confirmation' | 'decision' | 'request' | 'response';

type RelayPairingRuntime = {
  fetch: FetchFn;
  httpTimeoutMs: number;
  now: () => number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  signal?: AbortSignal;
  sleep: (ms: number) => Promise<void>;
};

/** Shared cancellation and polling options for Connect v3 relay carriers. */
export type RelayPairingTransportOptions = {
  /** Fetch implementation override; defaults to the ambient global fetch. */
  fetchFn?: FetchFn;

  /** Per-request HTTP timeout in milliseconds. */
  httpTimeoutMs?: number;

  /** Clock override used by polling deadlines. */
  now?: () => number;

  /** Delay between pending relay polls in milliseconds. */
  pollIntervalMs?: number;

  /** Total budget for each awaited relay value in milliseconds. */
  pollTimeoutMs?: number;

  /** Cancels HTTP requests and polling sleeps. */
  signal?: AbortSignal;

  /** Sleep override used between polling attempts. */
  sleep?: (ms: number) => Promise<void>;
};

/** Parameters used to create the requester side of a relay pairing. */
export type RelayPairingClientTransportOptions = RelayPairingTransportOptions & {
  /** Commitment from {@link ConnectClientSession.clientCommitment}. */
  clientCommitment: string;

  /** Canonical HTTPS relay origin, or an HTTP loopback origin for development. */
  relayOrigin: string;
};

/** Parameters used by a wallet to atomically claim a public pairing URI. */
export type RelayPairingWalletTransportOptions = RelayPairingTransportOptions & {
  /** Public, secret-free URI returned to the requesting client. */
  pairingUri: string;

  /** Commitment from {@link ConnectProviderSession.walletCommitment}. */
  walletCommitment: string;

  /** Canonical origin of the wallet handling the request. */
  walletOrigin: string;
};

/** Relay claim data bound into the requester-side pairing session. */
export type RelayPairingWalletClaim = {
  pairingId: string;
  relayOrigin: string;
  walletCommitment: string;
  walletOrigin: string;
};

/** Requester-side HTTP carrier for the fixed Connect v3 relay sequence. */
export class RelayPairingClientTransport {
  private readonly _pairingId: string;
  private readonly _pairingUri: string;
  private readonly _relayOrigin: string;
  private readonly _expiresInSeconds: number;
  private readonly _runtime: RelayPairingRuntime;
  private _walletCommitment?: string;
  private _walletOrigin?: string;
  readonly #clientCapability: string;

  private constructor({
    pairingId, pairingUri, relayOrigin, clientCapability, expiresInSeconds, runtime,
  }: {
    pairingId: string;
    pairingUri: string;
    relayOrigin: string;
    clientCapability: string;
    expiresInSeconds: number;
    runtime: RelayPairingRuntime;
  }) {
    this._pairingId = pairingId;
    this._pairingUri = pairingUri;
    this._relayOrigin = relayOrigin;
    this._expiresInSeconds = expiresInSeconds;
    this._runtime = runtime;
    this.#clientCapability = clientCapability;
  }

  /** Creates a public pairing locator and retains its client-only capability. */
  public static async create(options: RelayPairingClientTransportOptions): Promise<RelayPairingClientTransport> {
    const relayOrigin = requireCanonicalOrigin(options.relayOrigin, 'relay origin');
    requireBase64Url32(options.clientCommitment, 'client commitment');
    const initialRuntime = createRuntime(options, DEFAULT_POLL_INTERVAL_MS);
    const pairingsUrl = `${relayOrigin}/connect/v3/pairings`;
    const response = await fetchPairing(initialRuntime, pairingsUrl, {
      body    : JSON.stringify({ client_key_commitment: options.clientCommitment, version: RELAY_PAIRING_VERSION }),
      headers : { 'Content-Type': 'application/json' },
      method  : 'POST',
    });
    await requireStatus(response, 201, 'pairing creation');
    const body = requireObject(await readJson(response, 'pairing creation'), [
      'client_capability',
      'expires_in',
      'interval',
      'pair_uri',
      'pairing_id',
      'relay_origin',
      'version',
    ], 'pairing creation');
    requireVersion(body, 'pairing creation');
    const pairingId = requirePairingId(body.pairing_id, 'pairing creation');
    const clientCapability = requireBase64Url32(body.client_capability, 'client capability');
    const responseRelayOrigin = requireCanonicalOrigin(body.relay_origin, 'relay origin');
    const pairingUri = requirePairingUri(body.pair_uri).pairingUri;
    const expiresInSeconds = requirePositiveInteger(body.expires_in, 'pairing expiration');
    const intervalSeconds = requirePositiveInteger(body.interval, 'pairing polling interval');
    const expectedPairingUri = `${relayOrigin}/connect/v3/pairings/${pairingId}`;
    if (responseRelayOrigin !== relayOrigin || pairingUri !== expectedPairingUri || expiresInSeconds < intervalSeconds) {
      throw new Error('Connect: relay returned inconsistent pairing creation metadata.');
    }

    return new RelayPairingClientTransport({
      pairingId,
      pairingUri,
      relayOrigin,
      clientCapability,
      expiresInSeconds,
      runtime: createRuntime(options, intervalSeconds * 1000),
    });
  }

  /** Public, secret-free relay locator for a wallet selector or deep-link wrapper. */
  public get pairingUri(): string {
    return this._pairingUri;
  }

  /** Relay-issued identifier bound into the cryptographic session transcript. */
  public get pairingId(): string {
    return this._pairingId;
  }

  /** Exact relay origin bound into the cryptographic session transcript. */
  public get relayOrigin(): string {
    return this._relayOrigin;
  }

  /** Pairing lifetime advertised by the relay. */
  public get expiresInSeconds(): number {
    return this._expiresInSeconds;
  }

  /** Waits until one wallet atomically claims the pairing. */
  public async awaitWalletClaim(): Promise<RelayPairingWalletClaim> {
    const body = requireObject(await pollPairing(
      this._runtime,
      `${this._pairingUri}/claim`,
      this.#clientCapability,
      'wallet claim',
    ), ['relay_origin', 'version', 'wallet_key_commitment', 'wallet_origin'], 'wallet claim');
    requireVersion(body, 'wallet claim');
    const relayOrigin = requireCanonicalOrigin(body.relay_origin, 'relay origin');
    const walletOrigin = requireCanonicalOrigin(body.wallet_origin, 'wallet origin');
    const walletCommitment = requireBase64Url32(body.wallet_key_commitment, 'wallet commitment');
    if (relayOrigin !== this._relayOrigin) {
      throw new Error('Connect: wallet claim changed the relay origin.');
    }
    this._walletCommitment = walletCommitment;
    this._walletOrigin = walletOrigin;
    return { pairingId: this._pairingId, relayOrigin, walletCommitment, walletOrigin };
  }

  /** Publishes the requester reveal after the wallet commitment is fixed. */
  public async publishClientReveal(reveal: ConnectPairingReveal): Promise<void> {
    await putReveal(this._runtime, this._pairingUri, 'client', this.#clientCapability, reveal);
  }

  /** Waits for and validates the wallet reveal metadata. */
  public async awaitWalletReveal(): Promise<ConnectPairingReveal> {
    if (this._walletCommitment === undefined || this._walletOrigin === undefined) {
      throw new Error('Connect: await the wallet claim before awaiting its reveal.');
    }
    return await pollReveal({
      runtime              : this._runtime,
      pairingUri           : this._pairingUri,
      role                 : 'wallet',
      capability           : this.#clientCapability,
      expectedCommitment   : this._walletCommitment,
      expectedRelayOrigin  : this._relayOrigin,
      expectedWalletOrigin : this._walletOrigin,
    });
  }

  /** Sends the signed and encrypted request frame. */
  public async sendRequest(frame: string): Promise<void> {
    await putFrame(this._runtime, this._pairingUri, 'client', this.#clientCapability, 'request', frame);
  }

  /** Waits for the wallet's signed and encrypted approval intent or denial. */
  public async awaitDecision(): Promise<string> {
    return await pollFrame(
      this._runtime,
      this._pairingUri,
      'wallet',
      this.#clientCapability,
      'decision',
    );
  }

  /** Sends the client's authenticated comparison result. */
  public async sendConfirmation(frame: string): Promise<void> {
    await putFrame(this._runtime, this._pairingUri, 'client', this.#clientCapability, 'confirmation', frame);
  }

  /** Waits for the wallet's signed and encrypted final grant response. */
  public async awaitResponse(): Promise<string> {
    return await pollFrame(
      this._runtime,
      this._pairingUri,
      'wallet',
      this.#clientCapability,
      'response',
    );
  }

}

/** Wallet-side HTTP carrier for the fixed Connect v3 relay sequence. */
export class RelayPairingWalletTransport {
  private readonly _pairingId: string;
  private readonly _pairingUri: string;
  private readonly _relayOrigin: string;
  private readonly _walletOrigin: string;
  private readonly _clientCommitment: string;
  private readonly _runtime: RelayPairingRuntime;
  readonly #walletCapability: string;

  private constructor({ pairingId, pairingUri, relayOrigin, walletOrigin, clientCommitment, walletCapability, runtime }: {
    pairingId: string;
    pairingUri: string;
    relayOrigin: string;
    walletOrigin: string;
    clientCommitment: string;
    walletCapability: string;
    runtime: RelayPairingRuntime;
  }) {
    this._pairingId = pairingId;
    this._pairingUri = pairingUri;
    this._relayOrigin = relayOrigin;
    this._walletOrigin = walletOrigin;
    this._clientCommitment = clientCommitment;
    this._runtime = runtime;
    this.#walletCapability = walletCapability;
  }

  /** Atomically claims a public pairing with the wallet's pre-existing commitment. */
  public static async claim(options: RelayPairingWalletTransportOptions): Promise<RelayPairingWalletTransport> {
    const parsedPairing = requirePairingUri(options.pairingUri);
    const walletOrigin = requireCanonicalOrigin(options.walletOrigin, 'wallet origin');
    requireBase64Url32(options.walletCommitment, 'wallet commitment');
    const walletCapability = Convert.uint8Array(CryptoUtils.randomBytes(32)).toBase64Url();
    const runtime = createRuntime(options, DEFAULT_POLL_INTERVAL_MS);
    const claimBody = JSON.stringify({
      version               : RELAY_PAIRING_VERSION,
      wallet_capability     : walletCapability,
      wallet_key_commitment : options.walletCommitment,
      wallet_origin         : walletOrigin,
    });
    const body = await retryPairingTransaction(runtime, 'wallet claim', async (remainingMs): Promise<Record<string, unknown>> => {
      const response = await fetchPairing(runtime, `${parsedPairing.pairingUri}/claim`, {
        body    : claimBody,
        headers : { 'Content-Type': 'application/json' },
        method  : 'POST',
      }, remainingMs);
      await requireStatus(response, 201, 'wallet claim');
      return requireObject(await readJson(response, 'wallet claim'), [
        'client_key_commitment',
        'relay_origin',
        'version',
        'wallet_origin',
      ], 'wallet claim');
    });
    requireVersion(body, 'wallet claim');
    const clientCommitment = requireBase64Url32(body.client_key_commitment, 'client commitment');
    const relayOrigin = requireCanonicalOrigin(body.relay_origin, 'relay origin');
    const responseWalletOrigin = requireCanonicalOrigin(body.wallet_origin, 'wallet origin');
    if (relayOrigin !== parsedPairing.relayOrigin || responseWalletOrigin !== walletOrigin) {
      throw new Error('Connect: relay returned inconsistent wallet claim metadata.');
    }

    return new RelayPairingWalletTransport({
      pairingId  : parsedPairing.pairingId,
      pairingUri : parsedPairing.pairingUri,
      relayOrigin,
      walletOrigin,
      clientCommitment,
      walletCapability,
      runtime,
    });
  }

  public get pairingId(): string {
    return this._pairingId;
  }

  public get relayOrigin(): string {
    return this._relayOrigin;
  }

  public get walletOrigin(): string {
    return this._walletOrigin;
  }

  public get clientCommitment(): string {
    return this._clientCommitment;
  }

  /** Waits for and validates the requester reveal metadata. */
  public async awaitClientReveal(): Promise<ConnectPairingReveal> {
    return await pollReveal({
      runtime              : this._runtime,
      pairingUri           : this._pairingUri,
      role                 : 'client',
      capability           : this.#walletCapability,
      expectedCommitment   : this._clientCommitment,
      expectedRelayOrigin  : this._relayOrigin,
      expectedWalletOrigin : this._walletOrigin,
    });
  }

  /** Publishes the wallet reveal after validating the requester reveal. */
  public async publishWalletReveal(reveal: ConnectPairingReveal): Promise<void> {
    await putReveal(this._runtime, this._pairingUri, 'wallet', this.#walletCapability, reveal);
  }

  /** Waits for the requester's signed and encrypted request. */
  public async awaitRequest(): Promise<string> {
    return await pollFrame(
      this._runtime,
      this._pairingUri,
      'client',
      this.#walletCapability,
      'request',
    );
  }

  /** Sends the signed and encrypted approval intent or denial. */
  public async sendDecision(frame: string): Promise<void> {
    await putFrame(this._runtime, this._pairingUri, 'wallet', this.#walletCapability, 'decision', frame);
  }

  /** Waits for the client's authenticated comparison result. */
  public async awaitConfirmation(): Promise<string> {
    return await pollFrame(
      this._runtime,
      this._pairingUri,
      'client',
      this.#walletCapability,
      'confirmation',
    );
  }

  /** Sends the signed and encrypted final grant response. */
  public async sendResponse(frame: string): Promise<void> {
    await putFrame(this._runtime, this._pairingUri, 'wallet', this.#walletCapability, 'response', frame);
  }

}

async function putReveal(
  runtime: RelayPairingRuntime,
  pairingUri: string,
  role: RelayPairingRole,
  capability: string,
  reveal: ConnectPairingReveal,
): Promise<void> {
  const publicKey = requireBase64Url32(reveal.publicKey, `${role} public key`);
  const nonce = requireBase64Url32(reveal.nonce, `${role} nonce`);
  await putPairing(runtime, `${pairingUri}/reveals/${role}`, capability, {
    nonce,
    public_key : publicKey,
    version    : RELAY_PAIRING_VERSION,
  }, `${role} reveal`);
}

async function pollReveal({
  runtime,
  pairingUri,
  role,
  capability,
  expectedCommitment,
  expectedRelayOrigin,
  expectedWalletOrigin,
}: {
  runtime: RelayPairingRuntime;
  pairingUri: string;
  role: RelayPairingRole;
  capability: string;
  expectedCommitment: string;
  expectedRelayOrigin: string;
  expectedWalletOrigin: string;
}): Promise<ConnectPairingReveal> {
  const body = requireObject(await pollPairing(
    runtime,
    `${pairingUri}/reveals/${role}`,
    capability,
    `${role} reveal`,
  ), ['key_commitment', 'nonce', 'public_key', 'relay_origin', 'version', 'wallet_origin'], `${role} reveal`);
  requireVersion(body, `${role} reveal`);
  const commitment = requireBase64Url32(body.key_commitment, `${role} commitment`);
  const relayOrigin = requireCanonicalOrigin(body.relay_origin, 'relay origin');
  const walletOrigin = requireCanonicalOrigin(body.wallet_origin, 'wallet origin');
  if (commitment !== expectedCommitment || relayOrigin !== expectedRelayOrigin || walletOrigin !== expectedWalletOrigin) {
    throw new Error(`Connect: relay returned inconsistent ${role} reveal metadata.`);
  }
  return {
    nonce     : requireBase64Url32(body.nonce, `${role} nonce`),
    publicKey : requireBase64Url32(body.public_key, `${role} public key`),
  };
}

async function putFrame(
  runtime: RelayPairingRuntime,
  pairingUri: string,
  direction: RelayPairingRole,
  capability: string,
  stage: RelayPairingStage,
  frame: string,
): Promise<void> {
  requireFrame(frame, `${stage} frame`);
  const body: Record<string, string> = { frame, stage, version: RELAY_PAIRING_VERSION };
  await putPairing(runtime, `${pairingUri}/${direction}`, capability, body, `${stage} frame`);
}

async function pollFrame(
  runtime: RelayPairingRuntime,
  pairingUri: string,
  direction: RelayPairingRole,
  capability: string,
  stage: RelayPairingStage,
): Promise<string> {
  const value = await pollPairing(
    runtime,
    `${pairingUri}/${direction}?stage=${stage}`,
    capability,
    `${stage} frame`,
  );
  const body = requireObject(
    value,
    ['frame', 'stage', 'version'],
    `${stage} frame`,
  );
  requireVersion(body, `${stage} frame`);
  if (body.stage !== stage) {
    throw new Error(`Connect: relay returned the wrong ${stage} frame stage.`);
  }
  return requireFrame(body.frame, `${stage} frame`);
}

async function putPairing(
  runtime: RelayPairingRuntime,
  url: string,
  capability: string,
  body: Record<string, string>,
  label: string,
): Promise<void> {
  const serializedBody = JSON.stringify(body);
  await retryPairingTransaction(runtime, label, async (remainingMs): Promise<void> => {
    const response = await fetchPairing(runtime, url, {
      body    : serializedBody,
      headers : authorizationHeaders(capability, true),
      method  : 'PUT',
    }, remainingMs);
    await requireStatus(response, 204, label);
  });
}

async function pollPairing(
  runtime: RelayPairingRuntime,
  url: string,
  capability: string,
  label: string,
): Promise<unknown> {
  const deadline = runtime.now() + runtime.pollTimeoutMs;
  while (runtime.now() < deadline) {
    runtime.signal?.throwIfAborted();
    const remainingMs = deadline - runtime.now();
    try {
      const response = await fetchPairing(runtime, url, {
        headers : authorizationHeaders(capability, false),
        method  : 'GET',
      }, remainingMs);
      if (response.status === 204) {
        await response.body?.cancel().catch((): void => {});
        await sleepForPoll(runtime, Math.min(runtime.pollIntervalMs, Math.max(0, deadline - runtime.now())));
        continue;
      }
      await requireStatus(response, 200, label);
      return await readJson(response, label);
    } catch (error) {
      if (!(error instanceof RetryablePairingError)) {
        throw error;
      }
      runtime.signal?.throwIfAborted();
      await sleepForPoll(runtime, Math.min(runtime.pollIntervalMs, Math.max(0, deadline - runtime.now())));
    }
  }
  throw new Error(`Connect: timed out after ${runtime.pollTimeoutMs}ms waiting for ${label}.`);
}

async function retryPairingTransaction<T>(
  runtime: RelayPairingRuntime,
  label: string,
  operation: (remainingMs: number) => Promise<T>,
): Promise<T> {
  const deadline = runtime.now() + runtime.pollTimeoutMs;

  while (runtime.now() < deadline) {
    try {
      return await operation(deadline - runtime.now());
    } catch (error) {
      if (!(error instanceof RetryablePairingError)) {
        throw error;
      }
      runtime.signal?.throwIfAborted();
      await sleepForPoll(runtime, Math.min(runtime.pollIntervalMs, Math.max(0, deadline - runtime.now())));
    }
  }

  throw new Error(`Connect: timed out after ${runtime.pollTimeoutMs}ms during ${label}.`);
}

async function fetchPairing(
  runtime: RelayPairingRuntime,
  url: string,
  init: RequestInit,
  remainingMs = runtime.httpTimeoutMs,
): Promise<Response> {
  runtime.signal?.throwIfAborted();
  const timeoutMs = Math.max(1, Math.min(runtime.httpTimeoutMs, remainingMs));
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  try {
    return await runtime.fetch(url, {
      ...init,
      cache       : 'no-store',
      credentials : 'omit',
      redirect    : 'error',
      signal      : runtime.signal === undefined ? timeoutSignal : AbortSignal.any([runtime.signal, timeoutSignal]),
    });
  } catch {
    runtime.signal?.throwIfAborted();
    throw new RetryablePairingError('Connect: relay transport failed.');
  }
}

async function sleepForPoll(runtime: RelayPairingRuntime, milliseconds: number): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  if (runtime.signal === undefined) {
    await runtime.sleep(milliseconds);
    return;
  }

  const signal = runtime.signal;
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject): void => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void runtime.sleep(milliseconds).then(
      (): void => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      (error: unknown): void => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function requireStatus(response: Response, expected: number, label: string): Promise<void> {
  if (response.status === expected) {
    return;
  }
  await response.body?.cancel().catch((): void => {});
  if ([408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
    throw new RetryablePairingError(`Connect: ${label} received a retryable relay response.`);
  }
  throw new Error(`Connect: ${label} failed with HTTP ${response.status}.`);
}

async function readJson(response: Response, label: string): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new Error(`Connect: relay returned a non-JSON ${label} response.`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new RetryablePairingError(`Connect: relay response stream failed for ${label}.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Connect: relay returned malformed JSON for ${label}.`);
  }
}

function createRuntime(options: RelayPairingTransportOptions, defaultPollIntervalMs: number): RelayPairingRuntime {
  const httpTimeoutMs = requirePositiveNumber(options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, 'HTTP timeout');
  const requestedPollIntervalMs = requirePositiveNumber(options.pollIntervalMs ?? defaultPollIntervalMs, 'polling interval');
  const pollIntervalMs = Math.max(requestedPollIntervalMs, defaultPollIntervalMs);
  const pollTimeoutMs = requirePositiveNumber(options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS, 'polling timeout');
  return {
    fetch  : options.fetchFn ?? ((input, init): Promise<Response> => globalThis.fetch(input, init)),
    httpTimeoutMs,
    now    : options.now ?? ((): number => Date.now()),
    pollIntervalMs,
    pollTimeoutMs,
    signal : options.signal,
    sleep  : options.sleep ?? sleep,
  };
}

function authorizationHeaders(capability: string, json: boolean): Record<string, string> {
  requireBase64Url32(capability, 'relay capability');
  const headers: Record<string, string> = { Authorization: `Bearer ${capability}` };
  if (json) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function requireObject(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Connect: relay returned an invalid ${label} response.`);
  }
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== keys.length || !keys.every((key): boolean => actualKeys.includes(key))) {
    throw new Error(`Connect: relay returned an invalid ${label} response.`);
  }
  return value;
}

function requirePairingUri(value: unknown): { pairingId: string; pairingUri: string; relayOrigin: string } {
  if (typeof value !== 'string') {
    throw new Error('Connect: pairing URI must be a public relay URL.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Connect: pairing URI must be a public relay URL.');
  }
  const relayOrigin = requireCanonicalOrigin(url.origin, 'pairing relay origin');
  const match = /^\/connect\/v3\/pairings\/([0-9a-f-]+)$/.exec(url.pathname);
  const pairingId = match?.[1];
  if (pairingId === undefined || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
      url.toString() !== value) {
    throw new Error('Connect: pairing URI must be a public relay URL.');
  }
  requirePairingId(pairingId, 'pairing URI');
  return { pairingId, pairingUri: value, relayOrigin };
}

function requirePairingId(value: unknown, label: string): string {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`Connect: relay returned an invalid ${label} pairing ID.`);
  }
  return value;
}

function requireCanonicalOrigin(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Connect: ${label} must be a canonical HTTPS origin.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Connect: ${label} must be a canonical HTTPS origin.`);
  }
  const isLoopbackHttp = url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if ((url.protocol !== 'https:' && !isLoopbackHttp) || url.origin !== value) {
    throw new Error(`Connect: ${label} must be a canonical HTTPS origin or an HTTP loopback origin.`);
  }
  return value;
}

function requireBase64Url32(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`Connect: ${label} must be canonical 32-byte base64url data.`);
  }
  try {
    const bytes = Convert.base64Url(value).toUint8Array();
    if (bytes.length !== 32 || Convert.uint8Array(bytes).toBase64Url() !== value) {
      throw new Error();
    }
  } catch {
    throw new Error(`Connect: ${label} must be canonical 32-byte base64url data.`);
  }
  return value;
}

function requireFrame(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_FRAME_BYTES) {
    throw new Error(`Connect: ${label} must be non-empty and at most ${MAX_FRAME_BYTES} bytes.`);
  }
  return value;
}

function requireVersion(value: Record<string, unknown>, label: string): void {
  if (value.version !== RELAY_PAIRING_VERSION) {
    throw new Error(`Connect: relay returned an unsupported ${label} version.`);
  }
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Connect: relay returned an invalid ${label}.`);
  }
  return value;
}

function requirePositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Connect: ${label} must be a positive number.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
