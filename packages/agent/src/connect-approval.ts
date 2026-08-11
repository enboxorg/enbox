/**
 * Enbox Connect approval ceremony.
 *
 * The single wallet-side approval ceremony shared by every connect transport
 * (relay/QR/deep-link, popup postMessage): delegate minting or pre-supplied
 * delegate validation, per-protocol preparation (install or encryption
 * upgrade with fail-closed remote verification — see
 * `./connect-protocol-preparation.ts`), permission grant creation with scope
 * guards and session metadata, durable grantKey delivery for encrypted read
 * scopes, and per-grant contextId-scoped revocation grants.
 *
 * The ceremony is transport-agnostic — no envelope, relay, or postMessage
 * code lives here. {@link executeConnectApproval} returns the
 * `ConnectApproval` shape that the `@enbox/connect` kernel seals into a
 * response envelope (`ConnectProvider.sealApprovedResponse`) for whichever
 * channel carried the request.
 */

import type { EnboxPlatformAgent } from './types/agent.js';
import type { PrivateKeyJwk } from '@enbox/crypto';
import type { BearerDid, PortableDid } from '@enbox/dids';
import type { ConnectApproval, ConnectClientMetadata, ConnectPermissionRequest, ConnectRequest, SessionRevocation } from '@enbox/connect';
import type { ConnectSessionMetadata, ConnectSessionTransport, DwnDataEncodedRecordsWriteMessage, DwnPermissionScope, DwnRecordsPermissionScope } from './types/dwn.js';

import { Ed25519 } from '@enbox/crypto';
import { randomToken } from '@enbox/connect';
import { Convert, logger, nowMs, timed } from '@enbox/common';
import { Did, DidJwk } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName, PermissionsProtocol, Time } from '@enbox/dwn-sdk-js';

import { AgentPermissionsApi } from './permissions-api.js';
import {
  createGrantKeyRecordsForGrants,
  getEncryptionKeyInfo,
} from './dwn-encryption.js';
import { hasEncryptedProtocolTypes, prepareProtocol } from './connect-protocol-preparation.js';
import { isMessagesPermissionScope, isRecordPermissionScope } from './dwn-api.js';
import { mapConcurrent, mapConcurrentSettled } from './utils.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Maximum fan-out concurrency used by the connect approval ceremony.
 * Permission grants use this as the endpoint concurrency while sending
 * sequentially within each endpoint; the other fan-outs use it as their
 * total request concurrency.
 */
const CONNECT_FANOUT_CONCURRENCY = 8;

/**
 * Per-request abort budget applied to every DWN-endpoint `sendDwnRequest`
 * issued during the connect flow. The HttpDwnRpcClient's default per-attempt
 * timeout is 30 s with 3 retries (~120 s worst-case per request) — that
 * scales unacceptably when bounded fan-out has to wait for every settled
 * task. With this budget, an unhealthy / cold endpoint short-circuits the
 * retry loop within a few seconds (AbortError is non-retryable), keeping
 * the user-visible "Authorizing…" wait bounded even when one of N DWN
 * endpoints is misbehaving.
 *
 * Best-effort fan-outs tolerate per-task failure because sync delivers missed
 * copies eventually. Required permission-grant delivery combines this with a
 * separate whole-batch deadline and verifies every grant was accepted.
 */
const CONNECT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Whole-batch budget for required permission-grant delivery. Permission
 * grants are sent sequentially per endpoint because a DWN serializes writes
 * for the same tenant. This bound prevents a consistently slow endpoint from
 * extending approval time once individual requests have started succeeding.
 */
const CONNECT_PERMISSION_GRANT_BATCH_TIMEOUT_MS = 20_000;

/** Log namespace used for wallet-side connect critical-path timings. */
const CONNECT_PERF_LOG_PREFIX = '[connect.perf]';

/**
 * Default lifetime for app delegate grants created by a connect approval.
 *
 * This is a hard grant expiry. Clients can renew an existing delegate through
 * a refresh approval before or after the grants expire.
 */
export const CONNECT_SESSION_DEFAULT_TTL_SECONDS = 60 * 60;

/** Maximum lifetime a wallet will stamp onto connect session grants. */
export const CONNECT_SESSION_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

const CONNECT_SESSION_METADATA_LIMITS = {
  id            : 128,
  applicationId : 512,
  appName       : 128,
  appIcon       : 2048,
  origin        : 512,
  userAgent     : 512,
  platform      : 128,
  language      : 64,
  languages     : 16,
  timezone      : 128,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link createConnectSessionMetadata}. */
export type CreateConnectSessionMetadataOptions = {
  id?: string;
  applicationId?: string;
  appName?: string;
  appIcon?: string;
  clientMetadata?: ConnectClientMetadata;
  transport?: ConnectSessionTransport;
  ttlSeconds?: number;
};

/**
 * The approved connect request fields consumed by the ceremony. A kernel
 * {@link ConnectRequest} (as returned by `ConnectProvider.openRequest`) is
 * assignable to this shape.
 */
export type ConnectApprovalRequest = Pick<
  ConnectRequest,
  | 'appName'
  | 'appIcon'
  | 'applicationId'
  | 'clientMetadata'
  | 'permissionRequests'
  | 'requestedSessionTtlSeconds'
  | 'delegateDid'
  | 'expectedProviderDid'
>;

/** Parameters for {@link executeConnectApproval}. */
export type ExecuteConnectApprovalParams = {
  /** The agent used for DWN operations and key management. */
  agent: EnboxPlatformAgent;

  /** The wallet owner's DID that is granting access. */
  providerDid: string;

  /** The approved connect request. */
  request: ConnectApprovalRequest;

  /** Transport recorded in the grant session metadata. */
  transport: ConnectSessionTransport;

  /**
   * Provider-selected session lifetime in seconds. When present, this wins
   * over the requester's advisory `requestedSessionTtlSeconds`.
   */
  approvedSessionTtlSeconds?: number;
};

/**
 * Result of {@link executeConnectApproval}: the kernel `ConnectApproval`
 * shape plus the response signing DID minted during the ceremony.
 */
export type ConnectApprovalResult = ConnectApproval & {
  /**
   * The DID that signs the connect response JWT: the minted delegate for
   * wallet-minted sessions, or a fresh `did:jwk` when the request supplied
   * its own delegate DID. Pass as `signer` to the kernel's
   * `ConnectProvider.sealApprovedResponse`.
   */
  responseSigner: BearerDid;
};

// ---------------------------------------------------------------------------
// Session metadata
// ---------------------------------------------------------------------------

function boundedSessionString(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  return value.slice(0, maxLength);
}

function boundedSessionStringArray(values: string[] | undefined): string[] | undefined {
  if (!Array.isArray(values)) {
    return undefined;
  }

  const bounded = values
    .filter((value) => typeof value === 'string' && value.length > 0)
    .slice(0, CONNECT_SESSION_METADATA_LIMITS.languages)
    .map((value) => value.slice(0, CONNECT_SESSION_METADATA_LIMITS.language));

  return bounded.length > 0 ? bounded : undefined;
}

/**
 * Builds the bounded {@link ConnectSessionMetadata} stamped onto every grant
 * created by a connect approval. All requester-supplied display fields are
 * length-limited so a hostile request cannot bloat grant records.
 */
export function createConnectSessionMetadata(
  options: CreateConnectSessionMetadataOptions = {},
): ConnectSessionMetadata {
  const createdAt = Time.getCurrentTimestamp();
  const expiresAt = Time.createOffsetTimestamp({
    seconds: options.ttlSeconds ?? CONNECT_SESSION_DEFAULT_TTL_SECONDS,
  }, createdAt);
  const clientMetadata = options.clientMetadata ?? {};
  const applicationId = boundedSessionString(
    options.applicationId,
    CONNECT_SESSION_METADATA_LIMITS.applicationId,
  );
  const appName = boundedSessionString(options.appName, CONNECT_SESSION_METADATA_LIMITS.appName);
  const appIcon = boundedSessionString(options.appIcon, CONNECT_SESSION_METADATA_LIMITS.appIcon);
  const origin = boundedSessionString(clientMetadata.origin, CONNECT_SESSION_METADATA_LIMITS.origin);
  const userAgent = boundedSessionString(clientMetadata.userAgent, CONNECT_SESSION_METADATA_LIMITS.userAgent);
  const platform = boundedSessionString(clientMetadata.platform, CONNECT_SESSION_METADATA_LIMITS.platform);
  const language = boundedSessionString(clientMetadata.language, CONNECT_SESSION_METADATA_LIMITS.language);
  const languages = boundedSessionStringArray(clientMetadata.languages);
  const timezone = boundedSessionString(clientMetadata.timezone, CONNECT_SESSION_METADATA_LIMITS.timezone);

  return {
    id: boundedSessionString(options.id, CONNECT_SESSION_METADATA_LIMITS.id) ?? randomToken(),
    createdAt,
    expiresAt,
    ...(applicationId ? { applicationId } : {}),
    ...(appName ? { appName } : {}),
    ...(appIcon ? { appIcon } : {}),
    ...(origin ? { origin } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(platform ? { platform } : {}),
    ...(language ? { language } : {}),
    ...(languages ? { languages } : {}),
    ...(timezone ? { timezone } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
  };
}

function resolveSessionTtlSeconds(params: {
  approvedSessionTtlSeconds?: number;
  requestedSessionTtlSeconds?: number;
}): number {
  const sessionTtlSeconds = params.approvedSessionTtlSeconds ?? params.requestedSessionTtlSeconds;
  if (sessionTtlSeconds === undefined) {
    return CONNECT_SESSION_DEFAULT_TTL_SECONDS;
  }

  const wholeSeconds = Math.floor(sessionTtlSeconds);
  const source = params.approvedSessionTtlSeconds === undefined ? 'requested' : 'approved';

  if (!Number.isFinite(sessionTtlSeconds) || wholeSeconds <= 0) {
    throw new Error(`Connect ${source}SessionTtlSeconds must resolve to at least one whole second.`);
  }

  return Math.min(
    wholeSeconds,
    CONNECT_SESSION_MAX_TTL_SECONDS,
  );
}

// ---------------------------------------------------------------------------
// Scope guards and request validation
// ---------------------------------------------------------------------------

function assertConnectGrantScope(scope: DwnPermissionScope): void {
  if (isRecordPermissionScope(scope)) {
    const method = scope.method as DwnMethodName;
    if (
      method === DwnMethodName.Query ||
      method === DwnMethodName.Subscribe ||
      method === DwnMethodName.Count
    ) {
      throw new Error(
        `Records.${method} grants are not supported by connect; request Records.Read instead.`
      );
    }
    return;
  }

  if (scope.interface === DwnInterfaceName.Protocols && scope.method === DwnMethodName.Configure) {
    throw new Error(
      'Protocols.Configure cannot be delegated through connect; the wallet configures protocols during approval.'
    );
  }
}

function isConnectReadScope(scope: DwnPermissionScope): scope is DwnRecordsPermissionScope {
  return isRecordPermissionScope(scope) && scope.method === DwnMethodName.Read;
}

function permissionRequestHasEncryptedReadScopes(permissionRequest: ConnectPermissionRequest): boolean {
  return hasEncryptedProtocolTypes(permissionRequest.protocolDefinition) &&
    permissionRequest.permissionScopes.some(isConnectReadScope);
}

function validatePermissionRequestProtocolUris(permissionRequests: ConnectPermissionRequest[]): void {
  for (const { protocolDefinition, permissionScopes } of permissionRequests) {
    const grantsMatchProtocolUri = permissionScopes.every(
      scope => 'protocol' in scope && scope.protocol === protocolDefinition.protocol
    );
    if (!grantsMatchProtocolUri) {
      throw new Error('All permission scopes must match the protocol URI they are provided with.');
    }
  }
}

/**
 * Orders protocol preparation so that a protocol's in-batch composition
 * dependencies are prepared before it.
 *
 * A composing protocol declares its dependencies via `uses` (e.g. a board
 * protocol uses a membership protocol for a `membership:participant` role). The DWN `ProtocolsConfigure`
 * handler rejects a configure whose `uses` targets are not yet installed for
 * the tenant, so preparing every requested protocol in a single flat
 * concurrent fan-out races a composing protocol against its dependency: on a
 * fresh identity the dependent's configure can land before its `uses` target
 * is installed, get rejected, and fail the fail-closed remote convergence
 * check — aborting the whole connect.
 *
 * This returns dependency "levels": every request in a level has all of its
 * in-batch `uses` targets in an earlier level, and requests within a level are
 * independent and may be prepared concurrently. Callers prepare one level at a
 * time, awaiting each before starting the next.
 *
 * `uses` targets that are not part of this batch are ignored — installing them
 * is the caller's responsibility and they must already exist on the owner's
 * DWNs. Cycles (which the DWN would reject anyway) are broken by emitting the
 * remaining requests as a final level rather than looping forever, preserving
 * the previous best-effort behavior for that degenerate case.
 */
export function orderPermissionRequestsByUsesDependencies(
  permissionRequests: ConnectPermissionRequest[],
): ConnectPermissionRequest[][] {
  const inBatchProtocolUris = new Set(
    permissionRequests.map((request) => request.protocolDefinition.protocol),
  );

  const inBatchDependenciesOf = (request: ConnectPermissionRequest): string[] => {
    const uses = request.protocolDefinition.uses ?? {};
    return Object.values(uses).filter(
      (targetUri): targetUri is string =>
        typeof targetUri === 'string'
        && targetUri !== request.protocolDefinition.protocol
        && inBatchProtocolUris.has(targetUri),
    );
  };

  const remaining = new Set(permissionRequests);
  const preparedProtocolUris = new Set<string>();
  const levels: ConnectPermissionRequest[][] = [];

  while (remaining.size > 0) {
    const level = [...remaining].filter((request) =>
      inBatchDependenciesOf(request).every((targetUri) => preparedProtocolUris.has(targetUri)),
    );

    if (level.length === 0) {
      // Unsatisfiable dependency or cycle: emit the rest together and let the
      // downstream fail-closed verification surface the real conflict.
      levels.push([...remaining]);
      break;
    }

    for (const request of level) {
      remaining.delete(request);
      preparedProtocolUris.add(request.protocolDefinition.protocol);
    }
    levels.push(level);
  }

  return levels;
}

function resolvePreSuppliedDelegateDid(delegateDid: string | undefined): string | undefined {
  if (delegateDid === undefined) {
    return undefined;
  }

  const parsedDelegateDid = Did.parse(delegateDid);
  if (parsedDelegateDid === null || parsedDelegateDid.uri !== delegateDid) {
    throw new Error('Connect delegateDid must be a valid DID URI.');
  }

  return delegateDid;
}

// ---------------------------------------------------------------------------
// Delegate DID key material
// ---------------------------------------------------------------------------

/**
 * Ensures a delegate `did:jwk` PortableDid carries the X25519 private key that
 * DWN record-level encryption needs for key agreement, deriving it from the
 * DID's Ed25519 private key when absent.
 *
 * `did:jwk` exposes a single verification method, so the derived X25519 key is
 * appended to `privateKeys` (existing keys and their order are preserved) and
 * returned alongside the augmented PortableDid. The wallet mint path uses the
 * returned key as the grantee root private key for grantKey wrapping; auth's
 * pre-supplied delegate path only needs the augmented PortableDid.
 *
 * @throws Error when the PortableDid has no private keys, or none is Ed25519.
 */
export async function ensureDelegateX25519PrivateKey(
  portableDid: PortableDid,
): Promise<{ portableDid: PortableDid; x25519PrivateKey: PrivateKeyJwk }> {
  const privateKeys = [...(portableDid.privateKeys ?? [])];
  if (privateKeys.length === 0) {
    throw new Error('Delegate portable DID must include private keys.');
  }

  const edPrivateKey = privateKeys.find((key) => key.crv === 'Ed25519');
  if (edPrivateKey === undefined) {
    throw new Error('Delegate portable DID must include an Ed25519 private key.');
  }

  let x25519PrivateKey = privateKeys.find((key) => key.crv === 'X25519') as PrivateKeyJwk | undefined;
  if (x25519PrivateKey === undefined) {
    x25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
      privateKey: edPrivateKey as PrivateKeyJwk,
    }) as PrivateKeyJwk;
    privateKeys.push(x25519PrivateKey);
  }

  return { portableDid: { ...portableDid, privateKeys }, x25519PrivateKey };
}

// ---------------------------------------------------------------------------
// Permission grants
// ---------------------------------------------------------------------------

/**
 * Creates permission grants that assign the requested scopes to a delegate
 * DID, stores them locally, and delivers each grant to every owner DWN
 * endpoint. Each grant must be accepted (202 or 409) by at least one
 * endpoint; otherwise the approval fails.
 */
export async function createPermissionGrants(
  selectedDid: string,
  delegateDid: string,
  agent: EnboxPlatformAgent,
  scopes: DwnPermissionScope[],
  connectSession?: ConnectSessionMetadata,
): Promise<DwnDataEncodedRecordsWriteMessage[]> {
  const permissionsApi = new AgentPermissionsApi({ agent });
  const session = connectSession ?? createConnectSessionMetadata();
  const dateExpires = session.expiresAt;

  logger.log(`Creating permission grants for ${scopes.length} scopes...`);
  for (const scope of scopes) {
    assertConnectGrantScope(scope);
  }

  // Resolve before creating local grants so an unusable or unavailable DID
  // document fails the approval without leaving undeliverable grant records.
  const dwnEndpointUrls = await agent.dwn.getRemoteDwnEndpointUrls(selectedDid);

  const permissionGrants = await Promise.all(
    scopes.map((scope) => permissionsApi.createGrant({
      delegated      : isRecordPermissionScope(scope) || isMessagesPermissionScope(scope),
      store          : true,
      grantedTo      : delegateDid,
      scope,
      dateExpires,
      author         : selectedDid,
      connectSession : session,
    }))
  );

  // Resolve all DWN endpoints for the selected DID.  `sendDwnRequest` only
  // sends to the first reachable endpoint, but the sync engine may connect
  // to a different one and needs the grant to authenticate.  We send each
  // grant to every endpoint so that sync works regardless of which DWN the
  // agent contacts first.
  logger.log(`Sending ${permissionGrants.length} permission grants to ${dwnEndpointUrls.length} DWN endpoint(s)...`);

  const batchSignal = AbortSignal.timeout(CONNECT_PERMISSION_GRANT_BATCH_TIMEOUT_MS);
  const outcomesByEndpoint = await mapConcurrent(
    dwnEndpointUrls,
    CONNECT_FANOUT_CONCURRENCY,
    async (dwnUrl) => {
      const outcomes: PermissionGrantSendOutcome[] = [];

      // SQL-backed DWNs serialize same-tenant writes to assign replication
      // positions. Keep one active write per endpoint so requests do not
      // consume their timeout while queued behind sibling grants.
      for (let grantIndex = 0; grantIndex < permissionGrants.length; grantIndex++) {
        if (batchSignal.aborted) {
          appendSkippedGrantOutcomes(outcomes, grantIndex, permissionGrants.length, dwnUrl, 'the grant batch timed out');
          break;
        }

        const { encodedData, ...rawMessage } = permissionGrants[grantIndex].message;
        const data = Convert.base64Url(encodedData).toUint8Array();
        const requestSignal = AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS);
        try {
          const reply = await agent.rpc.sendDwnRequest({
            dwnUrl,
            targetDid : selectedDid,
            message   : rawMessage,
            data      : new Blob([data as BlobPart]),
            signal    : AbortSignal.any([batchSignal, requestSignal]),
          });
          const accepted = reply.status.code === 202 || reply.status.code === 409;
          outcomes.push({
            accepted,
            detail: `returned ${reply.status.code}: ${reply.status.detail}`,
            dwnUrl,
            grantIndex,
          });
        } catch (reason) {
          const requestTimeoutDetail = requestSignal.aborted
            ? `permission grant request timed out after ${CONNECT_REQUEST_TIMEOUT_MS}ms`
            : errorDetail(reason);
          const detail = batchSignal.aborted
            ? `permission grant batch timed out after ${CONNECT_PERMISSION_GRANT_BATCH_TIMEOUT_MS}ms`
            : requestTimeoutDetail;
          outcomes.push({
            accepted : false,
            detail   : `failed: ${detail}`,
            dwnUrl,
            grantIndex,
          });
        }
      }

      return outcomes;
    },
  );
  const outcomes = outcomesByEndpoint.flat();

  // Aggregate results back per grant: each grant must have at least one
  // endpoint accept it (status 202 or 409 — already-stored is acceptable).
  const successPerGrant = new Array<boolean>(permissionGrants.length).fill(false);
  for (const outcome of outcomes) {
    if (outcome.accepted) {
      successPerGrant[outcome.grantIndex] = true;
      continue;
    }
    logger.error(`Grant send to ${outcome.dwnUrl} ${outcome.detail}`);
  }

  for (let g = 0; g < permissionGrants.length; g++) {
    if (!successPerGrant[g]) {
      const scope = describePermissionScope(scopes[g]);
      const failures = outcomes
        .filter((outcome) => outcome.grantIndex === g && !outcome.accepted)
        .map((outcome) => `${outcome.dwnUrl} ${outcome.detail}`);
      const displayedFailures = failures.slice(0, 3).join('; ');
      const remainingFailureCount = failures.length - 3;
      const remainingFailureSummary = remainingFailureCount > 0
        ? `${displayedFailures}; ${remainingFailureCount} more endpoint(s) failed`
        : displayedFailures;
      throw new Error(
        `Could not send permission grant to any DWN endpoint: grant ${g + 1} (${scope}); ${remainingFailureSummary}`,
      );
    }
  }

  return permissionGrants.map((g) => g.message);
}

type PermissionGrantSendOutcome = {
  accepted : boolean;
  detail : string;
  dwnUrl : string;
  grantIndex : number;
};

/** A single revocation-grant delivery to one owner DWN endpoint. */
type RevocationSendTask = {
  revRawMessage : Omit<DwnDataEncodedRecordsWriteMessage, 'encodedData'>;
  revData : Uint8Array;
  dwnUrl : string;
};

function appendSkippedGrantOutcomes(
  outcomes: PermissionGrantSendOutcome[],
  startIndex: number,
  grantCount: number,
  dwnUrl: string,
  reason: string,
): void {
  for (let grantIndex = startIndex; grantIndex < grantCount; grantIndex++) {
    outcomes.push({
      accepted : false,
      detail   : `was not attempted because ${reason}`,
      dwnUrl,
      grantIndex,
    });
  }
}

function describePermissionScope(scope: DwnPermissionScope): string {
  const protocol = 'protocol' in scope ? scope.protocol : undefined;
  const protocolPath = 'protocolPath' in scope ? scope.protocolPath : undefined;
  return [
    `${scope.interface}.${scope.method}`,
    typeof protocol === 'string' ? `protocol ${protocol}` : undefined,
    typeof protocolPath === 'string' ? `path ${protocolPath}` : undefined,
  ].filter((part): part is string => part !== undefined).join(', ');
}

function errorDetail(reason: unknown): string {
  return reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
}

async function fanOutDataEncodedRecords(
  ownerDid: string,
  agent: EnboxPlatformAgent,
  records: DwnDataEncodedRecordsWriteMessage[],
): Promise<void> {
  if (records.length === 0) {
    return;
  }

  const dwnEndpointUrls = await agent.dwn.getRemoteDwnEndpointUrls(ownerDid);
  const sendTasks = records.flatMap((record, recordIndex) => {
    const { encodedData, ...rawMessage } = record;
    const data = Convert.base64Url(encodedData).toUint8Array();
    return dwnEndpointUrls.map((dwnUrl) => ({ recordIndex, dwnUrl, rawMessage, data }));
  });

  const settled = await mapConcurrentSettled(
    sendTasks,
    CONNECT_FANOUT_CONCURRENCY,
    async ({ recordIndex, dwnUrl, rawMessage, data }) => {
      const reply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : ownerDid,
        message   : rawMessage,
        data      : new Blob([data as BlobPart]),
        signal    : AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS),
      });
      return { recordIndex, dwnUrl, reply };
    },
  );

  const successPerRecord = new Array<boolean>(records.length).fill(false);
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'rejected') {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error(`Record send to ${sendTasks[i].dwnUrl} failed: ${reason}`);
      continue;
    }

    const { recordIndex, dwnUrl, reply } = result.value;
    if (reply.status.code === 202 || reply.status.code === 409) {
      successPerRecord[recordIndex] = true;
    } else {
      logger.error(`Record send to ${dwnUrl} returned ${reply.status.code}: ${reply.status.detail}`);
    }
  }

  for (const success of successPerRecord) {
    if (!success) {
      throw new Error('Could not send grantKey record to any DWN endpoint.');
    }
  }
}

// ---------------------------------------------------------------------------
// Ceremony collaborators (stubbable seam)
// ---------------------------------------------------------------------------

/**
 * Grant-construction collaborators invoked by {@link executeConnectApproval}
 * through this object so tests can isolate the ceremony orchestration from
 * grant/grantKey construction (which requires a fully provisioned DWN + KMS).
 */
export const ConnectCeremony = {
  createGrantKeyRecordsForGrants,
  createPermissionGrants,
};

// ---------------------------------------------------------------------------
// Approval ceremony
// ---------------------------------------------------------------------------

/**
 * Executes the wallet-side connect approval ceremony:
 *
 * 1. Enforces the expected wallet profile, when the requester supplied one.
 * 2. Uses a requester-supplied delegate DID, or mints one (did:jwk with the
 *    derived X25519 private key appended) when omitted.
 * 3. Applies the provider-approved session TTL and builds the session metadata.
 * 4. Prepares each requested protocol on the owner's DWNs: install or
 *    encryption upgrade with fail-closed conflict detection and remote
 *    convergence verification.
 * 5. Creates permission grants (scope guards enforced) and delivers them to
 *    every owner DWN endpoint.
 * 6. Creates and fans out durable grantKey records for encrypted read scopes.
 * 7. Creates per-grant contextId-scoped revocation grants and fans them out.
 *
 * @param params - The approval parameters.
 * @returns The `ConnectApproval` consumed by the kernel's
 *          `ConnectProvider.sealApprovedResponse`, plus the response signer.
 * @throws Error when the request is invalid or required grant delivery fails.
 */
export async function executeConnectApproval(params: ExecuteConnectApprovalParams): Promise<ConnectApprovalResult> {
  const { agent, providerDid, request } = params;
  if (request.expectedProviderDid !== undefined && request.expectedProviderDid !== providerDid) {
    throw new Error(
      `Connect expected wallet profile '${request.expectedProviderDid}', but '${providerDid}' was selected.`
    );
  }

  const approvalStart = nowMs();
  const numProtocols = request.permissionRequests.length;
  const numScopes = request.permissionRequests.reduce(
    (sum, permissionRequest) => sum + permissionRequest.permissionScopes.length,
    0,
  );
  // Tracked across the try/finally so the aggregate `executeConnectApproval.total`
  // log emits on both success and failure paths — operators bisecting wall-time
  // from wallet debug logs need the total even when a phase throws.
  let sessionGrantCount = 0;
  let outcome: 'ok' | 'fail' = 'ok';
  logger.log(
    `${CONNECT_PERF_LOG_PREFIX} executeConnectApproval.start `
    + `(protocols=${numProtocols}, scopes=${numScopes})`,
  );

  try {
    const sessionTtlSeconds = resolveSessionTtlSeconds({
      approvedSessionTtlSeconds  : params.approvedSessionTtlSeconds,
      requestedSessionTtlSeconds : request.requestedSessionTtlSeconds,
    });
    const preSuppliedDelegateDid = resolvePreSuppliedDelegateDid(request.delegateDid);

    let delegatePortableDid: PortableDid | undefined;
    let delegateRootPrivateKey: PrivateKeyJwk | undefined;
    let responseSigner: BearerDid;
    let grantedDelegateDid: string;

    if (preSuppliedDelegateDid !== undefined) {
      grantedDelegateDid = preSuppliedDelegateDid;
      responseSigner = await timed(`${CONNECT_PERF_LOG_PREFIX} responseDid.create`, () => DidJwk.create());
    } else {
      const delegateBearerDid = await timed(`${CONNECT_PERF_LOG_PREFIX} delegateDid.create`, () => DidJwk.create());

      // did:jwk only supports one verification method, but DWN encryption
      // requires an X25519 key-agreement key. Appending the derived X25519
      // private key to the PortableDid ensures the delegate agent's KMS has
      // both keys after import; the derived key is also used to wrap grantKeys
      // for encrypted read scopes.
      const ensured = await ensureDelegateX25519PrivateKey(await delegateBearerDid.export());
      delegatePortableDid = ensured.portableDid;
      delegateRootPrivateKey = ensured.x25519PrivateKey;
      responseSigner = delegateBearerDid;
      grantedDelegateDid = delegateBearerDid.uri;
    }

    validatePermissionRequestProtocolUris(request.permissionRequests);

    const preSuppliedDelegateRootPublicKey = preSuppliedDelegateDid !== undefined &&
      request.permissionRequests.some(permissionRequestHasEncryptedReadScopes)
      ? (await timed(
        `${CONNECT_PERF_LOG_PREFIX} delegateDid.encryptionKey.resolve`,
        () => getEncryptionKeyInfo(agent, grantedDelegateDid),
      )).publicKeyJwk
      : undefined;

    const connectSession = createConnectSessionMetadata({
      applicationId  : request.applicationId,
      appName        : request.appName,
      appIcon        : request.appIcon,
      ttlSeconds     : sessionTtlSeconds,
      clientMetadata : request.clientMetadata,
      transport      : params.transport,
    });

    const grantSetup = await timed(
      `${CONNECT_PERF_LOG_PREFIX} permissionGrants.fanout (protocols=${numProtocols})`,
      async () => {
        // Prepare in `uses`-dependency order: a composing protocol's configure
        // is rejected by the DWN unless its `uses` targets are already
        // installed, so dependencies must fully converge (across all endpoints)
        // before their dependents fan out. Independent protocols within a level
        // are still prepared concurrently.
        for (const level of orderPermissionRequestsByUsesDependencies(request.permissionRequests)) {
          await Promise.all(level.map(
            ({ protocolDefinition }) => prepareProtocol(providerDid, agent, protocolDefinition)
          ));
        }

        const permissionScopes = request.permissionRequests.flatMap((permissionRequest) => permissionRequest.permissionScopes);
        const createdGrants = await ConnectCeremony.createPermissionGrants(
          providerDid,
          grantedDelegateDid,
          agent,
          permissionScopes,
          connectSession,
        );

        let grantOffset = 0;
        const requestsWithGrants = request.permissionRequests.map((permissionRequest) => {
          const nextGrantOffset = grantOffset + permissionRequest.permissionScopes.length;
          const grants = createdGrants.slice(grantOffset, nextGrantOffset);
          grantOffset = nextGrantOffset;
          return { grants, permissionRequest };
        });

        const durableGrantKeyRecords = (await Promise.all(requestsWithGrants.map(
          async ({ grants, permissionRequest }) => {
            if (!permissionRequestHasEncryptedReadScopes(permissionRequest)) {
              return [];
            }

            return ConnectCeremony.createGrantKeyRecordsForGrants({
              agent,
              ownerDid   : providerDid,
              granteeDid : grantedDelegateDid,
              ...(delegateRootPrivateKey !== undefined
                ? { granteeRootPrivateKey: delegateRootPrivateKey }
                : { granteeRootPublicKey: preSuppliedDelegateRootPublicKey }),
              grantMessages       : grants,
              protocolDefinitions : [permissionRequest.protocolDefinition],
            });
          }
        ))).flat();

        return { createdGrants, durableGrantKeyRecords };
      },
    );
    const { createdGrants, durableGrantKeyRecords } = grantSetup;

    await timed(
      `${CONNECT_PERF_LOG_PREFIX} grantKeys.fanout (n=${durableGrantKeyRecords.length})`,
      () => fanOutDataEncodedRecords(providerDid, agent, durableGrantKeyRecords),
    );

    // Create per-grant contextId-scoped revocation grants.
    // Each revocation grant authorizes the delegate to write a revocation
    // ONLY for the specific session grant it corresponds to.
    const permissionsApi = new AgentPermissionsApi({ agent });
    let revGrantEndpoints: string[] = [];
    try {
      revGrantEndpoints = await agent.dwn.getRemoteDwnEndpointUrls(providerDid);
    } catch {
      // Endpoint resolution failure — revocation grants will be local-only until sync.
    }

    sessionGrantCount = createdGrants.length;

    // Create all revocation grants locally with bounded concurrency.
    // createGrant is local-only (storage + signing) so it's cheap, but we still
    // cap parallelism to avoid head-of-line blocking when the session grant
    // count is large (e.g. dapp requesting many scopes at once).
    // Revocation grants share the same hard expiry but do not duplicate
    // connectSession display metadata; session grouping should use the
    // user-facing permission grants.
    const revGrantResults = await timed(
      `${CONNECT_PERF_LOG_PREFIX} revocationGrants.create (n=${sessionGrantCount})`,
      () => mapConcurrent(
        createdGrants,
        CONNECT_FANOUT_CONCURRENCY,
        (grantMessage) =>
          permissionsApi.createGrant({
            delegated : true,
            store     : true,
            grantedTo : grantedDelegateDid,
            scope     : {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Write,
              protocol  : PermissionsProtocol.uri,
              contextId : grantMessage.recordId,
            },
            dateExpires : connectSession.expiresAt,
            author      : providerDid,
          }).then((revGrant) => ({ grantMessage, revGrant })),
      ),
    );

    // Build the revocation mappings and the per-endpoint send tasks in one
    // pass. Each revocation grant fans out to every owner DWN endpoint.
    const sessionRevocations: SessionRevocation[] = [];
    const revSendTasks: RevocationSendTask[] = [];
    for (const { grantMessage, revGrant } of revGrantResults) {
      sessionRevocations.push({
        grantId           : grantMessage.recordId,
        revocationGrantId : revGrant.message.recordId,
      });

      const { encodedData: revEncoded, ...revRawMessage } = revGrant.message;
      const revData = Uint8Array.from(Convert.base64Url(revEncoded).toUint8Array());
      for (const dwnUrl of revGrantEndpoints) {
        revSendTasks.push({ revRawMessage, revData, dwnUrl });
      }
    }

    // Fan out every revocation grant to every owner DWN endpoint with a single
    // global concurrency cap so that (grants × endpoints) cannot blow up. This
    // is best-effort (sync delivers eventually) so individual failures are
    // tolerated by `mapConcurrentSettled`.
    if (revSendTasks.length > 0) {
      await timed(
        `${CONNECT_PERF_LOG_PREFIX} revocationGrants.fanout (sends=${revSendTasks.length}, endpoints=${revGrantEndpoints.length})`,
        () => mapConcurrentSettled(
          revSendTasks,
          CONNECT_FANOUT_CONCURRENCY,
          ({ revRawMessage, revData, dwnUrl }) =>
            agent.rpc.sendDwnRequest({
              dwnUrl,
              targetDid : providerDid,
              message   : revRawMessage,
              data      : new Blob([revData as BlobPart]),
              signal    : AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS),
            }),
        ),
      );
    }

    return {
      delegateDid    : grantedDelegateDid,
      delegatePortableDid,
      delegateGrants : [...createdGrants, ...revGrantResults.map(({ revGrant }) => revGrant.message)],
      sessionRevocations,
      responseSigner,
    };
  } catch (err) {
    outcome = 'fail';
    throw err;
  } finally {
    const totalElapsed = nowMs() - approvalStart;
    logger.log(
      `${CONNECT_PERF_LOG_PREFIX} executeConnectApproval.total ${outcome} in ${totalElapsed.toFixed(1)}ms `
      + `(protocols=${numProtocols}, scopes=${numScopes}, sessionGrants=${sessionGrantCount})`,
    );
  }
}
