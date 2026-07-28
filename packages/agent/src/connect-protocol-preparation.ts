/**
 * Per-protocol preparation for the connect approval ceremony.
 *
 * {@link prepareProtocol} makes a requested protocol usable for delegated
 * grants before {@link import('./connect-approval.js').executeConnectApproval}
 * creates them, with fail-closed verification:
 *
 * 1. Rejects requester-supplied `$keyAgreement` / `$encryption` metadata and
 *    non-normalized protocol URIs — encryption keys are always derived from
 *    the provider's own root key, never accepted from a request.
 * 2. Compares the locally installed definition against the requested one
 *    (ignoring wallet-managed encryption metadata) and verifies every
 *    installed `$keyAgreement` public key against the provider's key deriver
 *    by JWK thumbprint. A mismatch is a conflict and aborts the approval; a
 *    policy-identical install that is missing keys is an encryption upgrade.
 * 3. Installs or upgrades locally (`ProtocolsConfigure` with encryption
 *    derivation when any type declares `encryptionRequired: true`).
 * 4. Verifies every reachable owner DWN endpoint: a reachable endpoint that
 *    rejects the protocol query, a remote definition/key conflict, or zero
 *    reachable endpoints (when any resolve) abort the approval.
 * 5. Propagates out-of-batch `uses` dependencies (from the provider's local
 *    installs, depth-first) to endpoints that are missing the dependent —
 *    the DWN rejects a composed `ProtocolsConfigure` when a `uses` target is
 *    not installed for the tenant.
 * 6. Fans the current configure message out to endpoints that are missing or
 *    behind, then re-queries each changed endpoint and requires it to
 *    converge to the requested definition — attaching the per-endpoint
 *    failure reasons (rejected sends, non-2xx replies, non-converged states)
 *    to the error instead of swallowing them.
 *
 * When no remote DWN endpoints resolve for the provider, preparation is
 * local-only — grant delivery enforces the ≥1-endpoint invariant immediately
 * afterwards, so approval still cannot complete against a provider with no
 * reachable DWN.
 */

import type { EnboxPlatformAgent } from './types/agent.js';
import type { DwnProtocolDefinition, DwnResponse } from './types/dwn.js';
import type { EncryptionKeyDeriver, GenericMessage, GenericMessageReply, ProtocolsQueryMessage, Status } from '@enbox/dwn-sdk-js';

import { computeJwkThumbprint } from '@enbox/crypto';
import { logger } from '@enbox/common';
import { KeyDerivationScheme, Message } from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { mapConcurrentSettled } from './utils.js';
import { verifyRemoteDwnResponse } from './remote-dwn-response.js';

// ---------------------------------------------------------------------------
// Tunables (mirrors the connect-approval fan-out budgets)
// ---------------------------------------------------------------------------

/** Maximum concurrent endpoint requests per fan-out. */
const PROTOCOL_FANOUT_CONCURRENCY = 8;

/**
 * Per-request abort budget for endpoint queries/sends so a single unhealthy
 * endpoint cannot stall the interactive "Authorizing…" path.
 */
const PROTOCOL_REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Setup-status analysis
// ---------------------------------------------------------------------------

/** Resolved preparation state of one protocol against one DWN. */
export type ProtocolSetupStatus = 'configured' | 'conflict' | 'install' | 'update' | 'upgrade';

/** Stage at which owner protocol preparation failed. */
export type ProtocolPreparationStage =
  | 'local-query'
  | 'local-configure'
  | 'endpoint-resolution'
  | 'remote-query'
  | 'remote-publish'
  | 'remote-verify';

/** Structured failure emitted by the reusable owner-readiness primitive. */
export class ProtocolPreparationError extends Error {
  public readonly cause?: unknown;
  public readonly endpointFailures: readonly ProtocolEndpointFailure[];
  public readonly protocol: string;
  public readonly stage: ProtocolPreparationStage;
  public readonly status?: Readonly<Status>;
  public readonly targetDid: string;

  constructor(options: {
    cause?: unknown;
    endpointFailures?: readonly ProtocolEndpointFailure[];
    message: string;
    protocol: string;
    stage: ProtocolPreparationStage;
    status?: Status;
    targetDid: string;
  }) {
    super(options.message);
    this.name = 'ProtocolPreparationError';
    this.cause = options.cause;
    this.endpointFailures = (options.endpointFailures ?? []).map((failure) => ({
      ...failure,
      status: failure.status === undefined ? undefined : { ...failure.status },
    }));
    this.protocol = options.protocol;
    this.stage = options.stage;
    this.status = options.status === undefined ? undefined : { ...options.status };
    this.targetDid = options.targetDid;
  }
}

/** Machine-readable failure observed at one advertised DWN endpoint. */
export type ProtocolEndpointFailure = {
  detail: string;
  endpoint: string;
  status?: Readonly<Status>;
};

/** Explicit publication policy for owner protocol readiness. */
export type ProtocolPublicationPolicy = 'local-only' | 'required';

/** Options for {@link ensureOwnerProtocolReady}. */
export type EnsureOwnerProtocolReadyOptions = {
  /** Whether remote publication is required or the operation is intentionally local-only. */
  publication: ProtocolPublicationPolicy;

  /** Session-lifetime cancellation signal. */
  signal?: AbortSignal;
};

/** Input to the owner-side exact-artifact readiness primitive. */
export type EnsureOwnerProtocolReadyParams = EnsureOwnerProtocolReadyOptions & {
  agent: EnboxPlatformAgent;
  ownerDid: string;
  protocolDefinition: DwnProtocolDefinition;
};

type DefinitionPolicy = 'reject' | 'update';

type PreparationPolicy = {
  definitionPolicy: DefinitionPolicy;
  endpointPolicy: 'available' | ProtocolPublicationPolicy;
  exactMessageConvergence: boolean;
  remoteEndpointsOnly: boolean;
  signal?: AbortSignal;
  targetDid: string;
  verifyRemoteArtifacts: boolean;
};

type RemotePreparationContext = {
  agent: EnboxPlatformAgent;
  ownerDid: string;
  signal?: AbortSignal;
  targetDid: string;
  verifyRemoteArtifacts: boolean;
};

type ProtocolQueryReply = {
  status: { code: number; detail: string };
  entries?: ProtocolConfigureEntry[];
};

type ProtocolConfigureEntry = {
  descriptor?: {
    definition?: DwnProtocolDefinition;
  };
};

function isProtocolConfigureSuccess(status: { code: number }): boolean {
  return (status.code >= 200 && status.code < 300) || status.code === 409;
}

type RemoteProtocolState = {
  dwnUrl: string;
  entry?: ProtocolConfigureEntry;
  setupStatus: ProtocolSetupStatus;
};

type EndpointFailureDetail = Omit<ProtocolEndpointFailure, 'endpoint'>;

class RemoteProtocolResponseVerificationError extends Error {
  public readonly cause: unknown;
  public readonly dwnUrl: string;

  constructor(dwnUrl: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RemoteProtocolResponseVerificationError';
    this.cause = cause;
    this.dwnUrl = dwnUrl;
  }
}

/**
 * Structural normalization used for definition comparison: wallet-managed
 * encryption metadata (`$keyAgreement` / `$encryption`) is stripped — it is
 * injected at install time by the owner — and keys are sorted so serialization
 * order cannot mask or fake a difference.
 */
function normalizeProtocolDefinition(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeProtocolDefinition);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => key !== '$keyAgreement' && key !== '$encryption' && entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeProtocolDefinition(entry)]),
  );
}

/** Whether two protocol definitions are policy-identical (encryption metadata aside). */
export function protocolDefinitionsMatch(
  installedDefinition: DwnProtocolDefinition,
  requestedDefinition: DwnProtocolDefinition,
): boolean {
  return JSON.stringify(normalizeProtocolDefinition(installedDefinition))
    === JSON.stringify(normalizeProtocolDefinition(requestedDefinition));
}

/** Whether a requested definition carries wallet-managed encryption metadata. */
function containsRequesterManagedEncryptionKeys(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsRequesterManagedEncryptionKeys);
  }

  if (!value || typeof value !== 'object') {
    return false;
  }

  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    key === '$keyAgreement'
    || key === '$encryption'
    || containsRequesterManagedEncryptionKeys(entry)
  );
}

/**
 * Whether the protocol URI is already in normalized URL form. Definition
 * comparison and grant scopes key off the exact URI string, so an
 * un-normalized variant of an installed protocol must be treated as a
 * conflict rather than a fresh install.
 */
function isNormalizedProtocolUri(protocol: string): boolean {
  try {
    const url = new URL(protocol);
    url.search = '';
    url.hash = '';
    const normalized = url.href.endsWith('/') ? url.href.slice(0, -1) : url.href;
    return normalized === protocol;
  } catch {
    return false;
  }
}

/** Whether any type in the definition declares `encryptionRequired: true`. */
export function hasEncryptedProtocolTypes(protocolDefinition: DwnProtocolDefinition): boolean {
  return Object.values(protocolDefinition.types ?? {}).some(
    (type) => (type as { encryptionRequired?: boolean })?.encryptionRequired === true,
  );
}

async function publicKeysMatch(left: unknown, right: unknown): Promise<boolean> {
  try {
    const [leftThumbprint, rightThumbprint] = await Promise.all([
      computeJwkThumbprint({ jwk: left as never }),
      computeJwkThumbprint({ jwk: right as never }),
    ]);
    return leftThumbprint === rightThumbprint;
  } catch {
    return false;
  }
}

type EncryptionKeyState = 'configured' | 'conflict' | 'missing';

/**
 * Verifies a single structure node's own `$keyAgreement` public key against the
 * provider's derivation path. A node whose requested rule set is a `$ref` carries
 * no key of its own and is skipped. Returns `'conflict'` when the installed key
 * doesn't match the provider's derivation, `'missing'` when it is absent, or
 * `undefined` when the node's key is present and matches (or the node is a `$ref`).
 */
async function getNodeKeyState(
  requestedRuleSet: Record<string, unknown>,
  installedRuleSet: Record<string, unknown>,
  currentPath: string[],
  keyDeriver: EncryptionKeyDeriver,
): Promise<'conflict' | 'missing' | undefined> {
  if ((requestedRuleSet as { $ref?: unknown })?.$ref !== undefined) {
    return undefined;
  }

  const installedKey = (installedRuleSet.$keyAgreement as { publicKeyJwk?: unknown } | undefined)?.publicKeyJwk;
  if (installedKey === undefined) {
    return 'missing';
  }

  const expectedKey = await keyDeriver.derivePublicKey(currentPath);
  return await publicKeysMatch(installedKey, expectedKey) ? undefined : 'conflict';
}

/**
 * Walks every non-`$ref` rule set of the requested structure and verifies the
 * installed `$keyAgreement` public keys against the provider's own derivation
 * paths: a key derived by someone else is a conflict; an absent key is an
 * upgrade candidate.
 */
async function getInstalledEncryptionKeyState(
  installedDefinition: DwnProtocolDefinition,
  requestedDefinition: DwnProtocolDefinition,
  keyDeriver: EncryptionKeyDeriver,
): Promise<EncryptionKeyState> {
  let missing = false;
  const basePath = [KeyDerivationScheme.ProtocolPath, requestedDefinition.protocol];
  const expectedRootKey = await keyDeriver.derivePublicKey(basePath);
  const installedRootKey = installedDefinition.$keyAgreement?.publicKeyJwk;
  if (installedRootKey === undefined) {
    missing = true;
  } else if (!await publicKeysMatch(installedRootKey, expectedRootKey)) {
    return 'conflict';
  }

  // Resolves one requested node against the installed structure: 'not-installed'
  // signals a hard stop (no installed counterpart to recurse into), 'conflict' a
  // key mismatch, 'missing' an absent-but-recursable key, matching the checks and
  // early-exit semantics `inspectStructure` used to perform inline for this node.
  async function inspectStructureNode(
    nodeName: string,
    requestedRuleSet: Record<string, unknown>,
    installedStructure: Record<string, unknown> | undefined,
    parentPath: string[],
  ): Promise<'not-installed' | EncryptionKeyState> {
    const installedRuleSet = installedStructure?.[nodeName] as Record<string, unknown> | undefined;
    if (!installedRuleSet || typeof installedRuleSet !== 'object') { return 'not-installed'; }

    const currentPath = [...parentPath, nodeName];
    const nodeKeyState = await getNodeKeyState(requestedRuleSet, installedRuleSet, currentPath, keyDeriver);
    if (nodeKeyState === 'conflict') { return 'conflict'; }
    if (nodeKeyState === 'missing') { missing = true; }

    return inspectStructure(requestedRuleSet, installedRuleSet, currentPath);
  }

  async function inspectStructure(
    requestedStructure: Record<string, unknown>,
    installedStructure: Record<string, unknown> | undefined,
    parentPath: string[],
  ): Promise<EncryptionKeyState> {
    for (const [nodeName, requestedRuleSet] of Object.entries(requestedStructure)) {
      if (nodeName.startsWith('$')) { continue; }

      const childState = await inspectStructureNode(
        nodeName,
        requestedRuleSet as Record<string, unknown>,
        installedStructure,
        parentPath,
      );
      if (childState === 'not-installed') { return 'missing'; }
      if (childState === 'conflict') { return 'conflict'; }
      if (childState === 'missing') { missing = true; }
    }
    return missing ? 'missing' : 'configured';
  }

  return inspectStructure(
    requestedDefinition.structure as Record<string, unknown>,
    installedDefinition.structure as Record<string, unknown> | undefined,
    basePath,
  );
}

/** Structural setup status (no key verification). */
export function getProtocolSetupStatus(
  installedDefinition: DwnProtocolDefinition | undefined,
  requestedDefinition: DwnProtocolDefinition,
): ProtocolSetupStatus {
  if (!isNormalizedProtocolUri(requestedDefinition.protocol)) {
    return 'conflict';
  }
  if (containsRequesterManagedEncryptionKeys(requestedDefinition)) {
    return 'conflict';
  }

  if (!installedDefinition) {
    return 'install';
  }

  if (!protocolDefinitionsMatch(installedDefinition, requestedDefinition)) {
    return 'conflict';
  }

  return 'configured';
}

/**
 * Setup status including encryption-key verification: a policy-identical
 * install whose encrypted paths are missing `$keyAgreement` keys resolves to
 * `upgrade`; keys not derived from the provider's root key resolve to
 * `conflict`.
 */
async function getVerifiedProtocolSetupStatus(
  installedDefinition: DwnProtocolDefinition | undefined,
  requestedDefinition: DwnProtocolDefinition,
  selectedDid: string,
  agent: EnboxPlatformAgent,
): Promise<ProtocolSetupStatus> {
  const structuralStatus = getProtocolSetupStatus(installedDefinition, requestedDefinition);
  if (
    structuralStatus === 'conflict'
    || structuralStatus === 'install'
    || !hasEncryptedProtocolTypes(requestedDefinition)
    || installedDefinition === undefined
  ) {
    return structuralStatus;
  }

  const keyDeriver = await agent.dwn.getEncryptionKeyDeriver(selectedDid);
  const keyState = await getInstalledEncryptionKeyState(
    installedDefinition,
    requestedDefinition,
    keyDeriver,
  );
  if (keyState === 'conflict') { return 'conflict'; }
  return keyState === 'missing' ? 'upgrade' : 'configured';
}

function getProtocolSetupConflictMessage(
  installedDefinition: DwnProtocolDefinition | undefined,
  requestedDefinition: DwnProtocolDefinition,
): string | undefined {
  if (!isNormalizedProtocolUri(requestedDefinition.protocol)) {
    return `Protocol URI '${requestedDefinition.protocol}' is not normalized.`;
  }
  if (containsRequesterManagedEncryptionKeys(requestedDefinition)) {
    return `Protocol '${requestedDefinition.protocol}' contains wallet-managed encryption keys. `
      + 'Requesters must provide the protocol definition without $keyAgreement metadata.';
  }

  if (installedDefinition !== undefined && !protocolDefinitionsMatch(installedDefinition, requestedDefinition)) {
    return `Protocol '${requestedDefinition.protocol}' is already installed with a different definition. `
      + 'A connection request cannot replace an owner protocol definition.';
  }

  return undefined;
}

function getProtocolDefinitionFromEntry(
  entry: ProtocolConfigureEntry | undefined,
): DwnProtocolDefinition | undefined {
  return entry?.descriptor?.definition;
}

// ---------------------------------------------------------------------------
// Preparation flow
// ---------------------------------------------------------------------------

/**
 * Runs the local `ProtocolsQuery` for the requested protocol and computes its
 * verified setup status, throwing on a non-200 reply or a definition/key
 * conflict — the shared preamble every preparation path starts from.
 */
async function queryLocalProtocolStatus(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  protocolDefinition: DwnProtocolDefinition,
  definitionPolicy: DefinitionPolicy = 'reject',
): Promise<{
  queryResult: DwnResponse<DwnInterface.ProtocolsQuery>;
  existingEntry: ProtocolConfigureEntry | undefined;
  setupStatus: ProtocolSetupStatus;
}> {
  const queryResult = await agent.processDwnRequest({
    author        : selectedDid,
    messageType   : DwnInterface.ProtocolsQuery,
    target        : selectedDid,
    messageParams : { filter: { protocol: protocolDefinition.protocol } },
  });

  if (queryResult.reply.status.code !== 200) {
    throw new ProtocolPreparationError({
      message   : `Could not fetch protocol: ${queryResult.reply.status.detail}`,
      protocol  : protocolDefinition.protocol,
      stage     : 'local-query',
      status    : { ...queryResult.reply.status },
      targetDid : selectedDid,
    });
  }

  const existingEntry = queryResult.reply.entries?.[0] as ProtocolConfigureEntry | undefined;
  const installedDefinition = getProtocolDefinitionFromEntry(existingEntry);
  let setupStatus = await getVerifiedProtocolSetupStatus(
    installedDefinition,
    protocolDefinition,
    selectedDid,
    agent,
  );

  if (setupStatus === 'conflict') {
    const requestConflict = getProtocolSetupConflictMessage(undefined, protocolDefinition);
    if (definitionPolicy === 'update' && requestConflict === undefined) {
      setupStatus = 'update';
      return { queryResult, existingEntry, setupStatus };
    }

    throw new Error(
      getProtocolSetupConflictMessage(installedDefinition, protocolDefinition)
      ?? `Protocol '${protocolDefinition.protocol}' has encryption keys that do not match this wallet owner.`,
    );
  }

  return { queryResult, existingEntry, setupStatus };
}

/** Resolves the provider's reachable DWN endpoint URLs, treating a resolution failure like zero endpoints. */
async function resolveDwnEndpointUrls(
  targetDid: string,
  agent: EnboxPlatformAgent,
  remoteEndpointsOnly: boolean = false,
  failOnResolutionError: boolean = false,
): Promise<string[]> {
  try {
    return remoteEndpointsOnly
      ? await agent.dwn.getRemoteDwnEndpointUrls(targetDid)
      : await agent.dwn.getDwnEndpointUrlsForTarget(targetDid);
  } catch (error: unknown) {
    if (failOnResolutionError) {
      throw error;
    }
    // Endpoint resolution failure — treated like zero endpoints below.
    return [];
  }
}

/** Combines the caller's lifetime with the per-endpoint request timeout. */
function protocolRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PROTOCOL_REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Sends one direct endpoint request and optionally authenticates reply artifacts. */
async function sendProtocolEndpointRequest(
  context: RemotePreparationContext,
  dwnUrl: string,
  message: GenericMessage,
): Promise<ProtocolQueryReply> {
  context.signal?.throwIfAborted();
  const reply = await context.agent.rpc.sendDwnRequest({
    dwnUrl,
    targetDid : context.targetDid,
    message,
    signal    : protocolRequestSignal(context.signal),
  }) as ProtocolQueryReply;

  if (context.verifyRemoteArtifacts) {
    try {
      await verifyRemoteDwnResponse({
        didResolver : context.agent.did,
        message,
        reply       : reply as GenericMessageReply,
        targetDid   : context.targetDid,
      });
    } catch (cause: unknown) {
      throw new RemoteProtocolResponseVerificationError(dwnUrl, cause);
    }
  }

  return reply;
}

/**
 * Queries every candidate endpoint for the protocol and returns the replies from
 * the ones that were reachable, logging (not throwing on) unreachable endpoints.
 * Throws if a reachable endpoint rejects the query, or if none were reachable.
 */
async function queryReachableProtocolEndpoints(
  context: RemotePreparationContext,
  dwnEndpointUrls: string[],
  queryMessage: ProtocolsQueryMessage,
  protocolUri: string,
): Promise<Array<{ dwnUrl: string; reply: ProtocolQueryReply }>> {
  const remoteQueryResults = await mapConcurrentSettled(
    dwnEndpointUrls,
    PROTOCOL_FANOUT_CONCURRENCY,
    async (dwnUrl) => ({
      dwnUrl,
      reply: await sendProtocolEndpointRequest(context, dwnUrl, queryMessage),
    }),
  );

  const reachableReplies: Array<{ dwnUrl: string; reply: ProtocolQueryReply }> = [];
  const unreachableEndpoints: ProtocolEndpointFailure[] = [];
  for (const [taskIndex, settled] of remoteQueryResults.entries()) {
    if (settled.status === 'rejected') {
      if (settled.reason instanceof RemoteProtocolResponseVerificationError) {
        throw settled.reason;
      }
      const endpoint = dwnEndpointUrls[taskIndex];
      const detail = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
      logger.error(`prepareProtocol: could not query ${endpoint}: ${detail}`);
      unreachableEndpoints.push({ detail, endpoint });
      continue;
    }
    if (settled.value.reply.status.code !== 200) {
      const { dwnUrl, reply } = settled.value;
      throw new ProtocolPreparationError({
        endpointFailures: [{
          detail   : reply.status.detail,
          endpoint : dwnUrl,
          status   : { ...reply.status },
        }],
        message   : `Could not verify protocol on ${dwnUrl}: ${reply.status.detail}`,
        protocol  : protocolUri,
        stage     : 'remote-query',
        targetDid : context.targetDid,
      });
    }
    reachableReplies.push(settled.value);
  }

  if (reachableReplies.length === 0) {
    throw new ProtocolPreparationError({
      endpointFailures : unreachableEndpoints,
      message          : `Could not verify the protocol definition for '${protocolUri}' on any DWN endpoint. `
        + unreachableEndpoints.map(({ detail, endpoint }) => `${endpoint}: ${detail}`).join('; '),
      protocol  : protocolUri,
      stage     : 'remote-query',
      targetDid : context.targetDid,
    });
  }

  return reachableReplies;
}

/** Computes each reachable endpoint's verified setup status, throwing on the first remote conflict. */
async function getRemoteProtocolStates(
  reachableReplies: Array<{ dwnUrl: string; reply: ProtocolQueryReply }>,
  protocolDefinition: DwnProtocolDefinition,
  ownerDid: string,
  agent: EnboxPlatformAgent,
  definitionPolicy: DefinitionPolicy = 'reject',
): Promise<RemoteProtocolState[]> {
  const remoteStates: RemoteProtocolState[] = [];
  for (const { dwnUrl, reply } of reachableReplies) {
    const entry = reply.entries?.[0];
    let remoteStatus = await getVerifiedProtocolSetupStatus(
      getProtocolDefinitionFromEntry(entry),
      protocolDefinition,
      ownerDid,
      agent,
    );
    if (remoteStatus === 'conflict') {
      if (definitionPolicy === 'update') {
        remoteStatus = 'update';
        remoteStates.push({ dwnUrl, entry, setupStatus: remoteStatus });
        continue;
      }

      throw new Error(
        `Protocol '${protocolDefinition.protocol}' conflicts with the latest definition or encryption keys on ${dwnUrl}.`,
      );
    }
    remoteStates.push({ dwnUrl, entry, setupStatus: remoteStatus });
  }
  return remoteStates;
}

/**
 * Postcondition: re-queries every endpoint that was fanned out to and requires it
 * to now report the requested definition. Throws — with the per-endpoint failure
 * reasons accumulated across the dependency sends, the configure send, and this
 * re-query attached — on any endpoint that did not converge.
 */
async function verifyEndpointsConverged(
  endpointsNeedingConfigure: string[],
  context: RemotePreparationContext,
  queryMessage: ProtocolsQueryMessage,
  protocolDefinition: DwnProtocolDefinition,
  endpointFailures: Map<string, EndpointFailureDetail>,
  expectedMessage?: ProtocolConfigureEntry,
): Promise<void> {
  const expectedCid = expectedMessage === undefined
    ? undefined
    : await Message.getCid(expectedMessage as GenericMessage);
  const verifiedPostconditions = await mapConcurrentSettled(
    endpointsNeedingConfigure,
    PROTOCOL_FANOUT_CONCURRENCY,
    async (dwnUrl): Promise<{ converged: boolean; observed: string; status?: Status }> => {
      const reply = await sendProtocolEndpointRequest(context, dwnUrl, queryMessage);

      if (reply.status.code !== 200) {
        return {
          converged : false,
          observed  : `verification re-query rejected (${reply.status.code}): ${reply.status.detail}`,
          status    : reply.status,
        };
      }

      const verifiedStatus = await getVerifiedProtocolSetupStatus(
        getProtocolDefinitionFromEntry(reply.entries?.[0]),
        protocolDefinition,
        context.ownerDid,
        context.agent,
      );
      const observedCid = reply.entries?.[0] === undefined
        ? undefined
        : await Message.getCid(reply.entries[0] as GenericMessage);
      const exactMessageMatches = expectedCid === undefined || observedCid === expectedCid;
      return {
        converged : verifiedStatus === 'configured' && exactMessageMatches,
        observed  : verifiedStatus !== 'configured'
          ? `endpoint still reports '${verifiedStatus}' after configure`
          : `endpoint retained message '${observedCid ?? 'none'}' instead of '${expectedCid}'`,
      };
    },
  );

  const failedEndpoints: ProtocolEndpointFailure[] = [];
  for (const [taskIndex, settled] of verifiedPostconditions.entries()) {
    const dwnUrl = endpointsNeedingConfigure[taskIndex];
    if (settled.status === 'rejected') {
      const unreachableReason = `unreachable at verification: ${settled.reason}`;
      const earlier = endpointFailures.get(dwnUrl);
      failedEndpoints.push({
        detail   : earlier?.detail ?? unreachableReason,
        endpoint : dwnUrl,
        status   : earlier?.status,
      });
      continue;
    }
    if (!settled.value.converged) {
      const earlier = endpointFailures.get(dwnUrl);
      failedEndpoints.push({
        detail   : earlier?.detail ?? settled.value.observed,
        endpoint : dwnUrl,
        status   : earlier?.status ?? settled.value.status,
      });
    }
  }

  if (failedEndpoints.length > 0) {
    throw new ProtocolPreparationError({
      endpointFailures : failedEndpoints,
      message          : `Could not verify the latest protocol definition on every reachable DWN endpoint for `
        + `'${protocolDefinition.protocol}'. `
        + failedEndpoints.map(({ detail, endpoint }) => `${endpoint}: ${detail}`).join('; '),
      protocol  : protocolDefinition.protocol,
      stage     : 'remote-verify',
      targetDid : context.targetDid,
    });
  }
}

/**
 * Prepares one requested protocol on the provider's DWNs for the approval
 * ceremony. See the module JSDoc for the full contract.
 *
 * @throws Error on a local or remote definition/key conflict, a reachable
 *         endpoint rejecting the protocol query, zero reachable endpoints
 *         when any resolve, a failed local configure, or endpoints that do
 *         not converge to the requested definition after fan-out.
 */
export async function prepareProtocol(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  protocolDefinition: DwnProtocolDefinition,
): Promise<void> {
  return prepareProtocolWithPolicy(selectedDid, agent, protocolDefinition, {
    definitionPolicy        : 'reject',
    endpointPolicy          : 'available',
    exactMessageConvergence : false,
    remoteEndpointsOnly     : false,
    targetDid               : selectedDid,
    verifyRemoteArtifacts   : false,
  });
}

/**
 * Makes an owner protocol locally usable and, when required, converged across
 * every reachable DID-document DWN endpoint using the exact locally signed,
 * key-injected `ProtocolsConfigure` artifact.
 */
export async function ensureOwnerProtocolReady({
  agent,
  ownerDid,
  protocolDefinition,
  publication,
  signal,
}: EnsureOwnerProtocolReadyParams): Promise<void> {
  if (publication !== 'local-only' && publication !== 'required') {
    throw new TypeError(
      'ensureOwnerProtocolReady: publication must be either \'local-only\' or \'required\'.',
    );
  }
  signal?.throwIfAborted();
  try {
    await prepareProtocolWithPolicy(ownerDid, agent, protocolDefinition, {
      definitionPolicy        : 'update',
      endpointPolicy          : publication,
      exactMessageConvergence : true,
      remoteEndpointsOnly     : true,
      signal,
      targetDid               : ownerDid,
      verifyRemoteArtifacts   : true,
    });
    signal?.throwIfAborted();
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    throw cause;
  }
}

type RemoteConvergencePlan = {
  configureMessage: ProtocolConfigureEntry;
  endpointsNeedingConfigure: string[];
};

async function remoteMessagesMatchLocal(
  existingEntry: ProtocolConfigureEntry | undefined,
  setupStatus: ProtocolSetupStatus,
  remoteStates: RemoteProtocolState[],
): Promise<boolean> {
  if (setupStatus !== 'configured' || existingEntry === undefined || remoteStates.length === 0) {
    return false;
  }

  const localCid = await Message.getCid(existingEntry as GenericMessage);
  const matches = await Promise.all(remoteStates.map(async ({ entry }) => entry !== undefined
    && await Message.getCid(entry as GenericMessage) === localCid));
  return matches.every(Boolean);
}

async function planRemoteConvergence(options: {
  agent: EnboxPlatformAgent;
  existingEntry?: ProtocolConfigureEntry;
  ownerDid: string;
  policy: PreparationPolicy;
  protocolDefinition: DwnProtocolDefinition;
  remoteStates: RemoteProtocolState[];
  setupStatus: ProtocolSetupStatus;
}): Promise<RemoteConvergencePlan> {
  const { agent, existingEntry, ownerDid, policy, protocolDefinition, remoteStates, setupStatus } = options;
  const protocol = protocolDefinition.protocol;

  if (policy.exactMessageConvergence) {
    const converged = await runPreparationStage(
      'remote-query',
      protocol,
      policy.targetDid,
      async () => remoteMessagesMatchLocal(existingEntry, setupStatus, remoteStates),
    );
    if (converged) {
      return { configureMessage: existingEntry!, endpointsNeedingConfigure: [] };
    }

    // Any exact-artifact drift causes one fresh local configure and a fan-out
    // of the resulting current artifact to every reachable endpoint.
    const configureMessage = await configureAndVerifyLocalProtocol(ownerDid, agent, protocolDefinition, policy);
    return {
      configureMessage,
      endpointsNeedingConfigure: remoteStates.map((state) => state.dwnUrl),
    };
  }

  const endpointsNeedingConfigure = remoteStates
    .filter((state) => state.setupStatus !== 'configured')
    .map((state) => state.dwnUrl);
  const configureMessage = setupStatus === 'install' || setupStatus === 'upgrade'
    ? await configureAndVerifyLocalProtocol(ownerDid, agent, protocolDefinition, policy)
    : existingEntry;
  if (configureMessage === undefined) {
    throw new ProtocolPreparationError({
      message   : `Local protocol '${protocol}' has no configure artifact to publish.`,
      protocol,
      stage     : 'local-configure',
      targetDid : ownerDid,
    });
  }

  return { configureMessage, endpointsNeedingConfigure };
}

async function prepareProtocolWithPolicy(
  ownerDid: string,
  agent: EnboxPlatformAgent,
  protocolDefinition: DwnProtocolDefinition,
  policy: PreparationPolicy,
): Promise<void> {
  const protocol = protocolDefinition.protocol;
  const context: RemotePreparationContext = {
    agent,
    ownerDid,
    signal                : policy.signal,
    targetDid             : policy.targetDid,
    verifyRemoteArtifacts : policy.verifyRemoteArtifacts,
  };
  policy.signal?.throwIfAborted();

  const { queryResult, existingEntry, setupStatus } = await runPreparationStage(
    'local-query',
    protocol,
    ownerDid,
    async () => queryLocalProtocolStatus(ownerDid, agent, protocolDefinition, policy.definitionPolicy),
  );
  policy.signal?.throwIfAborted();

  if (policy.endpointPolicy === 'local-only') {
    if (setupStatus !== 'configured') {
      await configureAndVerifyLocalProtocol(ownerDid, agent, protocolDefinition, policy);
    }
    return;
  }

  const dwnEndpointUrls = await runPreparationStage(
    'endpoint-resolution',
    protocol,
    policy.targetDid,
    async () => resolveDwnEndpointUrls(
      policy.targetDid,
      agent,
      policy.remoteEndpointsOnly,
      policy.endpointPolicy === 'required',
    ),
  );

  // Connect approval preserves its historical local-only fallback; explicit
  // application readiness fails when required publication has nowhere to go.
  if (dwnEndpointUrls.length === 0) {
    if (policy.endpointPolicy === 'required') {
      throw new ProtocolPreparationError({
        message   : `No remote DWN endpoints are advertised for '${policy.targetDid}'.`,
        protocol,
        stage     : 'endpoint-resolution',
        targetDid : policy.targetDid,
      });
    }
    if (setupStatus !== 'configured') {
      await configureAndVerifyLocalProtocol(ownerDid, agent, protocolDefinition, policy);
    }
    return;
  }

  if (queryResult.message === undefined) {
    throw new ProtocolPreparationError({
      message   : 'Could not query protocol: no signed query message was returned.',
      protocol,
      stage     : 'local-query',
      targetDid : ownerDid,
    });
  }
  const queryMessage = queryResult.message;

  // Verify every reachable endpoint before changing state. Connect approval
  // rejects requester-driven conflicts; owner readiness treats them as an
  // authorized update target.
  const reachableReplies = await runPreparationStage(
    'remote-query',
    protocol,
    policy.targetDid,
    async () => queryReachableProtocolEndpoints(context, dwnEndpointUrls, queryMessage, protocol),
  );
  const remoteStates = await runPreparationStage(
    'remote-query',
    protocol,
    policy.targetDid,
    async () => getRemoteProtocolStates(
      reachableReplies,
      protocolDefinition,
      ownerDid,
      agent,
      policy.definitionPolicy,
    ),
  );
  const { configureMessage, endpointsNeedingConfigure } = await planRemoteConvergence({
    agent,
    existingEntry,
    ownerDid,
    policy,
    protocolDefinition,
    remoteStates,
    setupStatus,
  });

  if (endpointsNeedingConfigure.length === 0) {
    return;
  }

  // Per-endpoint failure reasons accumulated across dependencies, the exact
  // configure fan-out, and the convergence re-query.
  const endpointFailures = new Map<string, EndpointFailureDetail>();
  await runPreparationStage(
    'remote-publish',
    protocol,
    policy.targetDid,
    async () => ensureRemoteUsesDependencies(
      context,
      protocolDefinition,
      endpointsNeedingConfigure,
      new Set([protocol]),
      endpointFailures,
    ),
  );
  await runPreparationStage(
    'remote-publish',
    protocol,
    policy.targetDid,
    async () => sendConfigureToEndpoints(
      context,
      configureMessage,
      endpointsNeedingConfigure,
      'configure',
      endpointFailures,
    ),
  );
  await runPreparationStage(
    'remote-verify',
    protocol,
    policy.targetDid,
    async () => verifyEndpointsConverged(
      endpointsNeedingConfigure,
      context,
      queryMessage,
      protocolDefinition,
      endpointFailures,
      policy.exactMessageConvergence ? configureMessage : undefined,
    ),
  );
}

async function configureAndVerifyLocalProtocol(
  ownerDid: string,
  agent: EnboxPlatformAgent,
  protocolDefinition: DwnProtocolDefinition,
  policy: PreparationPolicy,
): Promise<ProtocolConfigureEntry> {
  policy.signal?.throwIfAborted();
  const configureMessage = await runPreparationStage(
    'local-configure',
    protocolDefinition.protocol,
    ownerDid,
    async () => configureProtocolLocally(ownerDid, agent, protocolDefinition),
  );
  if (policy.definitionPolicy === 'reject') {
    policy.signal?.throwIfAborted();
    return configureMessage;
  }

  const local = await runPreparationStage(
    'local-configure',
    protocolDefinition.protocol,
    ownerDid,
    async () => queryLocalProtocolStatus(ownerDid, agent, protocolDefinition, 'reject'),
  );
  if (local.setupStatus !== 'configured') {
    throw new ProtocolPreparationError({
      message   : `Local protocol '${protocolDefinition.protocol}' did not converge after configure.`,
      protocol  : protocolDefinition.protocol,
      stage     : 'local-configure',
      targetDid : ownerDid,
    });
  }
  if (local.existingEntry === undefined) {
    throw new ProtocolPreparationError({
      message   : `Local protocol '${protocolDefinition.protocol}' has no current configure artifact after configure.`,
      protocol  : protocolDefinition.protocol,
      stage     : 'local-configure',
      targetDid : ownerDid,
    });
  }
  policy.signal?.throwIfAborted();
  return local.existingEntry;
}

async function runPreparationStage<T>(
  stage: ProtocolPreparationStage,
  protocol: string,
  targetDid: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (cause: unknown) {
    if (cause instanceof ProtocolPreparationError) {
      throw cause;
    }
    throw new ProtocolPreparationError({
      cause,
      endpointFailures: cause instanceof RemoteProtocolResponseVerificationError
        ? [{ detail: cause.message, endpoint: cause.dwnUrl }]
        : undefined,
      message: cause instanceof Error ? cause.message : String(cause),
      protocol,
      stage,
      targetDid,
    });
  }
}

/**
 * Records the first failure reason observed for an endpoint. Dependency
 * failures are recorded before dependent ones, so first-wins keeps the root
 * cause rather than its knock-on effect.
 */
function recordEndpointFailure(
  endpointFailures: Map<string, EndpointFailureDetail>,
  dwnUrl: string,
  reason: string,
  status?: Status,
): void {
  if (!endpointFailures.has(dwnUrl)) {
    endpointFailures.set(dwnUrl, {
      detail : reason,
      status : status === undefined ? undefined : { ...status },
    });
  }
}

/**
 * Sends a stored or freshly signed configure message to each endpoint,
 * recording — never throwing — per-endpoint failures: transport rejections
 * and non-2xx DWN replies alike. Any 2xx response and `409` (an identical or
 * newer configure already exists) count as delivered; the convergence
 * postcondition remains the arbiter.
 */
async function sendConfigureToEndpoints(
  remote: RemotePreparationContext,
  configureMessage: ProtocolConfigureEntry,
  dwnUrls: string[],
  operationContext: string,
  endpointFailures: Map<string, EndpointFailureDetail>,
): Promise<void> {
  const sendResults = await mapConcurrentSettled(
    dwnUrls,
    PROTOCOL_FANOUT_CONCURRENCY,
    (dwnUrl) => sendProtocolEndpointRequest(remote, dwnUrl, configureMessage as GenericMessage),
  );

  for (const [taskIndex, settled] of sendResults.entries()) {
    const dwnUrl = dwnUrls[taskIndex];
    if (settled.status === 'rejected') {
      logger.error(`prepareProtocol: ${operationContext} send to ${dwnUrl} failed: ${settled.reason}`);
      recordEndpointFailure(endpointFailures, dwnUrl, `${operationContext} send failed: ${settled.reason}`);
      continue;
    }
    const { status } = settled.value;
    if (!isProtocolConfigureSuccess(status)) {
      logger.error(`prepareProtocol: endpoint ${dwnUrl} rejected ${operationContext} (${status.code}): ${status.detail}`);
      recordEndpointFailure(
        endpointFailures,
        dwnUrl,
        `${operationContext} rejected (${status.code}): ${status.detail}`,
        status,
      );
    }
  }
}

/** Records the same failure reason for every endpoint in `dwnUrls` (first-wins per endpoint, see {@link recordEndpointFailure}). */
function recordEndpointFailures(
  endpointFailures: Map<string, EndpointFailureDetail>,
  dwnUrls: string[],
  reason: string,
): void {
  for (const dwnUrl of dwnUrls) {
    recordEndpointFailure(endpointFailures, dwnUrl, reason);
  }
}

/**
 * Resolves a `uses` target's locally stored configure entry via a local
 * `ProtocolsQuery`. Returns the entry and signed query message on success, or a
 * failure reason describing why the dependency could not be read or is not
 * installed locally — left for the caller to record per endpoint.
 */
async function resolveLocalUsesDependency(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  targetUri: string,
): Promise<
  | { entry: ProtocolConfigureEntry; message: ProtocolsQueryMessage }
  | { failureReason: string }
> {
  const localQuery = await agent.processDwnRequest({
    author        : selectedDid,
    messageType   : DwnInterface.ProtocolsQuery,
    target        : selectedDid,
    messageParams : { filter: { protocol: targetUri } },
  });

  if (localQuery.reply.status.code !== 200 || localQuery.message === undefined) {
    return { failureReason: `could not read local uses dependency '${targetUri}': ${localQuery.reply.status.detail}` };
  }

  const dependencyEntry = localQuery.reply.entries?.[0] as ProtocolConfigureEntry | undefined;
  if (dependencyEntry === undefined) {
    return { failureReason: `uses dependency '${targetUri}' is not installed locally` };
  }

  return { entry: dependencyEntry, message: localQuery.message };
}

/**
 * Queries every endpoint for the `uses` dependency and returns the ones that
 * are missing it (unreachable or rejecting endpoints are recorded as failures,
 * not treated as missing — the dependent's own configure/postcondition reports
 * those).
 */
async function findEndpointsMissingUsesDependency(
  dwnUrls: string[],
  context: RemotePreparationContext,
  localQueryMessage: ProtocolsQueryMessage,
  targetUri: string,
  endpointFailures: Map<string, EndpointFailureDetail>,
): Promise<string[]> {
  const dependencyQueries = await mapConcurrentSettled(
    dwnUrls,
    PROTOCOL_FANOUT_CONCURRENCY,
    (dwnUrl) => sendProtocolEndpointRequest(context, dwnUrl, localQueryMessage),
  );

  const endpointsMissingDependency: string[] = [];
  for (const [taskIndex, settled] of dependencyQueries.entries()) {
    const dwnUrl = dwnUrls[taskIndex];
    if (settled.status === 'rejected') {
      recordEndpointFailure(
        endpointFailures,
        dwnUrl,
        `could not verify uses dependency '${targetUri}': ${settled.reason}`,
      );
      continue;
    }
    if (settled.value.status.code !== 200) {
      recordEndpointFailure(
        endpointFailures,
        dwnUrl,
        `uses dependency '${targetUri}' query rejected (${settled.value.status.code}): ${settled.value.status.detail}`,
        settled.value.status,
      );
      continue;
    }
    if ((settled.value.entries?.length ?? 0) === 0) {
      endpointsMissingDependency.push(dwnUrl);
    }
  }
  return endpointsMissingDependency;
}

/**
 * Ensures every `uses` dependency of a composed protocol is installed on the
 * given endpoints before the dependent's configure is sent: the DWN rejects a
 * composed `ProtocolsConfigure` when a `uses` target is not installed for the
 * tenant, and the connect batch only orders dependencies the requester also
 * asked for. Dependencies are propagated from the provider's locally stored
 * configure entries, depth-first so transitive dependencies land first; a
 * dependency that is missing locally is recorded per endpoint and left to the
 * dependent's own configure/postcondition to report.
 */
async function ensureRemoteUsesDependencies(
  context: RemotePreparationContext,
  protocolDefinition: DwnProtocolDefinition,
  dwnUrls: string[],
  visited: Set<string>,
  endpointFailures: Map<string, EndpointFailureDetail>,
): Promise<void> {
  const usesTargets = Object.values(protocolDefinition.uses ?? {}).filter(
    (targetUri): targetUri is string => typeof targetUri === 'string' && !visited.has(targetUri),
  );

  for (const targetUri of usesTargets) {
    visited.add(targetUri);

    const localDependency = await resolveLocalUsesDependency(context.ownerDid, context.agent, targetUri);
    if ('failureReason' in localDependency) {
      recordEndpointFailures(endpointFailures, dwnUrls, localDependency.failureReason);
      continue;
    }

    const { entry: dependencyEntry, message: localQueryMessage } = localDependency;

    // Transitive dependencies land before this dependency.
    const dependencyDefinition = getProtocolDefinitionFromEntry(dependencyEntry);
    if (dependencyDefinition !== undefined) {
      await ensureRemoteUsesDependencies(
        context,
        dependencyDefinition,
        dwnUrls,
        visited,
        endpointFailures,
      );
    }

    // Find the endpoints missing this dependency…
    const endpointsMissingDependency = await findEndpointsMissingUsesDependency(
      dwnUrls,
      context,
      localQueryMessage,
      targetUri,
      endpointFailures,
    );

    // …and propagate the locally stored configure entry to them.
    if (endpointsMissingDependency.length > 0) {
      logger.log(
        `prepareProtocol: propagating uses dependency '${targetUri}' of '${protocolDefinition.protocol}' `
        + `to ${endpointsMissingDependency.length} endpoint(s)`,
      );
      await sendConfigureToEndpoints(
        context,
        dependencyEntry,
        endpointsMissingDependency,
        `uses dependency '${targetUri}' configure`,
        endpointFailures,
      );
    }
  }
}

/**
 * Configures the protocol on the provider's local DWN, deriving and injecting
 * `$keyAgreement` keys when any type requires encryption, and returns the
 * signed configure message for endpoint fan-out.
 */
async function configureProtocolLocally(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  protocolDefinition: DwnProtocolDefinition,
): Promise<ProtocolConfigureEntry> {
  logger.log(`Configuring protocol locally: ${protocolDefinition.protocol}`);
  const { reply, message } = await agent.processDwnRequest({
    author        : selectedDid,
    target        : selectedDid,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition: protocolDefinition },
  });

  if (!isProtocolConfigureSuccess(reply.status)) {
    throw new ProtocolPreparationError({
      message   : `Could not configure protocol locally: ${reply.status.detail}`,
      protocol  : protocolDefinition.protocol,
      stage     : 'local-configure',
      status    : { ...reply.status },
      targetDid : selectedDid,
    });
  }
  if (message === undefined) {
    throw new Error('Could not configure protocol: no signed configure message was returned.');
  }

  return message as ProtocolConfigureEntry;
}
