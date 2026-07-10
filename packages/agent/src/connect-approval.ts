/**
 * Enbox Connect approval ceremony.
 *
 * The single wallet-side approval ceremony shared by every connect transport
 * (relay/QR/deep-link, popup postMessage): delegate minting or pre-supplied
 * delegate validation, per-protocol preparation (local `ProtocolsConfigure`
 * with encryption derivation plus best-effort endpoint fan-out), permission
 * grant creation with scope guards and session metadata, durable grantKey
 * delivery for encrypted read scopes, and per-grant contextId-scoped
 * revocation grants.
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
import type { ConnectApproval, ConnectClientMetadata, ConnectPermissionRequest, SessionRevocation } from '@enbox/connect';
import type { ConnectSessionMetadata, ConnectSessionTransport, DwnDataEncodedRecordsWriteMessage, DwnPermissionScope, DwnProtocolDefinition, DwnRecordsPermissionScope } from './types/dwn.js';

import { Convert, logger, nowMs, timed } from '@enbox/common';
import { CryptoUtils, Ed25519 } from '@enbox/crypto';
import { Did, DidJwk } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName, PermissionsProtocol, Time } from '@enbox/dwn-sdk-js';

import { AgentPermissionsApi } from './permissions-api.js';
import { DwnInterface } from './types/dwn.js';
import { isRecordPermissionScope } from './dwn-api.js';
import {
  createGrantKeyRecordsForGrants,
  getEncryptionKeyInfo,
} from './dwn-encryption.js';
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
 * This is a hard grant expiry. There is intentionally no renewal path in this
 * protocol layer yet; clients should treat expired connect grants as
 * reconnect-required.
 */
export const CONNECT_SESSION_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Maximum lifetime a wallet will stamp onto connect session grants. */
export const CONNECT_SESSION_MAX_TTL_SECONDS = 90 * 24 * 60 * 60;

const CONNECT_SESSION_METADATA_LIMITS = {
  id        : 128,
  appName   : 128,
  appIcon   : 2048,
  origin    : 512,
  userAgent : 512,
  platform  : 128,
  language  : 64,
  languages : 16,
  timezone  : 128,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link createConnectSessionMetadata}. */
export type CreateConnectSessionMetadataOptions = {
  id?: string;
  appName?: string;
  appIcon?: string;
  clientMetadata?: ConnectClientMetadata;
  transport?: ConnectSessionTransport;
  createdAt?: string;
  expiresAt?: string;
  ttlSeconds?: number;
};

/** Options for {@link createPermissionGrants}. */
export type ConnectPermissionGrantOptions = {
  /** Grant expiration timestamp. Defaults to the connect session expiration. */
  dateExpires?: string;
  /** Session metadata attached to every grant created by the approval. */
  connectSession?: ConnectSessionMetadata;
};

/**
 * The approved connect request fields consumed by the ceremony. A kernel
 * `ConnectRequest` (as returned by `ConnectProvider.openRequest`) is
 * assignable to this shape.
 */
export type ConnectApprovalRequest = {
  /** Human-readable name of the requesting application. */
  appName: string;

  /** Optional icon URL for the requesting application. */
  appIcon?: string;

  /** Optional client/environment metadata for wallet session display. */
  clientMetadata?: ConnectClientMetadata;

  /** DWN protocols and permission scopes being requested. */
  permissionRequests: ConnectPermissionRequest[];

  /** Preferred session TTL in seconds; clamped to {@link CONNECT_SESSION_MAX_TTL_SECONDS}. */
  requestedSessionTtlSeconds?: number;

  /**
   * Optional delegate DID supplied by the requester.
   *
   * When present, the wallet grants permissions to this DID instead of
   * minting a new delegate DID and returning its private key material.
   */
  delegateDid?: string;
};

/** Parameters for {@link executeConnectApproval}. */
export type ExecuteConnectApprovalParams = {
  /** The agent used for DWN operations and key management. */
  agent: EnboxPlatformAgent;

  /** The wallet owner's DID that is granting access. */
  providerDid: string;

  /** The approved connect request. */
  request: ConnectApprovalRequest;

  /**
   * Transport recorded in the grant session metadata.
   * @default 'relay'
   */
  transport?: ConnectSessionTransport;
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

function randomSessionId(): string {
  return Convert.uint8Array(CryptoUtils.randomBytes(16)).toBase64Url();
}

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
  const createdAt = options.createdAt ?? Time.getCurrentTimestamp();
  const expiresAt = options.expiresAt ?? Time.createOffsetTimestamp({
    seconds: options.ttlSeconds ?? CONNECT_SESSION_DEFAULT_TTL_SECONDS,
  }, createdAt);
  const clientMetadata = options.clientMetadata ?? {};
  const appName = boundedSessionString(options.appName, CONNECT_SESSION_METADATA_LIMITS.appName);
  const appIcon = boundedSessionString(options.appIcon, CONNECT_SESSION_METADATA_LIMITS.appIcon);
  const origin = boundedSessionString(clientMetadata.origin, CONNECT_SESSION_METADATA_LIMITS.origin);
  const userAgent = boundedSessionString(clientMetadata.userAgent, CONNECT_SESSION_METADATA_LIMITS.userAgent);
  const platform = boundedSessionString(clientMetadata.platform, CONNECT_SESSION_METADATA_LIMITS.platform);
  const language = boundedSessionString(clientMetadata.language, CONNECT_SESSION_METADATA_LIMITS.language);
  const languages = boundedSessionStringArray(clientMetadata.languages);
  const timezone = boundedSessionString(clientMetadata.timezone, CONNECT_SESSION_METADATA_LIMITS.timezone);

  return {
    id: boundedSessionString(options.id, CONNECT_SESSION_METADATA_LIMITS.id) ?? randomSessionId(),
    createdAt,
    expiresAt,
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

function resolveRequestedSessionTtlSeconds(requestedSessionTtlSeconds: number | undefined): number {
  if (requestedSessionTtlSeconds === undefined) {
    return CONNECT_SESSION_DEFAULT_TTL_SECONDS;
  }

  const requestedWholeSeconds = Math.floor(requestedSessionTtlSeconds);

  if (!Number.isFinite(requestedSessionTtlSeconds) || requestedWholeSeconds <= 0) {
    throw new Error('Connect requestedSessionTtlSeconds must resolve to at least one whole second.');
  }

  return Math.min(
    requestedWholeSeconds,
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

function shouldUseDelegatePermission(scope: DwnPermissionScope): boolean {
  return isRecordPermissionScope(scope);
}

function isConnectReadScope(scope: DwnPermissionScope): scope is DwnRecordsPermissionScope {
  return isRecordPermissionScope(scope) && scope.method === DwnMethodName.Read;
}

function hasEncryptedProtocolTypes(protocolDefinition: DwnProtocolDefinition): boolean {
  return Object.values(protocolDefinition.types ?? {})
    .some((type: any) => type?.encryptionRequired === true);
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

function resolvePreSuppliedDelegateDid(delegateDid: string | undefined): string | undefined {
  if (delegateDid === undefined) {
    return undefined;
  }

  if (delegateDid.trim() === '' || delegateDid.trim() !== delegateDid) {
    throw new Error('Connect delegateDid must be a non-empty DID URI.');
  }

  const parsedDelegateDid = Did.parse(delegateDid);
  if (parsedDelegateDid === null || parsedDelegateDid.uri !== delegateDid) {
    throw new Error('Connect delegateDid must be a valid DID URI.');
  }

  return delegateDid;
}

function resolveConnectPermissionGrantOptions(
  options?: ConnectPermissionGrantOptions,
): { dateExpires: string; connectSession: ConnectSessionMetadata } {
  if (options?.dateExpires && options.connectSession?.expiresAt && options.dateExpires !== options.connectSession.expiresAt) {
    throw new Error('Connect grant dateExpires must match connectSession.expiresAt.');
  }

  const connectSession = options?.connectSession ?? createConnectSessionMetadata({
    expiresAt: options?.dateExpires,
  });
  return {
    dateExpires: options?.dateExpires ?? connectSession.expiresAt,
    connectSession,
  };
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
  options?: ConnectPermissionGrantOptions,
): Promise<DwnDataEncodedRecordsWriteMessage[]> {
  const permissionsApi = new AgentPermissionsApi({ agent });
  const { dateExpires, connectSession } = resolveConnectPermissionGrantOptions(options);

  logger.log(`Creating permission grants for ${scopes.length} scopes...`);
  for (const scope of scopes) {
    assertConnectGrantScope(scope);
  }

  const permissionGrants = await Promise.all(
    scopes.map((scope) => {
      const delegated = shouldUseDelegatePermission(scope);

      return permissionsApi.createGrant({
        delegated,
        store     : true,
        grantedTo : delegateDid,
        scope,
        dateExpires,
        author    : selectedDid,
        connectSession,
      });
    })
  );

  // Resolve all DWN endpoints for the selected DID.  `sendDwnRequest` only
  // sends to the first reachable endpoint, but the sync engine may connect
  // to a different one and needs the grant to authenticate.  We send each
  // grant to every endpoint so that sync works regardless of which DWN the
  // agent contacts first.
  const dwnEndpointUrls = await agent.dwn.getDwnEndpointUrlsForTarget(selectedDid);
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
          const detail = batchSignal.aborted
            ? `permission grant batch timed out after ${CONNECT_PERMISSION_GRANT_BATCH_TIMEOUT_MS}ms`
            : requestSignal.aborted
              ? `permission grant request timed out after ${CONNECT_REQUEST_TIMEOUT_MS}ms`
              : errorDetail(reason);
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
      const failureSummary = failures.length === 0
        ? 'no DWN endpoints were resolved'
        : remainingFailureCount > 0
          ? `${displayedFailures}; ${remainingFailureCount} more endpoint(s) failed`
          : displayedFailures;
      throw new Error(
        `Could not send permission grant to any DWN endpoint: grant ${g + 1} (${scope}); ${failureSummary}`,
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

  const dwnEndpointUrls = await agent.dwn.getDwnEndpointUrlsForTarget(ownerDid);
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

  for (let i = 0; i < successPerRecord.length; i++) {
    if (!successPerRecord[i]) {
      throw new Error('Could not send grantKey record to any DWN endpoint.');
    }
  }
}

// ---------------------------------------------------------------------------
// Protocol installation
// ---------------------------------------------------------------------------

/**
 * Ensures the protocol is installed on the provider's local DWN so that the
 * agent can sign and (when applicable) encrypt grants for it during
 * {@link executeConnectApproval}.
 *
 * Remote installation (push to every owner DWN endpoint) is the
 * responsibility of the calling client (the wallet's own `prepareProtocol`
 * runs *before* the approval ceremony and fans out to every endpoint in
 * parallel). When the protocol already exists locally — the common case —
 * this function performs a single local `ProtocolsQuery` and returns: there
 * is no remote send, so a slow/unhealthy DWN endpoint cannot block the
 * "Authorizing…" hot path.
 *
 * When the protocol is *not* installed locally — a safety fallback for
 * callers that did not pre-install — the protocol is configured locally
 * (with `encryption: true` when any type declares `encryptionRequired: true`,
 * so the agent injects `$keyAgreement` keys derived from the owner's X25519
 * root key) and then fanned out to every owner DWN endpoint with bounded
 * concurrency and a short per-request budget. Endpoint failures are
 * non-fatal — sync delivers any missing copies eventually.
 */
async function prepareProtocol(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  protocolDefinition: DwnProtocolDefinition
): Promise<void> {
  const queryMessage = await agent.processDwnRequest({
    author        : selectedDid,
    messageType   : DwnInterface.ProtocolsQuery,
    target        : selectedDid,
    messageParams : { filter: { protocol: protocolDefinition.protocol } },
  });

  if (queryMessage.reply.status.code !== 200) {
    throw new Error(`Could not fetch protocol: ${queryMessage.reply.status.detail}`);
  }

  const isInstalledLocally = queryMessage.reply.entries !== undefined
    && queryMessage.reply.entries.length > 0;

  if (isInstalledLocally) {
    // Already installed locally. The wallet's pre-call `prepareProtocol`
    // is responsible for fanning the protocol out to every owner DWN
    // endpoint; sync delivers any missing copies eventually. Skipping the
    // remote send here turns this hot path into a single local DB read
    // (~10 ms) instead of a sequential per-endpoint network round-trip
    // with retries — the latter could take minutes if any endpoint was
    // slow or unreachable.
    logger.log(`Protocol already installed locally: ${protocolDefinition.protocol}`);
    return;
  }

  // Safety fallback — protocol is missing locally, so the caller did not
  // pre-install. Configure it locally (with encryption derivation if any
  // type requires it) so the agent can sign/encrypt grants, then push to
  // every owner DWN endpoint in parallel with a short per-request budget.
  logger.log(`Protocol not installed, configuring locally: ${protocolDefinition.protocol}`);
  const needsEncryption = hasEncryptedProtocolTypes(protocolDefinition);

  const { reply: configureReply, message: configureMessage } = await agent.processDwnRequest({
    author        : selectedDid,
    target        : selectedDid,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition: protocolDefinition },
    encryption    : needsEncryption || undefined,
  });

  if (configureReply.status.code !== 202 && configureReply.status.code !== 409) {
    throw new Error(`Could not configure protocol locally: ${configureReply.status.detail}`);
  }

  let dwnEndpointUrls: string[] = [];
  try {
    dwnEndpointUrls = await agent.dwn.getDwnEndpointUrlsForTarget(selectedDid);
  } catch {
    // Endpoint resolution failure — protocol stays local-only until sync.
  }

  if (dwnEndpointUrls.length === 0) {
    return;
  }

  // Best-effort remote fan-out with bounded concurrency and a per-request
  // abort signal. Failures are tolerated (sync delivers eventually).
  await mapConcurrentSettled(
    dwnEndpointUrls,
    CONNECT_FANOUT_CONCURRENCY,
    (dwnUrl) => agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : selectedDid,
      message   : configureMessage!,
      signal    : AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS),
    }),
  );
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
 * 1. Uses a requester-supplied delegate DID, or mints one (did:jwk with the
 *    derived X25519 private key appended) when omitted.
 * 2. Clamps the requested session TTL and builds the session metadata.
 * 3. Prepares each requested protocol on the owner's DWN.
 * 4. Creates permission grants (scope guards enforced) and delivers them to
 *    every owner DWN endpoint.
 * 5. Creates and fans out durable grantKey records for encrypted read scopes.
 * 6. Creates per-grant contextId-scoped revocation grants and fans them out.
 *
 * @param params - The approval parameters.
 * @returns The `ConnectApproval` consumed by the kernel's
 *          `ConnectProvider.sealApprovedResponse`, plus the response signer.
 * @throws Error when the request is invalid or required grant delivery fails.
 */
export async function executeConnectApproval(params: ExecuteConnectApprovalParams): Promise<ConnectApprovalResult> {
  const { agent, providerDid, request } = params;
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
    const sessionTtlSeconds = resolveRequestedSessionTtlSeconds(request.requestedSessionTtlSeconds);
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
      delegatePortableDid = await delegateBearerDid.export();

      // Add X25519 key derived from the delegate's Ed25519 key.
      // did:jwk only supports one verification method, but DWN encryption
      // requires X25519 for key agreement. Including the derived X25519
      // private key in the PortableDid ensures the delegate agent's KMS
      // has both keys after import. The Ed25519→X25519 conversion is a
      // standard cryptographic operation (RFC 8032 / libsodium).
      const delegateEdPrivateKey = delegatePortableDid.privateKeys![0];
      delegateRootPrivateKey = await Ed25519.convertPrivateKeyToX25519({
        privateKey: delegateEdPrivateKey,
      }) as PrivateKeyJwk;
      delegatePortableDid.privateKeys!.push(delegateRootPrivateKey);
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
      appName        : request.appName,
      appIcon        : request.appIcon,
      ttlSeconds     : sessionTtlSeconds,
      clientMetadata : request.clientMetadata,
      transport      : params.transport ?? 'relay',
    });

    const grantSetup = await timed(
      `${CONNECT_PERF_LOG_PREFIX} permissionGrants.fanout (protocols=${numProtocols})`,
      async () => {
        await Promise.all(request.permissionRequests.map(
          ({ protocolDefinition }) => prepareProtocol(providerDid, agent, protocolDefinition)
        ));

        const permissionScopes = request.permissionRequests.flatMap((permissionRequest) => permissionRequest.permissionScopes);
        const createdGrants = await ConnectCeremony.createPermissionGrants(
          providerDid,
          grantedDelegateDid,
          agent,
          permissionScopes,
          { connectSession },
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
            const { protocolDefinition, permissionScopes: requestScopes } = permissionRequest;
            const hasEncryptedTypes = hasEncryptedProtocolTypes(protocolDefinition);
            const hasEncryptedReadScopes = hasEncryptedTypes && requestScopes.some(isConnectReadScope);
            if (!hasEncryptedReadScopes) {
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
              protocolDefinitions : [protocolDefinition],
            });
          }
        ))).flat();

        // Revocation grants are appended later; preserve the grant creator's
        // returned array as the previous per-protocol flattening did.
        return { delegateGrants: [...createdGrants], durableGrantKeyRecords };
      },
    );
    const { delegateGrants, durableGrantKeyRecords } = grantSetup;

    await timed(
      `${CONNECT_PERF_LOG_PREFIX} grantKeys.fanout (n=${durableGrantKeyRecords.length})`,
      () => fanOutDataEncodedRecords(providerDid, agent, durableGrantKeyRecords),
    );

    // Create per-grant contextId-scoped revocation grants.
    // Each revocation grant authorizes the delegate to write a revocation
    // ONLY for the specific session grant it corresponds to.
    const permissionsApi = new AgentPermissionsApi({ agent });
    const sessionRevocations: SessionRevocation[] = [];
    let revGrantEndpoints: string[] = [];
    try {
      revGrantEndpoints = await agent.dwn.getDwnEndpointUrlsForTarget(providerDid);
    } catch {
      // Endpoint resolution failure — revocation grants will be local-only until sync.
    }

    // Snapshot the current length — revocation grants are appended to delegateGrants
    // below, but we must NOT iterate over them (they are meta-grants, not session grants).
    sessionGrantCount = delegateGrants.length;

    // Create all revocation grants locally with bounded concurrency.
    // createGrant is local-only (storage + signing) so it's cheap, but we still
    // cap parallelism to avoid head-of-line blocking when sessionGrantCount is
    // large (e.g. dapp requesting many scopes at once).
    // Revocation grants share the same hard expiry but do not duplicate
    // connectSession display metadata; session grouping should use the
    // user-facing permission grants.
    const revGrantResults = await timed(
      `${CONNECT_PERF_LOG_PREFIX} revocationGrants.create (n=${sessionGrantCount})`,
      () => mapConcurrent(
        delegateGrants.slice(0, sessionGrantCount),
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

    // Fan out every revocation grant to every owner DWN endpoint with a single
    // global concurrency cap so that (grants × endpoints) cannot blow up. This
    // is best-effort (sync delivers eventually) so individual failures are
    // tolerated by `mapConcurrentSettled`.
    const revSendTasks = revGrantResults.flatMap(({ grantMessage, revGrant }) => {
      sessionRevocations.push({
        grantId           : grantMessage.recordId,
        revocationGrantId : revGrant.message.recordId,
      });

      const { encodedData: revEncoded, ...revRawMessage } = revGrant.message;
      const revData = Uint8Array.from(Convert.base64Url(revEncoded).toUint8Array());

      // Include the revocation grant in the delegate grants for distribution.
      delegateGrants.push(revGrant.message);

      return revGrantEndpoints.map((dwnUrl) => ({ revRawMessage, revData, dwnUrl }));
    });

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
              data      : new Blob([revData]),
              signal    : AbortSignal.timeout(CONNECT_REQUEST_TIMEOUT_MS),
            }),
        ),
      );
    }

    return {
      delegateDid        : grantedDelegateDid,
      delegatePortableDid,
      delegateGrants,
      sessionRevocations : sessionRevocations.length > 0 ? sessionRevocations : undefined,
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
