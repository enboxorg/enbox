import type { ExecuteConnectApprovalParams } from '@enbox/agent';
import type { ConnectRequest, ConnectSessionTransport } from '@enbox/connect';

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { executeConnectApproval } from '@enbox/agent';
import { assertConnectRequest, ConnectProvider } from '@enbox/connect';

/** Maximum lifetime of an unapproved request held by the wallet worker. */
export const CONNECT_WORKER_MAX_SESSION_TTL_MS = 300_000;

/** Default lifetime of an unapproved request held by the wallet worker. */
export const CONNECT_WORKER_SESSION_TTL_MS = 120_000;

/** Default upper bound for pending connect requests in one wallet worker. */
export const CONNECT_WORKER_MAX_PENDING_SESSIONS = 32;

/** Maximum serialized opened request admitted to the wallet worker. */
export const CONNECT_WORKER_MAX_REQUEST_BYTES = 65_536;

/** Maximum sealed relay envelope admitted before cryptographic processing. */
export const CONNECT_WORKER_MAX_JWE_BYTES = 131_072;

const CONNECT_WORKER_REQUEST_KEY_BYTES = 32;
const textEncoder = new TextEncoder();

export type ConnectWorkerSessionHandle = Readonly<{
  binding: string;
  expiresAt: number;
  id: string;
  requestDigest: string;
  workerInstanceId: string;
}>;

export type ConnectWorkerRequestContext = Readonly<{
  /** Authenticated gateway principal. This value must not come from the command body. */
  principalId: string;
}>;

export type ConnectWorkerPopupBinding = Readonly<{
  dappOrigin: string;
  kind: 'popup';
}>;

export type ConnectWorkerRelayBinding = Readonly<{
  kind: 'relay';
  requestUri: string;
}>;

export type ConnectWorkerChannelBinding = ConnectWorkerPopupBinding | ConnectWorkerRelayBinding;

export type BoundConnectWorkerRequest = Readonly<{
  handle: ConnectWorkerSessionHandle;
  request: ConnectRequest;
}>;

export type ConnectWorkerApprovalParams = {
  approvedProtocolOverrides?: readonly string[];
  approvedSessionTtlSeconds?: number;
  handle: ConnectWorkerSessionHandle;
  pin?: string;
  providerDid: string;
};

type ClaimedConnectWorkerSession = {
  channel: ConnectWorkerChannelBinding;
  request: ConnectRequest;
  transport: ConnectSessionTransport;
};

type StoredConnectWorkerSession = ClaimedConnectWorkerSession & {
  handle: ConnectWorkerSessionHandle;
  principalId: string;
};

type ConnectWorkerSessionRegistryOptions = {
  maxPendingSessions?: number;
  now?: () => number;
  sessionTtlMs?: number;
};

type BindConnectWorkerSessionParams = {
  channel: ConnectWorkerChannelBinding;
  context: ConnectWorkerRequestContext;
  request: ConnectRequest;
  transport: ConnectSessionTransport;
};

/** Stable failure codes returned by the page-to-worker security boundary. */
export type ConnectWorkerBoundaryErrorCode =
  | 'capacity-exceeded'
  | 'invalid-channel'
  | 'invalid-context'
  | 'invalid-request'
  | 'invalid-session'
  | 'session-expired'
  | 'worker-stopped';

/** An expected rejection at the page-to-worker connect boundary. */
export class ConnectWorkerBoundaryError extends Error {
  public constructor(public readonly code: ConnectWorkerBoundaryErrorCode, message: string) {
    super(message);
    this.name = 'ConnectWorkerBoundaryError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneAndValidateRequest(request: unknown): { digest: string; request: ConnectRequest } {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw new ConnectWorkerBoundaryError('invalid-request', 'Connect worker request must be JSON serializable.');
  }

  if (serialized === undefined) {
    throw new ConnectWorkerBoundaryError('invalid-request', 'Connect worker request must be JSON serializable.');
  }
  if (textEncoder.encode(serialized).byteLength > CONNECT_WORKER_MAX_REQUEST_BYTES) {
    throw new ConnectWorkerBoundaryError('invalid-request', 'Connect worker request exceeds its serialized size limit.');
  }

  const cloned = JSON.parse(serialized) as unknown;
  if (!isRecord(cloned)) {
    throw new ConnectWorkerBoundaryError('invalid-request', 'Connect worker request must be an object.');
  }
  const clonedRecord = cloned as Record<string, unknown>;

  try {
    assertConnectRequest(clonedRecord);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConnectWorkerBoundaryError('invalid-request', `Connect worker rejected an invalid opened request: ${reason}`);
  }

  return {
    digest  : createHash('sha256').update(serialized).digest('base64url'),
    request : clonedRecord,
  };
}

function normalizeHttpOrigin(origin: unknown, field: string): string {
  if (typeof origin !== 'string') {
    throw new ConnectWorkerBoundaryError('invalid-channel', `${field} must be an absolute HTTP(S) URL.`);
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ConnectWorkerBoundaryError('invalid-channel', `${field} must be an absolute HTTP(S) URL.`);
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === 'null') {
    throw new ConnectWorkerBoundaryError('invalid-channel', `${field} must use HTTP or HTTPS.`);
  }
  return url.origin;
}

function normalizeRelayRequestUri(requestUri: unknown): string {
  if (typeof requestUri !== 'string') {
    throw new ConnectWorkerBoundaryError('invalid-channel', 'Relay request URI must be an absolute HTTP(S) URL.');
  }
  let url: URL;
  try {
    url = new URL(requestUri);
  } catch {
    throw new ConnectWorkerBoundaryError('invalid-channel', 'Relay request URI must be an absolute HTTP(S) URL.');
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new ConnectWorkerBoundaryError(
      'invalid-channel',
      'Relay request URI must use HTTP(S) and must not contain credentials or a fragment.',
    );
  }
  return url.toString();
}

function channelBindingValue(channel: ConnectWorkerChannelBinding): string {
  return channel.kind === 'popup' ? `popup:${channel.dappOrigin}` : `relay:${channel.requestUri}`;
}

function validateContext(context: unknown): asserts context is ConnectWorkerRequestContext {
  if (!isRecord(context) || typeof context.principalId !== 'string' || context.principalId.length === 0 || context.principalId.length > 256) {
    throw new ConnectWorkerBoundaryError('invalid-context', 'Connect worker principal must be a non-empty bounded string.');
  }
}

function validateHandle(handle: unknown): asserts handle is ConnectWorkerSessionHandle {
  if (!isRecord(handle) ||
    typeof handle.binding !== 'string' || handle.binding.length === 0 || handle.binding.length > 256 ||
    !Number.isSafeInteger(handle.expiresAt) || (handle.expiresAt as number) < 0 ||
    typeof handle.id !== 'string' || handle.id.length === 0 || handle.id.length > 256 ||
    typeof handle.requestDigest !== 'string' || handle.requestDigest.length === 0 || handle.requestDigest.length > 256 ||
    typeof handle.workerInstanceId !== 'string' || handle.workerInstanceId.length === 0 || handle.workerInstanceId.length > 256) {
    throw new ConnectWorkerBoundaryError('invalid-session', 'Connect worker session is invalid.');
  }
}

/**
 * Ephemeral worker-side store for opened connect requests.
 *
 * Handles are authenticated with a per-process HMAC key and bound to the
 * authenticated caller, channel, request digest, expiry, and worker instance.
 * The request is copied at admission and never accepted again during approval,
 * so a consent action cannot replace the request that was displayed. Sessions
 * are one-shot and intentionally disappear on worker restart.
 */
export class ConnectWorkerSessionRegistry {
  private readonly _bindingKey = randomBytes(32);
  private readonly _maxPendingSessions: number;
  private readonly _now: () => number;
  private readonly _sessionTtlMs: number;
  private readonly _sessions = new Map<string, StoredConnectWorkerSession>();
  private readonly _workerInstanceId = randomBytes(16).toString('base64url');
  private _stopped = false;

  public constructor(options: ConnectWorkerSessionRegistryOptions = {}) {
    this._maxPendingSessions = options.maxPendingSessions ?? CONNECT_WORKER_MAX_PENDING_SESSIONS;
    this._now = options.now ?? Date.now;
    this._sessionTtlMs = options.sessionTtlMs ?? CONNECT_WORKER_SESSION_TTL_MS;

    if (!Number.isInteger(this._maxPendingSessions) || this._maxPendingSessions < 1) {
      throw new RangeError('Connect worker maximum pending sessions must be a positive integer.');
    }
    if (!Number.isInteger(this._sessionTtlMs) || this._sessionTtlMs < 1 || this._sessionTtlMs > CONNECT_WORKER_MAX_SESSION_TTL_MS) {
      throw new RangeError(`Connect worker session TTL must be between 1 and ${CONNECT_WORKER_MAX_SESSION_TTL_MS} milliseconds.`);
    }
  }

  /** Admits one already-opened request and returns its opaque worker capability. */
  public bind(params: BindConnectWorkerSessionParams): BoundConnectWorkerRequest {
    this.assertRunning();
    if (!isRecord(params)) {
      throw new ConnectWorkerBoundaryError('invalid-request', 'Connect worker binding parameters must be an object.');
    }
    validateContext(params.context);
    this.pruneExpired();
    if (this._sessions.size >= this._maxPendingSessions) {
      throw new ConnectWorkerBoundaryError('capacity-exceeded', 'Connect worker has reached its pending-session limit.');
    }

    const snapshot = cloneAndValidateRequest(params.request);
    const { channel, transport } = this.validateChannel(params.channel, snapshot.request, params.transport);
    const id = randomBytes(24).toString('base64url');
    const expiresAt = this._now() + this._sessionTtlMs;
    const unsignedHandle = {
      expiresAt,
      id,
      requestDigest    : snapshot.digest,
      workerInstanceId : this._workerInstanceId,
    };
    const binding = this.createBinding({
      ...unsignedHandle,
      channel,
      principalId: params.context.principalId,
      transport,
    });
    const handle: ConnectWorkerSessionHandle = Object.freeze({ ...unsignedHandle, binding });
    this._sessions.set(id, {
      channel,
      handle,
      principalId : params.context.principalId,
      request     : snapshot.request,
      transport,
    });

    return { handle, request: structuredClone(snapshot.request) };
  }

  /** Opens a direct-encrypted relay request and binds it without exporting the request key. */
  public async openRelayRequest(params: {
    context: ConnectWorkerRequestContext;
    jwe: string;
    requestKey: Uint8Array;
    requestUri: string;
  }): Promise<BoundConnectWorkerRequest> {
    if (!isRecord(params)) {
      throw new ConnectWorkerBoundaryError('invalid-request', 'Connect worker relay parameters must be an object.');
    }
    validateContext(params.context);
    if (typeof params.jwe !== 'string' || textEncoder.encode(params.jwe).byteLength > CONNECT_WORKER_MAX_JWE_BYTES) {
      throw new ConnectWorkerBoundaryError('invalid-request', 'Connect worker relay envelope is invalid or exceeds its size limit.');
    }
    if (!(params.requestKey instanceof Uint8Array) || params.requestKey.byteLength !== CONNECT_WORKER_REQUEST_KEY_BYTES) {
      throw new ConnectWorkerBoundaryError('invalid-request', 'Connect worker relay request key must be 32 bytes.');
    }
    const requestKey = Uint8Array.from(params.requestKey);
    try {
      const request = await ConnectProvider.openRequest({
        decryption : { mode: 'dir', requestKey },
        jwe        : params.jwe,
      });
      return this.bind({
        channel   : { kind: 'relay', requestUri: params.requestUri },
        context   : params.context,
        request,
        transport : 'relay',
      });
    } finally {
      requestKey.fill(0);
    }
  }

  /** Atomically consumes a session before approval side effects begin. */
  public claimForApproval(
    context: ConnectWorkerRequestContext,
    handle: ConnectWorkerSessionHandle,
  ): ClaimedConnectWorkerSession {
    return this.consume(context, handle);
  }

  /** Consumes a session as an explicit denial and returns the kernel deny token. */
  public deny(context: ConnectWorkerRequestContext, handle: ConnectWorkerSessionHandle): string {
    this.consume(context, handle);
    return ConnectProvider.denyToken();
  }

  /** Consumes a session without producing any protocol response. */
  public cancel(context: ConnectWorkerRequestContext, handle: ConnectWorkerSessionHandle): void {
    this.consume(context, handle);
  }

  /** Invalidates every handle and erases the worker's binding key. Idempotent. */
  public stop(): void {
    if (this._stopped) { return; }
    this._stopped = true;
    this._sessions.clear();
    this._bindingKey.fill(0);
  }

  private assertRunning(): void {
    if (this._stopped) {
      throw new ConnectWorkerBoundaryError('worker-stopped', 'Connect worker has stopped.');
    }
  }

  private consume(
    context: ConnectWorkerRequestContext,
    handle: ConnectWorkerSessionHandle,
  ): ClaimedConnectWorkerSession {
    this.assertRunning();
    validateContext(context);
    validateHandle(handle);
    const session = this._sessions.get(handle.id);
    if (session === undefined || !this.isAuthenticHandle(context, handle, session)) {
      throw new ConnectWorkerBoundaryError('invalid-session', 'Connect worker session is invalid.');
    }

    this._sessions.delete(handle.id);
    if (this._now() >= session.handle.expiresAt) {
      throw new ConnectWorkerBoundaryError('session-expired', 'Connect worker session has expired.');
    }

    return {
      channel   : session.channel,
      request   : session.request,
      transport : session.transport,
    };
  }

  private createBinding(params: {
    channel: ConnectWorkerChannelBinding;
    expiresAt: number;
    id: string;
    principalId: string;
    requestDigest: string;
    transport: ConnectSessionTransport;
    workerInstanceId: string;
  }): string {
    return createHmac('sha256', this._bindingKey).update(JSON.stringify([
      params.workerInstanceId,
      params.id,
      params.expiresAt,
      params.requestDigest,
      params.principalId,
      params.transport,
      channelBindingValue(params.channel),
    ])).digest('base64url');
  }

  private isAuthenticHandle(
    context: ConnectWorkerRequestContext,
    handle: ConnectWorkerSessionHandle,
    session: StoredConnectWorkerSession,
  ): boolean {
    if (handle.workerInstanceId !== this._workerInstanceId || handle.id !== session.handle.id) {
      return false;
    }

    const expected = this.createBinding({
      channel          : session.channel,
      expiresAt        : handle.expiresAt,
      id               : handle.id,
      principalId      : context.principalId,
      requestDigest    : handle.requestDigest,
      transport        : session.transport,
      workerInstanceId : handle.workerInstanceId,
    });

    let actualBytes: Buffer;
    let expectedBytes: Buffer;
    try {
      actualBytes = Buffer.from(handle.binding, 'base64url');
      expectedBytes = Buffer.from(expected, 'base64url');
    } catch {
      return false;
    }

    return handle.expiresAt === session.handle.expiresAt &&
      handle.requestDigest === session.handle.requestDigest &&
      context.principalId === session.principalId &&
      actualBytes.length === expectedBytes.length &&
      timingSafeEqual(actualBytes, expectedBytes);
  }

  private pruneExpired(): void {
    const now = this._now();
    for (const [id, session] of this._sessions) {
      if (now >= session.handle.expiresAt) {
        this._sessions.delete(id);
      }
    }
  }

  private validateChannel(
    channel: unknown,
    request: ConnectRequest,
    transport: unknown,
  ): { channel: ConnectWorkerChannelBinding; transport: ConnectSessionTransport } {
    if (!isRecord(channel)) {
      throw new ConnectWorkerBoundaryError('invalid-channel', 'Connect worker channel binding must be an object.');
    }
    if (channel.kind === 'popup') {
      if (transport !== 'postMessage' || request.reply.mode !== 'post_message') {
        throw new ConnectWorkerBoundaryError('invalid-channel', 'Popup sessions require a postMessage connect request.');
      }
      const dappOrigin = normalizeHttpOrigin(channel.dappOrigin, 'Dapp origin');
      const claimedOrigin = normalizeHttpOrigin(request.clientMetadata?.origin, 'Request client origin');
      if (claimedOrigin !== dappOrigin) {
        throw new ConnectWorkerBoundaryError('invalid-channel', 'Authenticated popup origin does not match the signed request origin.');
      }
      return {
        channel: { kind: 'popup', dappOrigin },
        transport,
      };
    }

    if (channel.kind !== 'relay') {
      throw new ConnectWorkerBoundaryError('invalid-channel', 'Connect worker channel kind must be popup or relay.');
    }
    if (transport !== 'relay' || request.reply.mode !== 'direct_post') {
      throw new ConnectWorkerBoundaryError('invalid-channel', 'Relay sessions require a direct_post connect request.');
    }
    const requestUri = normalizeRelayRequestUri(channel.requestUri);
    const callbackOrigin = normalizeHttpOrigin(request.reply.callbackUrl, 'Relay callback URL');
    if (new URL(requestUri).origin !== callbackOrigin) {
      throw new ConnectWorkerBoundaryError('invalid-channel', 'Relay callback origin must match the claimed request origin.');
    }
    return { channel: { kind: 'relay', requestUri }, transport };
  }
}

/**
 * Narrow page-facing API for one wallet worker.
 *
 * This class deliberately offers only request admission, approval, denial,
 * cancellation, and shutdown. It never returns the worker agent, response
 * signer, wallet private keys, relay request key, or arbitrary signatures.
 */
export class ConnectWorkerBoundary {
  private readonly _agent: ExecuteConnectApprovalParams['agent'];
  private readonly _sessions: ConnectWorkerSessionRegistry;

  public constructor(options: ConnectWorkerSessionRegistryOptions & {
    agent: ExecuteConnectApprovalParams['agent'];
  }) {
    this._agent = options.agent;
    this._sessions = new ConnectWorkerSessionRegistry(options);
  }

  /** Binds a request opened by `WalletPostMessageTransport` in the provider page. */
  public bindPopupRequest(params: {
    context: ConnectWorkerRequestContext;
    dappOrigin: string;
    request: ConnectRequest;
  }): BoundConnectWorkerRequest {
    return this._sessions.bind({
      channel   : { kind: 'popup', dappOrigin: params.dappOrigin },
      context   : params.context,
      request   : params.request,
      transport : 'postMessage',
    });
  }

  /** Opens and binds a relay request inside the wallet worker. */
  public async openRelayRequest(params: {
    context: ConnectWorkerRequestContext;
    jwe: string;
    requestKey: Uint8Array;
    requestUri: string;
  }): Promise<BoundConnectWorkerRequest> {
    return await this._sessions.openRelayRequest(params);
  }

  /** Runs the real wallet approval ceremony and returns only its sealed response. */
  public async approve(
    context: ConnectWorkerRequestContext,
    params: ConnectWorkerApprovalParams,
  ): Promise<string> {
    const session = this._sessions.claimForApproval(context, params.handle);
    if (session.transport === 'relay' && (params.pin === undefined || params.pin.length === 0)) {
      throw new ConnectWorkerBoundaryError('invalid-channel', 'Relay approval requires the pairing PIN.');
    }
    if (session.transport === 'postMessage' && params.pin !== undefined) {
      throw new ConnectWorkerBoundaryError('invalid-channel', 'Popup approval must not carry a relay PIN.');
    }

    const approvalResult = await executeConnectApproval({
      agent                     : this._agent,
      approvedProtocolOverrides : params.approvedProtocolOverrides,
      approvedSessionTtlSeconds : params.approvedSessionTtlSeconds,
      providerDid               : params.providerDid,
      request                   : session.request,
      transport                 : session.transport,
    });
    const { responseSigner, ...approval } = approvalResult;
    return await ConnectProvider.sealApprovedResponse({
      approval,
      pin         : params.pin,
      providerDid : params.providerDid,
      request     : session.request,
      signer      : responseSigner,
    });
  }

  /** Invalidates a pending request and returns the kernel's opaque denial token. */
  public deny(context: ConnectWorkerRequestContext, handle: ConnectWorkerSessionHandle): string {
    return this._sessions.deny(context, handle);
  }

  /** Invalidates a pending request without emitting a protocol response. */
  public cancel(context: ConnectWorkerRequestContext, handle: ConnectWorkerSessionHandle): void {
    this._sessions.cancel(context, handle);
  }

  /** Invalidates all pending sessions during worker shutdown. */
  public stop(): void {
    this._sessions.stop();
  }
}
