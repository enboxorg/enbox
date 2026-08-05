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
import type { EncryptionKeyDeriver, ProtocolsQueryMessage } from '@enbox/dwn-sdk-js';

import { computeJwkThumbprint } from '@enbox/crypto';
import { KeyDerivationScheme } from '@enbox/dwn-sdk-js';
import { canonicalJsonStringify, logger } from '@enbox/common';

import { DwnInterface } from './types/dwn.js';
import { mapConcurrentSettled } from './utils.js';

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
export type ProtocolSetupStatus = 'configured' | 'conflict' | 'install' | 'upgrade';

type ProtocolQueryReply = {
  status: { code: number; detail: string };
  entries?: ProtocolConfigureEntry[];
};

type ProtocolConfigureEntry = {
  descriptor?: {
    definition?: DwnProtocolDefinition;
  };
};

/**
 * Structural normalization used for definition comparison: wallet-managed
 * encryption metadata (`$keyAgreement` / `$encryption`) is stripped — it is
 * injected at install time by the owner — so only authored policy participates
 * in the comparison.
 */
function stripWalletManagedEncryptionMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripWalletManagedEncryptionMetadata);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => key !== '$keyAgreement' && key !== '$encryption' && entry !== undefined)
      .map(([key, entry]) => [key, stripWalletManagedEncryptionMetadata(entry)]),
  );
}

/** Whether two protocol definitions are policy-identical (encryption metadata aside). */
export function protocolDefinitionsMatch(
  installedDefinition: DwnProtocolDefinition,
  requestedDefinition: DwnProtocolDefinition,
): boolean {
  return canonicalJsonStringify(stripWalletManagedEncryptionMetadata(installedDefinition))
    === canonicalJsonStringify(stripWalletManagedEncryptionMetadata(requestedDefinition));
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
    throw new Error(`Could not fetch protocol: ${queryResult.reply.status.detail}`);
  }

  const existingEntry = queryResult.reply.entries?.[0] as ProtocolConfigureEntry | undefined;
  const installedDefinition = getProtocolDefinitionFromEntry(existingEntry);
  const setupStatus = await getVerifiedProtocolSetupStatus(
    installedDefinition,
    protocolDefinition,
    selectedDid,
    agent,
  );

  if (setupStatus === 'conflict') {
    throw new Error(
      getProtocolSetupConflictMessage(installedDefinition, protocolDefinition)
      ?? `Protocol '${protocolDefinition.protocol}' has encryption keys that do not match this wallet owner.`,
    );
  }

  return { queryResult, existingEntry, setupStatus };
}

/** Resolves the provider's reachable DWN endpoint URLs, treating a resolution failure like zero endpoints. */
async function resolveDwnEndpointUrls(
  selectedDid: string,
  agent: EnboxPlatformAgent,
): Promise<string[]> {
  try {
    return await agent.dwn.getDwnEndpointUrlsForTarget(selectedDid);
  } catch {
    // Endpoint resolution failure — treated like zero endpoints below.
    return [];
  }
}

/**
 * Queries every candidate endpoint for the protocol and returns the replies from
 * the ones that were reachable, logging (not throwing on) unreachable endpoints.
 * Throws if a reachable endpoint rejects the query, or if none were reachable.
 */
async function queryReachableProtocolEndpoints(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  dwnEndpointUrls: string[],
  queryMessage: ProtocolsQueryMessage,
  protocolUri: string,
): Promise<Array<{ dwnUrl: string; reply: ProtocolQueryReply }>> {
  const remoteQueryResults = await mapConcurrentSettled(
    dwnEndpointUrls,
    PROTOCOL_FANOUT_CONCURRENCY,
    async (dwnUrl) => ({
      dwnUrl,
      reply: await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : selectedDid,
        message   : queryMessage,
        signal    : AbortSignal.timeout(PROTOCOL_REQUEST_TIMEOUT_MS),
      }) as ProtocolQueryReply,
    }),
  );

  const reachableReplies: Array<{ dwnUrl: string; reply: ProtocolQueryReply }> = [];
  for (const [taskIndex, settled] of remoteQueryResults.entries()) {
    if (settled.status === 'rejected') {
      logger.error(`prepareProtocol: could not query ${dwnEndpointUrls[taskIndex]}: ${settled.reason}`);
      continue;
    }
    if (settled.value.reply.status.code !== 200) {
      throw new Error(
        `Could not verify protocol on ${settled.value.dwnUrl}: ${settled.value.reply.status.detail}`,
      );
    }
    reachableReplies.push(settled.value);
  }

  if (reachableReplies.length === 0) {
    throw new Error(`Could not verify the protocol definition for '${protocolUri}' on any DWN endpoint.`);
  }

  return reachableReplies;
}

/** Computes each reachable endpoint's verified setup status, throwing on the first remote conflict. */
async function getRemoteProtocolStates(
  reachableReplies: Array<{ dwnUrl: string; reply: ProtocolQueryReply }>,
  protocolDefinition: DwnProtocolDefinition,
  selectedDid: string,
  agent: EnboxPlatformAgent,
): Promise<Array<{ dwnUrl: string; setupStatus: ProtocolSetupStatus }>> {
  const remoteStates: Array<{ dwnUrl: string; setupStatus: ProtocolSetupStatus }> = [];
  for (const { dwnUrl, reply } of reachableReplies) {
    const remoteStatus = await getVerifiedProtocolSetupStatus(
      getProtocolDefinitionFromEntry(reply.entries?.[0]),
      protocolDefinition,
      selectedDid,
      agent,
    );
    if (remoteStatus === 'conflict') {
      throw new Error(
        `Protocol '${protocolDefinition.protocol}' conflicts with the latest definition or encryption keys on ${dwnUrl}.`,
      );
    }
    remoteStates.push({ dwnUrl, setupStatus: remoteStatus });
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
  selectedDid: string,
  agent: EnboxPlatformAgent,
  queryMessage: ProtocolsQueryMessage,
  protocolDefinition: DwnProtocolDefinition,
  endpointFailures: Map<string, string>,
): Promise<void> {
  const verifiedPostconditions = await mapConcurrentSettled(
    endpointsNeedingConfigure,
    PROTOCOL_FANOUT_CONCURRENCY,
    async (dwnUrl): Promise<{ converged: boolean; observed: string }> => {
      const reply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : selectedDid,
        message   : queryMessage,
        signal    : AbortSignal.timeout(PROTOCOL_REQUEST_TIMEOUT_MS),
      }) as ProtocolQueryReply;

      if (reply.status.code !== 200) {
        return {
          converged : false,
          observed  : `verification re-query rejected (${reply.status.code}): ${reply.status.detail}`,
        };
      }

      const verifiedStatus = await getVerifiedProtocolSetupStatus(
        getProtocolDefinitionFromEntry(reply.entries?.[0]),
        protocolDefinition,
        selectedDid,
        agent,
      );
      return {
        converged : verifiedStatus === 'configured',
        observed  : `endpoint still reports '${verifiedStatus}' after configure`,
      };
    },
  );

  const failedEndpoints: string[] = [];
  for (const [taskIndex, settled] of verifiedPostconditions.entries()) {
    const dwnUrl = endpointsNeedingConfigure[taskIndex];
    if (settled.status === 'rejected') {
      const unreachableReason = `unreachable at verification: ${settled.reason}`;
      failedEndpoints.push(`${dwnUrl}: ${endpointFailures.get(dwnUrl) ?? unreachableReason}`);
      continue;
    }
    if (!settled.value.converged) {
      failedEndpoints.push(`${dwnUrl}: ${endpointFailures.get(dwnUrl) ?? settled.value.observed}`);
    }
  }

  if (failedEndpoints.length > 0) {
    throw new Error(
      `Could not verify the latest protocol definition on every reachable DWN endpoint for '${protocolDefinition.protocol}'. `
      + failedEndpoints.join('; '),
    );
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
  const { queryResult, existingEntry, setupStatus } = await queryLocalProtocolStatus(selectedDid, agent, protocolDefinition);

  const dwnEndpointUrls = await resolveDwnEndpointUrls(selectedDid, agent);

  // Local-only mode: nothing to verify or fan out. Grant delivery enforces
  // the ≥1-endpoint invariant immediately afterwards, so an approval against
  // a provider with no reachable DWN still cannot complete.
  if (dwnEndpointUrls.length === 0) {
    if (setupStatus === 'install' || setupStatus === 'upgrade') {
      await configureProtocolLocally(selectedDid, agent, protocolDefinition);
    }
    return;
  }

  if (queryResult.message === undefined) {
    throw new Error('Could not query protocol: no signed query message was returned.');
  }
  const queryMessage = queryResult.message;

  // Verify every reachable endpoint BEFORE configuring anything: a remote
  // conflict must abort the approval, not race a concurrent install.
  const reachableReplies = await queryReachableProtocolEndpoints(
    selectedDid,
    agent,
    dwnEndpointUrls,
    queryMessage,
    protocolDefinition.protocol,
  );

  const remoteStates = await getRemoteProtocolStates(reachableReplies, protocolDefinition, selectedDid, agent);

  // Install or upgrade locally, then reuse the freshly signed configure for
  // the fan-out; when local state is already current, fan out the stored
  // configure entry instead of re-signing an identical one.
  const configureMessage = setupStatus === 'install' || setupStatus === 'upgrade'
    ? await configureProtocolLocally(selectedDid, agent, protocolDefinition)
    : existingEntry;

  const endpointsNeedingConfigure = remoteStates
    .filter((state) => state.setupStatus !== 'configured')
    .map((state) => state.dwnUrl);

  if (endpointsNeedingConfigure.length === 0) {
    return;
  }

  // Per-endpoint failure reasons accumulated across the dependency sends,
  // the configure send, and the convergence re-query. The first recorded
  // reason per endpoint wins (dependency failures precede dependent ones),
  // and the reasons are attached to the postcondition error so the true
  // endpoint-side cause is never swallowed.
  const endpointFailures = new Map<string, string>();

  // A composed protocol's `ProtocolsConfigure` is rejected by the DWN unless
  // every `uses` target is already installed on that tenant. The connect
  // batch only orders dependencies the requester also asked for, so
  // out-of-batch dependencies (installed locally alongside the dependent)
  // must be propagated to the endpoints that are missing the dependent.
  await ensureRemoteUsesDependencies(
    selectedDid,
    agent,
    protocolDefinition,
    endpointsNeedingConfigure,
    new Set([protocolDefinition.protocol]),
    endpointFailures,
  );

  // Best-effort send: individual failures are recorded rather than thrown
  // because the postcondition below fails closed — with the reasons attached
  // — on any endpoint that did not converge.
  await sendConfigureToEndpoints(
    selectedDid,
    agent,
    configureMessage!,
    endpointsNeedingConfigure,
    'configure',
    endpointFailures,
  );

  // Postcondition: every endpoint that was missing or behind must now report
  // the requested definition (with the provider's own encryption keys).
  await verifyEndpointsConverged(
    endpointsNeedingConfigure,
    selectedDid,
    agent,
    queryMessage,
    protocolDefinition,
    endpointFailures,
  );
}

/**
 * Records the first failure reason observed for an endpoint. Dependency
 * failures are recorded before dependent ones, so first-wins keeps the root
 * cause rather than its knock-on effect.
 */
function recordEndpointFailure(
  endpointFailures: Map<string, string>,
  dwnUrl: string,
  reason: string,
): void {
  if (!endpointFailures.has(dwnUrl)) {
    endpointFailures.set(dwnUrl, reason);
  }
}

/**
 * Sends a stored or freshly signed configure message to each endpoint,
 * recording — never throwing — per-endpoint failures: transport rejections
 * and non-2xx DWN replies alike. `202` (accepted) and `409` (an identical or
 * newer configure already exists) both count as delivered; the convergence
 * postcondition remains the arbiter.
 */
async function sendConfigureToEndpoints(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  configureMessage: ProtocolConfigureEntry,
  dwnUrls: string[],
  context: string,
  endpointFailures: Map<string, string>,
): Promise<void> {
  const sendResults = await mapConcurrentSettled(
    dwnUrls,
    PROTOCOL_FANOUT_CONCURRENCY,
    async (dwnUrl) => await agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : selectedDid,
      message   : configureMessage,
      signal    : AbortSignal.timeout(PROTOCOL_REQUEST_TIMEOUT_MS),
    }) as ProtocolQueryReply,
  );

  for (const [taskIndex, settled] of sendResults.entries()) {
    const dwnUrl = dwnUrls[taskIndex];
    if (settled.status === 'rejected') {
      logger.error(`prepareProtocol: ${context} send to ${dwnUrl} failed: ${settled.reason}`);
      recordEndpointFailure(endpointFailures, dwnUrl, `${context} send failed: ${settled.reason}`);
      continue;
    }
    const { status } = settled.value;
    if (status.code !== 202 && status.code !== 409) {
      logger.error(`prepareProtocol: endpoint ${dwnUrl} rejected ${context} (${status.code}): ${status.detail}`);
      recordEndpointFailure(endpointFailures, dwnUrl, `${context} rejected (${status.code}): ${status.detail}`);
    }
  }
}

/** Records the same failure reason for every endpoint in `dwnUrls` (first-wins per endpoint, see {@link recordEndpointFailure}). */
function recordEndpointFailures(
  endpointFailures: Map<string, string>,
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
  selectedDid: string,
  agent: EnboxPlatformAgent,
  localQueryMessage: ProtocolsQueryMessage,
  targetUri: string,
  endpointFailures: Map<string, string>,
): Promise<string[]> {
  const dependencyQueries = await mapConcurrentSettled(
    dwnUrls,
    PROTOCOL_FANOUT_CONCURRENCY,
    async (dwnUrl) => await agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : selectedDid,
      message   : localQueryMessage,
      signal    : AbortSignal.timeout(PROTOCOL_REQUEST_TIMEOUT_MS),
    }) as ProtocolQueryReply,
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
  selectedDid: string,
  agent: EnboxPlatformAgent,
  protocolDefinition: DwnProtocolDefinition,
  dwnUrls: string[],
  visited: Set<string>,
  endpointFailures: Map<string, string>,
): Promise<void> {
  const usesTargets = Object.values(protocolDefinition.uses ?? {}).filter(
    (targetUri): targetUri is string => typeof targetUri === 'string' && !visited.has(targetUri),
  );

  for (const targetUri of usesTargets) {
    visited.add(targetUri);

    const localDependency = await resolveLocalUsesDependency(selectedDid, agent, targetUri);
    if ('failureReason' in localDependency) {
      recordEndpointFailures(endpointFailures, dwnUrls, localDependency.failureReason);
      continue;
    }

    const { entry: dependencyEntry, message: localQueryMessage } = localDependency;

    // Transitive dependencies land before this dependency.
    const dependencyDefinition = getProtocolDefinitionFromEntry(dependencyEntry);
    if (dependencyDefinition !== undefined) {
      await ensureRemoteUsesDependencies(
        selectedDid,
        agent,
        dependencyDefinition,
        dwnUrls,
        visited,
        endpointFailures,
      );
    }

    // Find the endpoints missing this dependency…
    const endpointsMissingDependency = await findEndpointsMissingUsesDependency(
      dwnUrls,
      selectedDid,
      agent,
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
        selectedDid,
        agent,
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

  if (reply.status.code !== 202 && reply.status.code !== 409) {
    throw new Error(`Could not configure protocol locally: ${reply.status.detail}`);
  }
  if (message === undefined) {
    throw new Error('Could not configure protocol: no signed configure message was returned.');
  }

  return message as ProtocolConfigureEntry;
}
