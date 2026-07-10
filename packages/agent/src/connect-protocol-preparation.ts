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
 * 5. Fans the current configure message out to endpoints that are missing or
 *    behind, then re-queries each changed endpoint and requires it to
 *    converge to the requested definition.
 *
 * When no remote DWN endpoints resolve for the provider, preparation is
 * local-only — grant delivery enforces the ≥1-endpoint invariant immediately
 * afterwards, so approval still cannot complete against a provider with no
 * reachable DWN.
 */

import type { DwnProtocolDefinition } from './types/dwn.js';
import type { EnboxPlatformAgent } from './types/agent.js';
import type { EncryptionKeyDeriver } from '@enbox/dwn-sdk-js';

import { computeJwkThumbprint } from '@enbox/crypto';
import { KeyDerivationScheme } from '@enbox/dwn-sdk-js';
import { logger } from '@enbox/common';

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

  async function inspectStructure(
    requestedStructure: Record<string, unknown>,
    installedStructure: Record<string, unknown> | undefined,
    parentPath: string[],
  ): Promise<EncryptionKeyState> {
    for (const [nodeName, requestedRuleSet] of Object.entries(requestedStructure)) {
      if (nodeName.startsWith('$')) { continue; }

      const installedRuleSet = installedStructure?.[nodeName] as Record<string, unknown> | undefined;
      if (!installedRuleSet || typeof installedRuleSet !== 'object') { return 'missing'; }
      const currentPath = [...parentPath, nodeName];
      if ((requestedRuleSet as { $ref?: unknown })?.$ref === undefined) {
        const installedKey = (installedRuleSet.$keyAgreement as { publicKeyJwk?: unknown } | undefined)?.publicKeyJwk;
        if (installedKey === undefined) {
          missing = true;
        } else {
          const expectedKey = await keyDeriver.derivePublicKey(currentPath);
          if (!await publicKeysMatch(installedKey, expectedKey)) { return 'conflict'; }
        }
      }

      const childState = await inspectStructure(
        requestedRuleSet as Record<string, unknown>,
        installedRuleSet,
        currentPath,
      );
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

  let dwnEndpointUrls: string[] = [];
  try {
    dwnEndpointUrls = await agent.dwn.getDwnEndpointUrlsForTarget(selectedDid);
  } catch {
    // Endpoint resolution failure — treated like zero endpoints below.
  }

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

  // Verify every reachable endpoint BEFORE configuring anything: a remote
  // conflict must abort the approval, not race a concurrent install.
  const remoteQueryResults = await mapConcurrentSettled(
    dwnEndpointUrls,
    PROTOCOL_FANOUT_CONCURRENCY,
    async (dwnUrl) => ({
      dwnUrl,
      reply: await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : selectedDid,
        message   : queryResult.message!,
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
    throw new Error(`Could not verify the protocol definition for '${protocolDefinition.protocol}' on any DWN endpoint.`);
  }

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

  // Best-effort send: individual failures are tolerated here because the
  // postcondition below fails closed on any endpoint that did not converge.
  const sendResults = await mapConcurrentSettled(
    endpointsNeedingConfigure,
    PROTOCOL_FANOUT_CONCURRENCY,
    (dwnUrl) => agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : selectedDid,
      message   : configureMessage!,
      signal    : AbortSignal.timeout(PROTOCOL_REQUEST_TIMEOUT_MS),
    }),
  );
  for (const [taskIndex, settled] of sendResults.entries()) {
    if (settled.status === 'rejected') {
      logger.error(`prepareProtocol: failed to send configure to ${endpointsNeedingConfigure[taskIndex]}: ${settled.reason}`);
    }
  }

  // Postcondition: every endpoint that was missing or behind must now report
  // the requested definition (with the provider's own encryption keys).
  const verifiedPostconditions = await mapConcurrentSettled(
    endpointsNeedingConfigure,
    PROTOCOL_FANOUT_CONCURRENCY,
    async (dwnUrl) => {
      const reply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : selectedDid,
        message   : queryResult.message!,
        signal    : AbortSignal.timeout(PROTOCOL_REQUEST_TIMEOUT_MS),
      }) as ProtocolQueryReply;

      return reply.status.code === 200
        && await getVerifiedProtocolSetupStatus(
          getProtocolDefinitionFromEntry(reply.entries?.[0]),
          protocolDefinition,
          selectedDid,
          agent,
        ) === 'configured';
    },
  );

  const allConverged = verifiedPostconditions.every(
    (settled) => settled.status === 'fulfilled' && settled.value === true,
  );
  if (!allConverged) {
    throw new Error(
      `Could not verify the latest protocol definition on every reachable DWN endpoint for '${protocolDefinition.protocol}'.`,
    );
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
  const needsEncryption = hasEncryptedProtocolTypes(protocolDefinition);

  const { reply, message } = await agent.processDwnRequest({
    author        : selectedDid,
    target        : selectedDid,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition: protocolDefinition },
    encryption    : needsEncryption || undefined,
  });

  if (reply.status.code !== 202 && reply.status.code !== 409) {
    throw new Error(`Could not configure protocol locally: ${reply.status.detail}`);
  }
  if (message === undefined) {
    throw new Error('Could not configure protocol: no signed configure message was returned.');
  }

  return message as ProtocolConfigureEntry;
}
