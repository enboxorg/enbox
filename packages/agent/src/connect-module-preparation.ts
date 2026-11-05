/**
 * Per-module preparation for the connect approval ceremony.
 *
 * {@link prepareModule} makes a requested module usable for delegated
 * grants before {@link import('./connect-approval.js').executeConnectApproval}
 * creates them, with fail-closed verification:
 *
 * 1. Rejects requester-supplied `$keyAgreement` / `$encryption` metadata and
 *    non-normalized module URIs — encryption keys are always derived from
 *    the provider's own root key, never accepted from a request.
 * 2. Compares the locally installed definition against the requested one
 *    (ignoring wallet-managed encryption metadata) and verifies every
 *    installed `$keyAgreement` public key against the provider's key deriver
 *    by JWK thumbprint. A mismatch is a conflict and aborts the approval; an
 *    owner-approved authored-definition mismatch can be replaced, while a
 *    policy-identical install that is missing keys is an encryption upgrade.
 * 3. Installs or upgrades locally (`ModulesConfigure` with encryption
 *    derivation when any type declares `encryptionRequired: true`).
 * 4. Verifies every reachable owner DWN endpoint: a reachable endpoint that
 *    rejects the module query, an unapproved definition conflict, a key
 *    conflict, or zero reachable endpoints (when any resolve) aborts approval.
 * 5. Propagates out-of-batch `uses` dependencies (from the provider's local
 *    installs, depth-first) to endpoints that are missing the dependent —
 *    the DWN rejects a composed `ModulesConfigure` when a `uses` target is
 *    not installed for the tenant.
 * 6. Fans the current configure message out to endpoints that are missing or
 *    behind, then re-queries each changed endpoint and requires it to
 *    converge to the requested definition — attaching the per-endpoint
 *    failure reasons (rejected sends, non-2xx replies, non-converged states)
 *    to the error instead of swallowing them.
 */

import type { EnboxPlatformAgent } from './types/agent.js';
import type { DwnModuleDefinition, DwnResponse } from './types/dwn.js';
import type { EncryptionKeyDeriver, ModulesQueryMessage } from '@enbox/dwn-sdk-js';

import { computeJwkThumbprint } from '@enbox/crypto';
import { logger } from '@enbox/common';
import { authoredModuleDefinitionsEqual, KeyDerivationScheme, Modules } from '@enbox/dwn-sdk-js';

import { DwnInterface } from './types/dwn.js';
import { mapConcurrentSettled } from './utils.js';
import { resolveConnectDwnEndpointUrls } from './connect-network.js';

// ---------------------------------------------------------------------------
// Tunables (mirrors the connect-approval fan-out budgets)
// ---------------------------------------------------------------------------

/** Maximum concurrent endpoint requests per fan-out. */
const MODULE_FANOUT_CONCURRENCY = 8;

/**
 * Per-request abort budget for endpoint queries/sends so a single unhealthy
 * endpoint cannot stall the interactive "Authorizing…" path.
 */
const MODULE_REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Setup-status analysis
// ---------------------------------------------------------------------------

/** Resolved preparation state of one module against one DWN. */
export type ModuleSetupStatus = 'configured' | 'conflict' | 'install' | 'upgrade';

/** Result of inspecting one requested module against the owner's local DWN. */
export type ConnectModuleInspection = Readonly<{
  status: ModuleSetupStatus;
  installedDefinition?: DwnModuleDefinition;
  conflictReason?: string;
  /** `true` when explicit owner consent may safely replace the installed authored definition. */
  definitionOverrideEligible?: true;
}>;

/** Parameters for {@link inspectConnectModule}. */
export type InspectConnectModuleParams = {
  agent: ConnectModuleInspectionAgent;
  ownerDid: string;
  definition: DwnModuleDefinition;
};

type ConnectModuleInspectionAgent = Pick<EnboxPlatformAgent, 'dwn' | 'processDwnRequest'>;

type PrepareModuleOptions = {
  /** Allow replacement only when the authored module definition differs. */
  allowDefinitionOverride?: boolean;

  /** Approval-wide endpoint snapshot, avoiding repeated DID resolution. */
  resolvedDwnEndpointUrls?: readonly string[];
};

type ModuleQueryReply = {
  status: { code: number; detail: string };
  entries?: ModuleConfigureEntry[];
};

type ModuleConfigureEntry = {
  descriptor?: {
    definition?: DwnModuleDefinition;
  };
};

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
 * Whether the module URI is already in normalized URL form. Definition
 * comparison and grant scopes key off the exact URI string, so an
 * un-normalized variant of an installed module must be treated as a
 * conflict rather than a fresh install.
 */
function isNormalizedModuleUri(module: string): boolean {
  try {
    const url = new URL(module);
    url.search = '';
    url.hash = '';
    const normalized = url.href.endsWith('/') ? url.href.slice(0, -1) : url.href;
    return normalized === module;
  } catch {
    return false;
  }
}

/** Whether any type in the definition declares `encryptionRequired: true`. */
export function hasEncryptedModuleTypes(moduleDefinition: DwnModuleDefinition): boolean {
  return Modules.requiresKeyAgreement(moduleDefinition);
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
  installedDefinition: DwnModuleDefinition,
  requestedDefinition: DwnModuleDefinition,
  keyDeriver: EncryptionKeyDeriver,
): Promise<EncryptionKeyState> {
  let missing = false;
  const basePath = [KeyDerivationScheme.ModulePath, requestedDefinition.module];
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
export function getModuleSetupStatus(
  installedDefinition: DwnModuleDefinition | undefined,
  requestedDefinition: DwnModuleDefinition,
): ModuleSetupStatus {
  if (!isNormalizedModuleUri(requestedDefinition.module)) {
    return 'conflict';
  }
  if (containsRequesterManagedEncryptionKeys(requestedDefinition)) {
    return 'conflict';
  }

  if (!installedDefinition) {
    return 'install';
  }

  if (!authoredModuleDefinitionsEqual(installedDefinition, requestedDefinition)) {
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
async function getVerifiedModuleSetupStatus(
  installedDefinition: DwnModuleDefinition | undefined,
  requestedDefinition: DwnModuleDefinition,
  selectedDid: string,
  agent: ConnectModuleInspectionAgent,
): Promise<ModuleSetupStatus> {
  const structuralStatus = getModuleSetupStatus(installedDefinition, requestedDefinition);
  if (
    structuralStatus === 'conflict'
    || structuralStatus === 'install'
    || !hasEncryptedModuleTypes(requestedDefinition)
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

function getModuleSetupConflictMessage(
  installedDefinition: DwnModuleDefinition | undefined,
  requestedDefinition: DwnModuleDefinition,
): string {
  if (!isNormalizedModuleUri(requestedDefinition.module)) {
    return `Module URI '${requestedDefinition.module}' is not normalized.`;
  }
  if (containsRequesterManagedEncryptionKeys(requestedDefinition)) {
    return `Module '${requestedDefinition.module}' contains wallet-managed encryption keys. `
      + 'Requesters must provide the module definition without $keyAgreement metadata.';
  }

  if (
    installedDefinition !== undefined &&
    !authoredModuleDefinitionsEqual(installedDefinition, requestedDefinition)
  ) {
    const replacementRequirement = 'Replacement requires explicit owner approval and owner-derived encryption keys.';
    return `Module '${requestedDefinition.module}' is already installed with a different definition. ${replacementRequirement}`;
  }

  return `Module '${requestedDefinition.module}' has encryption keys that do not match this wallet owner.`;
}

/** Whether explicit owner consent may replace this conflict safely. */
async function isReplaceableAuthoredDefinitionConflict(
  installedDefinition: DwnModuleDefinition | undefined,
  requestedDefinition: DwnModuleDefinition,
  selectedDid: string,
  agent: ConnectModuleInspectionAgent,
): Promise<boolean> {
  if (
    installedDefinition === undefined
    || !isNormalizedModuleUri(requestedDefinition.module)
    || containsRequesterManagedEncryptionKeys(requestedDefinition)
    || authoredModuleDefinitionsEqual(installedDefinition, requestedDefinition)
  ) {
    return false;
  }

  // An authored-definition mismatch short-circuits the normal setup-status
  // check before it inspects encryption keys. Verify the installed definition
  // independently so definition consent cannot also authorize replacing keys
  // derived by a different wallet owner.
  if (!hasEncryptedModuleTypes(installedDefinition)) {
    return true;
  }
  const keyDeriver = await agent.dwn.getEncryptionKeyDeriver(selectedDid);
  return await getInstalledEncryptionKeyState(
    installedDefinition,
    installedDefinition,
    keyDeriver,
  ) !== 'conflict';
}

function getModuleDefinitionFromEntry(
  entry: ModuleConfigureEntry | undefined,
): DwnModuleDefinition | undefined {
  return entry?.descriptor?.definition;
}

// ---------------------------------------------------------------------------
// Preparation flow
// ---------------------------------------------------------------------------

/**
 * Runs the local `ModulesQuery` for the requested module and computes its
 * verified setup status. This is the shared read used by public inspection and
 * the mutating preparation path.
 */
async function queryLocalModuleStatus(
  selectedDid: string,
  agent: ConnectModuleInspectionAgent,
  moduleDefinition: DwnModuleDefinition,
): Promise<{
  queryResult: DwnResponse<DwnInterface.ModulesQuery>;
  existingEntry: ModuleConfigureEntry | undefined;
  installedDefinition: DwnModuleDefinition | undefined;
  setupStatus: ModuleSetupStatus;
}> {
  const queryResult = await agent.processDwnRequest({
    author        : selectedDid,
    messageType   : DwnInterface.ModulesQuery,
    target        : selectedDid,
    messageParams : { filter: { module: moduleDefinition.module } },
  });

  if (queryResult.reply.status.code !== 200) {
    throw new Error(`Could not fetch module: ${queryResult.reply.status.detail}`);
  }

  const existingEntry = queryResult.reply.entries?.[0] as ModuleConfigureEntry | undefined;
  const installedDefinition = getModuleDefinitionFromEntry(existingEntry);
  const setupStatus = await getVerifiedModuleSetupStatus(
    installedDefinition,
    moduleDefinition,
    selectedDid,
    agent,
  );

  return { queryResult, existingEntry, installedDefinition, setupStatus };
}

/**
 * Inspect a requested Connect module without configuring local or remote
 * state. Enbox owns DWN normalization, requester-key rejection, authored
 * definition comparison, and owner-derived encryption-key verification;
 * wallets retain canonical-definition pinning and explicit override policy.
 */
export async function inspectConnectModule({
  agent,
  ownerDid,
  definition,
}: InspectConnectModuleParams): Promise<ConnectModuleInspection> {
  const { installedDefinition, setupStatus } = await queryLocalModuleStatus(ownerDid, agent, definition);
  const conflictReason = setupStatus === 'conflict'
    ? getModuleSetupConflictMessage(installedDefinition, definition)
    : undefined;
  const definitionOverrideEligible = setupStatus === 'conflict'
    && await isReplaceableAuthoredDefinitionConflict(installedDefinition, definition, ownerDid, agent);

  return {
    status: setupStatus,
    ...(installedDefinition === undefined ? {} : { installedDefinition }),
    ...(conflictReason === undefined ? {} : { conflictReason }),
    ...(definitionOverrideEligible ? { definitionOverrideEligible: true } : {}),
  };
}

/**
 * Queries every candidate endpoint for the module and returns the replies from
 * the ones that were reachable, logging (not throwing on) unreachable endpoints.
 * Throws if a reachable endpoint rejects the query, or if none were reachable.
 */
async function queryReachableModuleEndpoints(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  dwnEndpointUrls: readonly string[],
  queryMessage: ModulesQueryMessage,
  moduleUri: string,
): Promise<Array<{ dwnUrl: string; reply: ModuleQueryReply }>> {
  const remoteQueryResults = await mapConcurrentSettled(
    dwnEndpointUrls,
    MODULE_FANOUT_CONCURRENCY,
    async (dwnUrl) => ({
      dwnUrl,
      reply: await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : selectedDid,
        message   : queryMessage,
        signal    : AbortSignal.timeout(MODULE_REQUEST_TIMEOUT_MS),
      }) as ModuleQueryReply,
    }),
  );

  const reachableReplies: Array<{ dwnUrl: string; reply: ModuleQueryReply }> = [];
  for (const [taskIndex, settled] of remoteQueryResults.entries()) {
    if (settled.status === 'rejected') {
      logger.error(`prepareModule: could not query ${dwnEndpointUrls[taskIndex]}: ${settled.reason}`);
      continue;
    }
    if (settled.value.reply.status.code !== 200) {
      throw new Error(
        `Could not verify module on ${settled.value.dwnUrl}: ${settled.value.reply.status.detail}`,
      );
    }
    reachableReplies.push(settled.value);
  }

  if (reachableReplies.length === 0) {
    throw new Error(`Could not verify the module definition for '${moduleUri}' on any DWN endpoint.`);
  }

  return reachableReplies;
}

/** Inspect independent endpoint definitions concurrently, preserving endpoint order when reporting conflicts. */
async function inspectRemoteModuleStates(
  reachableReplies: Array<{ dwnUrl: string; reply: ModuleQueryReply }>,
  moduleDefinition: DwnModuleDefinition,
  selectedDid: string,
  agent: EnboxPlatformAgent,
  allowDefinitionOverride: boolean,
): Promise<Array<{ dwnUrl: string; setupStatus: ModuleSetupStatus }>> {
  const inspections = await mapConcurrentSettled(
    reachableReplies,
    MODULE_FANOUT_CONCURRENCY,
    async ({ dwnUrl, reply }) => {
      const installedDefinition = getModuleDefinitionFromEntry(reply.entries?.[0]);
      const setupStatus = await getVerifiedModuleSetupStatus(
        installedDefinition,
        moduleDefinition,
        selectedDid,
        agent,
      );
      if (setupStatus === 'conflict' && !(
        allowDefinitionOverride
        && await isReplaceableAuthoredDefinitionConflict(
          installedDefinition,
          moduleDefinition,
          selectedDid,
          agent,
        )
      )) {
        throw new Error(
          `Module '${moduleDefinition.module}' conflicts with the latest definition or encryption keys on ${dwnUrl}.`,
        );
      }
      return { dwnUrl, setupStatus };
    },
  );
  return inspections.map(inspection => {
    if (inspection.status === 'rejected') {
      throw inspection.reason;
    }
    return inspection.value;
  });
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
  queryMessage: ModulesQueryMessage,
  moduleDefinition: DwnModuleDefinition,
  endpointFailures: Map<string, string>,
): Promise<void> {
  const verifiedPostconditions = await mapConcurrentSettled(
    endpointsNeedingConfigure,
    MODULE_FANOUT_CONCURRENCY,
    async (dwnUrl): Promise<{ converged: boolean; observed: string }> => {
      const reply = await agent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : selectedDid,
        message   : queryMessage,
        signal    : AbortSignal.timeout(MODULE_REQUEST_TIMEOUT_MS),
      }) as ModuleQueryReply;

      if (reply.status.code !== 200) {
        return {
          converged : false,
          observed  : `verification re-query rejected (${reply.status.code}): ${reply.status.detail}`,
        };
      }

      const verifiedStatus = await getVerifiedModuleSetupStatus(
        getModuleDefinitionFromEntry(reply.entries?.[0]),
        moduleDefinition,
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
      `Could not verify the latest module definition on every reachable DWN endpoint for '${moduleDefinition.module}'. `
      + failedEndpoints.join('; '),
    );
  }
}

/**
 * Prepares one requested module on the provider's DWNs for the approval
 * ceremony. See the module JSDoc for the full contract.
 *
 * @throws Error on an unapproved definition conflict, any key conflict, a
 *         reachable endpoint rejecting the module query, zero reachable
 *         endpoints when any resolve, a failed local configure, or endpoints
 *         that do not converge to the requested definition after fan-out.
 * @param options - Preparation policy and optional approval-wide endpoint snapshot.
 */
export async function prepareModule(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  moduleDefinition: DwnModuleDefinition,
  options: PrepareModuleOptions = {},
): Promise<void> {
  const {
    queryResult,
    existingEntry,
    installedDefinition,
    setupStatus,
  } = await queryLocalModuleStatus(selectedDid, agent, moduleDefinition);
  const overridesLocalDefinition = setupStatus === 'conflict'
    && options.allowDefinitionOverride === true
    && await isReplaceableAuthoredDefinitionConflict(
      installedDefinition,
      moduleDefinition,
      selectedDid,
      agent,
    );
  if (setupStatus === 'conflict' && !overridesLocalDefinition) {
    throw new Error(getModuleSetupConflictMessage(installedDefinition, moduleDefinition));
  }

  const dwnEndpointUrls = options.resolvedDwnEndpointUrls
    ?? await resolveConnectDwnEndpointUrls(agent, selectedDid);
  if (queryResult.message === undefined) {
    throw new Error('Could not query module: no signed query message was returned.');
  }
  const queryMessage = queryResult.message;

  // Verify every reachable endpoint BEFORE configuring anything: a remote
  // conflict must abort the approval, not race a concurrent install.
  const reachableReplies = await queryReachableModuleEndpoints(
    selectedDid,
    agent,
    dwnEndpointUrls,
    queryMessage,
    moduleDefinition.module,
  );

  const remoteStates = await inspectRemoteModuleStates(
    reachableReplies,
    moduleDefinition,
    selectedDid,
    agent,
    options.allowDefinitionOverride === true,
  );

  // Install or upgrade locally, then reuse the freshly signed configure for
  // the fan-out; when local state is already current, fan out the stored
  // configure entry instead of re-signing an identical one.
  const configureMessage = setupStatus === 'install' || setupStatus === 'upgrade' || overridesLocalDefinition
    ? await configureModuleLocally(selectedDid, agent, moduleDefinition)
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

  // A composed module's `ModulesConfigure` is rejected by the DWN unless
  // every `uses` target is already installed on that tenant. The connect
  // batch only orders dependencies the requester also asked for, so
  // out-of-batch dependencies (installed locally alongside the dependent)
  // must be propagated to the endpoints that are missing the dependent.
  await ensureRemoteUsesDependencies(moduleDefinition, {
    agent,
    ownerDid           : selectedDid,
    endpointUrls       : endpointsNeedingConfigure,
    visitedModuleUris  : new Set([moduleDefinition.module]),
    failuresByEndpoint : endpointFailures,
  });

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
    moduleDefinition,
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
  configureMessage: ModuleConfigureEntry,
  dwnUrls: string[],
  context: string,
  endpointFailures: Map<string, string>,
): Promise<void> {
  const sendResults = await mapConcurrentSettled(
    dwnUrls,
    MODULE_FANOUT_CONCURRENCY,
    async (dwnUrl) => await agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : selectedDid,
      message   : configureMessage,
      signal    : AbortSignal.timeout(MODULE_REQUEST_TIMEOUT_MS),
    }) as ModuleQueryReply,
  );

  for (const [taskIndex, settled] of sendResults.entries()) {
    const dwnUrl = dwnUrls[taskIndex];
    if (settled.status === 'rejected') {
      logger.error(`prepareModule: ${context} send to ${dwnUrl} failed: ${settled.reason}`);
      recordEndpointFailure(endpointFailures, dwnUrl, `${context} send failed: ${settled.reason}`);
      continue;
    }
    const { status } = settled.value;
    if (status.code !== 202 && status.code !== 409) {
      logger.error(`prepareModule: endpoint ${dwnUrl} rejected ${context} (${status.code}): ${status.detail}`);
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
 * `ModulesQuery`. Returns the entry and signed query message on success, or a
 * failure reason describing why the dependency could not be read or is not
 * installed locally — left for the caller to record per endpoint.
 */
async function resolveLocalUsesDependency(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  targetUri: string,
): Promise<
  | { entry: ModuleConfigureEntry; message: ModulesQueryMessage }
  | { failureReason: string }
> {
  const localQuery = await agent.processDwnRequest({
    author        : selectedDid,
    messageType   : DwnInterface.ModulesQuery,
    target        : selectedDid,
    messageParams : { filter: { module: targetUri } },
  });

  if (localQuery.reply.status.code !== 200 || localQuery.message === undefined) {
    return { failureReason: `could not read local uses dependency '${targetUri}': ${localQuery.reply.status.detail}` };
  }

  const dependencyEntry = localQuery.reply.entries?.[0] as ModuleConfigureEntry | undefined;
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
  localQueryMessage: ModulesQueryMessage,
  targetUri: string,
  endpointFailures: Map<string, string>,
): Promise<string[]> {
  const dependencyQueries = await mapConcurrentSettled(
    dwnUrls,
    MODULE_FANOUT_CONCURRENCY,
    async (dwnUrl) => await agent.rpc.sendDwnRequest({
      dwnUrl,
      targetDid : selectedDid,
      message   : localQueryMessage,
      signal    : AbortSignal.timeout(MODULE_REQUEST_TIMEOUT_MS),
    }) as ModuleQueryReply,
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

/** State shared while prerequisites are propagated to the same owner endpoints. */
type RemoteDependencyPreparation = {
  agent: EnboxPlatformAgent;
  ownerDid: string;
  endpointUrls: string[];
  visitedModuleUris: Set<string>;
  failuresByEndpoint: Map<string, string>;
};

/**
 * Ensures every `uses` dependency of a module is installed before its configure
 * is sent. Existing remote definitions are retained. Shared prerequisites are
 * visited before dependents, with the earliest endpoint failure kept as the cause.
 */
async function ensureRemoteUsesDependencies(
  moduleDefinition: DwnModuleDefinition,
  preparation: RemoteDependencyPreparation,
): Promise<void> {
  const usesTargets = Object.values(moduleDefinition.uses ?? {}).filter(
    (moduleUri): moduleUri is string => typeof moduleUri === 'string' && !preparation.visitedModuleUris.has(moduleUri),
  );

  for (const dependencyUri of usesTargets) {
    preparation.visitedModuleUris.add(dependencyUri);
    // Shared prerequisites must finish before siblings reuse the visited set and failure map.
    await propagateRemoteDependency(moduleDefinition.module, dependencyUri, preparation); // NOSONAR: S9382 — preserve prerequisite order.
  }
}

/** Resolve one local prerequisite, prepare its prerequisites, and publish it only where absent. */
async function propagateRemoteDependency(
  dependentModuleUri: string,
  dependencyUri: string,
  preparation: RemoteDependencyPreparation,
): Promise<void> {
  const { agent, ownerDid, endpointUrls, failuresByEndpoint } = preparation;
  const localDependency = await resolveLocalUsesDependency(ownerDid, agent, dependencyUri);
  if ('failureReason' in localDependency) {
    recordEndpointFailures(failuresByEndpoint, endpointUrls, localDependency.failureReason);
    return;
  }

  const { entry: dependencyEntry, message: localQueryMessage } = localDependency;
  const dependencyDefinition = getModuleDefinitionFromEntry(dependencyEntry);
  if (dependencyDefinition !== undefined) {
    await ensureRemoteUsesDependencies(dependencyDefinition, preparation);
  }

  const endpointsMissingDependency = await findEndpointsMissingUsesDependency(
    endpointUrls,
    ownerDid,
    agent,
    localQueryMessage,
    dependencyUri,
    failuresByEndpoint,
  );
  if (endpointsMissingDependency.length === 0) {
    return;
  }

  logger.log(
    `prepareModule: propagating uses dependency '${dependencyUri}' of '${dependentModuleUri}' `
    + `to ${endpointsMissingDependency.length} endpoint(s)`,
  );
  await sendConfigureToEndpoints(
    ownerDid,
    agent,
    dependencyEntry,
    endpointsMissingDependency,
    `uses dependency '${dependencyUri}' configure`,
    failuresByEndpoint,
  );
}

/**
 * Configures the module on the provider's local DWN, deriving and injecting
 * `$keyAgreement` keys when any type requires encryption, and returns the
 * signed configure message for endpoint fan-out.
 */
async function configureModuleLocally(
  selectedDid: string,
  agent: EnboxPlatformAgent,
  moduleDefinition: DwnModuleDefinition,
): Promise<ModuleConfigureEntry> {
  logger.log(`Configuring module locally: ${moduleDefinition.module}`);
  const { reply, message } = await agent.processDwnRequest({
    author        : selectedDid,
    target        : selectedDid,
    messageType   : DwnInterface.ModulesConfigure,
    messageParams : { definition: moduleDefinition },
  });

  if (reply.status.code !== 202 && reply.status.code !== 409) {
    throw new Error(`Could not configure module locally: ${reply.status.detail}`);
  }
  if (message === undefined) {
    throw new Error('Could not configure module: no signed configure message was returned.');
  }

  return message as ModuleConfigureEntry;
}
