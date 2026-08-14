/**
 * Session restore flow.
 *
 * Restores a previously established session from persisted storage,
 * replacing the "previouslyConnected" pattern in apps.
 * @module
 */

import type { AuthSession } from '../identity-session.js';
import type { FlowContext } from './lifecycle.js';
import type { RestoreSessionOptions, StorageAdapter } from '../types.js';

import type { RecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { BearerIdentity, DwnDataEncodedRecordsWriteMessage, EnboxUserAgent } from '@enbox/agent';

import { Convert } from '@enbox/common';
import { DataStream } from '@enbox/dwn-sdk-js';
import { DwnInterface, DwnPermissionGrant } from '@enbox/agent';

import { applyLocalDwnDiscovery } from '../discovery.js';
import { STORAGE_KEYS } from '../types.js';
import { assertFlowActive, commitFlowSession, ensureVaultReady, finalizeSession, registerSyncScopeForIdentity, resolveIdentityDids, resolvePassword, runAuthSessionLifecycle, runFlowMutation, startSyncIfEnabled } from './lifecycle.js';

/**
 * Attempt to restore a previous session.
 *
 * Returns `undefined` if no previous session exists.
 * Returns an `AuthSession` if the session was successfully restored.
 *
 * Two concerns are handled here:
 * 1. Revocation retry maintenance (from a previous partial disconnect)
 * 2. Normal session restore
 * Retry work for another delegate is independent and can run in the same
 * call. Retry evidence bound to the persisted session instead proves that
 * disconnect had begun, so recovery completes teardown and suppresses restore.
 */
export async function restoreSession(
  ctx: FlowContext,
  options: RestoreSessionOptions = {},
): Promise<AuthSession | undefined> {
  const { userAgent, emitter, storage } = ctx;
  assertFlowActive(ctx);

  // Two persisted concerns:
  // 1. PREVIOUSLY_CONNECTED — normal session restore
  // 2. REVOCATION_RETRY_CONTEXT — orphaned revocations from partial disconnect
  // If neither is set, nothing to do.
  const previouslyConnected = await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
  const retryContextJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
  assertFlowActive(ctx);
  const hasRetryContext = retryContextJson !== null;
  if (retryContextJson !== null) {
    parseRevocationRetryEntries(retryContextJson);
  }
  if (previouslyConnected !== 'true' && !hasRetryContext) {
    return undefined;
  }

  const password = await resolveRestorePassword(ctx, options);
  if (password === undefined) {
    return undefined;
  }

  // Start the agent (vault is known to exist).
  await runFlowMutation(ctx, () => ensureVaultReady({
    userAgent,
    emitter,
    password,
    isFirstLaunch: false,
  }));

  // Apply local DWN discovery.
  if (!userAgent.dwn.isRemoteMode) {
    await runFlowMutation(ctx, () => applyLocalDwnDiscovery(userAgent, storage, emitter));
  }

  // --- Retry maintenance and interrupted-disconnect recovery ---
  const interruptedDisconnect = await runRetryMaintenanceIfNeeded(
    ctx, userAgent, storage, hasRetryContext,
  );

  // A retry journal bound to the persisted active delegate means disconnect
  // had already begun before the prior process stopped. Recovery may finish
  // that teardown, but must never resurrect the session being disconnected.
  if (interruptedDisconnect) {
    return undefined;
  }

  // --- Normal session restore ---
  // Capture the complete marker binding after maintenance. The final commit
  // revalidates it under the cross-context lifecycle lock.
  const restoreMarkers = await readSessionMarkerSnapshot(storage);
  assertFlowActive(ctx);
  if (restoreMarkers.previouslyConnected !== 'true') {
    return undefined;
  }

  // Determine which identity to reconnect.
  const identity = await resolveIdentityForRestore(
    userAgent, restoreMarkers.delegateDid, restoreMarkers.activeIdentity,
  );

  if (!identity) {
    return handleMissingRestoreIdentity(ctx, restoreMarkers);
  }

  const { connectedDid, delegateDid } = resolveIdentityDids(
    identity, restoreMarkers.delegateDid ?? undefined,
  );

  return commitFlowSession(ctx, () => finalizeRestoredSession(
    ctx, identity, connectedDid, delegateDid, restoreMarkers,
  ));
}

// ─── restoreSession helpers ─────────────────────────────────────

/**
 * Resolve the vault password for session restore, detecting a stale
 * "previously connected" marker left behind when the vault itself was
 * never initialized (e.g. storage cleared without going through
 * `disconnect()`).
 *
 * Returns `undefined` when the stale-marker cleanup path was taken and
 * `restoreSession()` should abort with no session.
 */
async function resolveRestorePassword(
  ctx: FlowContext,
  options: RestoreSessionOptions,
): Promise<string | undefined> {
  const { userAgent, storage } = ctx;

  // Resolve password.
  let explicitPassword = options.password;
  if (!explicitPassword && !ctx.defaultPassword && options.onPasswordRequired) {
    assertFlowActive(ctx);
    explicitPassword = await options.onPasswordRequired();
    assertFlowActive(ctx);
  }

  // Check for and clear a stale session marker as one persisted-state transition.
  const isFirstLaunch = await runFlowMutation(ctx, () => runAuthSessionLifecycle(async (): Promise<boolean> => {
    const firstLaunch = await userAgent.firstLaunch();
    if (firstLaunch) {
      await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
    }

    return firstLaunch;
  }));
  if (isFirstLaunch) {
    return undefined;
  }

  const password = await resolvePassword(ctx, explicitPassword, false);
  assertFlowActive(ctx);
  return password;
}

/**
 * Retry orphaned grant revocations left over from a partial disconnect.
 * Unrelated remote-maintenance failures remain best-effort. Present malformed
 * evidence, marker-read failures, and failures for the session being torn down
 * fail closed so that restore cannot resurrect an interrupted disconnect.
 */
async function runRetryMaintenanceIfNeeded(
  ctx: FlowContext,
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
  hasRetryContext: boolean,
): Promise<boolean> {
  if (!hasRetryContext) {
    return false;
  }

  const interruptedDisconnect = await runFlowMutation(ctx, () => runAuthSessionLifecycle(
    async (): Promise<boolean> => {
      const currentEntries = await readRevocationRetryEntries(storage);
      const markers = await readSessionMarkerSnapshot(storage);
      const interruptedEntry = findInterruptedDisconnect(markers, currentEntries);

      // A staged journal is the durable disconnect intent. Disable restore
      // before network work so every later failure or process exit is safe.
      if (interruptedEntry !== undefined) {
        await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
      }

      let settledEntries: SettledRetryEntry[] = [];
      try {
        await startSyncIfEnabled(userAgent, ctx.defaultSync);
        settledEntries = await retryRevocationEntries(userAgent, storage, currentEntries);
      } catch {
        // The complete journal remains durable for the next attempt.
      } finally {
        await userAgent.sync.stopSync(2000).catch(() => {});
      }

      if (interruptedEntry !== undefined) {
        await clearSessionMarkers(userAgent, storage);
      }
      await retireSettledDelegateIdentities(userAgent, storage, settledEntries);

      // Retry maintenance for another delegate is best-effort and must not
      // block restoration of the current session.
      return interruptedEntry !== undefined;
    }
  ));
  assertFlowActive(ctx);
  return interruptedDisconnect;
}

/**
 * Resolve which identity to reconnect. Prefers the session's persisted
 * delegate identity: a stale delegate from an earlier session (its grants
 * revoked on disconnect) must not shadow the one the most recent session
 * finalized. `DELEGATE_DID` stores that identity's own DID; `ACTIVE_IDENTITY`
 * stores the connected (owner) DID, which only resolves an identity for
 * local (non-delegate) sessions.
 */
async function resolveIdentityForRestore(
  userAgent: EnboxUserAgent,
  storedDelegateDid: string | null,
  activeIdentityDid: string | null,
): Promise<BearerIdentity | undefined> {
  let identity = storedDelegateDid
    ? await userAgent.identity.get({ didUri: storedDelegateDid })
    : undefined;

  if (!identity && activeIdentityDid) {
    identity = await userAgent.identity.get({ didUri: activeIdentityDid });
  }

  if (!identity) {
    identity = await userAgent.identity.connectedIdentity();
  }

  // Fall back to the first available identity.
  if (!identity) {
    const identities = await userAgent.identity.list();
    identity = identities[0];
  }

  return identity;
}

/**
 * Handle session restore when no identity could be resolved. Distinguishes
 * a genuine agent-only session (created with `createIdentity: false`) from
 * stale session data left over from disconnect, cleaning up the latter.
 */
async function handleMissingRestoreIdentity(
  ctx: FlowContext,
  restoreMarkers: SessionMarkerSnapshot,
): Promise<AuthSession | undefined> {
  const { userAgent, emitter, storage } = ctx;

  // No identity found — this is valid for agent-only sessions created
  // with `createIdentity: false`. Restore a session using the agent DID.
  // If the active identity stored was the agent DID, this is an
  // intentional agent-only session rather than stale data.
  const isAgentOnlySession = restoreMarkers.activeIdentity === userAgent.agentDid.uri;

  if (!isAgentOnlySession) {
    // Truly stale session data — clean up only if the binding is still the
    // snapshot this restore attempt resolved.
    return commitFlowSession(ctx, async (): Promise<undefined> => {
      if (!await isRestoreSnapshotCurrent(storage, restoreMarkers)) {
        return undefined;
      }
      await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
      await storage.remove(STORAGE_KEYS.ACTIVE_IDENTITY);
      await storage.remove(STORAGE_KEYS.DELEGATE_DID);
      await storage.remove(STORAGE_KEYS.CONNECTED_DID);
      await storage.remove(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS);
      await storage.remove(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS);
      await storage.remove(STORAGE_KEYS.SESSION_REVOCATIONS);
      try { await userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS); } catch { /* best-effort */ }
      // Do NOT remove REVOCATION_RETRY_CONTEXT here — it has its own
      // lifecycle managed by the retry maintenance path. Stale session
      // cleanup must not silently drop pending revocations.
      return undefined;
    });
  }

  return commitFlowSession(ctx, async (): Promise<AuthSession | undefined> => {
    if (!await isRestoreSnapshotCurrent(storage, restoreMarkers)) {
      return undefined;
    }
    return finalizeSession({
      userAgent,
      emitter,
      storage,
      connectedDid      : userAgent.agentDid.uri,
      emitIdentityAdded : false,
      signal            : ctx.sessionSignal,
    });
  });
}

/**
 * Finalize a restored delegate or local session: repair sync registration
 * for the resolved identity, clear stale delegate secrets, restart sync,
 * and build the `AuthSession`.
 */
async function finalizeRestoredSession(
  ctx: FlowContext,
  identity: BearerIdentity,
  connectedDid: string,
  delegateDid: string | undefined,
  restoreMarkers: SessionMarkerSnapshot,
): Promise<AuthSession | undefined> {
  const { userAgent, emitter, storage } = ctx;

  if (!await isRestoreSnapshotCurrent(storage, restoreMarkers, connectedDid, delegateDid)) {
    return undefined;
  }

  // Ensure the sync registration is scoped explicitly. Delegate sessions derive
  // scope from grants; local sessions are updated only when the caller provides
  // an explicit identity sync scope.
  let syncRepairFailed = false;
  try {
    await registerSyncScopeForIdentity({
      userAgent,
      connectedDid,
      delegateDid,
      identitySyncProtocols: ctx.defaultIdentitySyncProtocols,
    });
  } catch {
    // Grant query or registration repair failed — don't block restore,
    // but don't let a stale registration remain usable.
    syncRepairFailed = true;
    try { await userAgent.sync.removeIdentity(connectedDid); } catch { /* best-effort cleanup */ }
  }

  if (delegateDid && connectedDid) {
    await storage.remove(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS).catch(() => {});
    await userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS).catch(() => {});
    await storage.remove(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS).catch(() => {});
  }

  if (!syncRepairFailed) {
    await startSyncIfEnabled(userAgent, ctx.defaultSync);
  }

  const extraStorageKeys = delegateDid === undefined
    ? undefined
    : {
      [STORAGE_KEYS.DELEGATE_DID]  : delegateDid,
      [STORAGE_KEYS.CONNECTED_DID] : connectedDid,
    };

  // Session restore does not emit `identity-added` (identity was already added in the original flow).
  return finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    signal               : ctx.sessionSignal,
    identityName         : identity.metadata.name,
    identityConnectedDid : identity.metadata.connectedDid,
    emitIdentityAdded    : false,
    extraStorageKeys,
  });
}

// ─── Revocation retry helpers ───────────────────────────────────

export type RevocationEntry = { grantId: string; revocationGrantId: string };

export type RetryEntry = {
  delegateDid: string;
  connectedDid: string;
  revocations: RevocationEntry[];
};

type SettledRetryEntry = { entry: RetryEntry; identity: BearerIdentity };

const MAX_REVOCATION_RETRY_ENTRIES = 4_096;

type SessionMarkerSnapshot = {
  activeIdentity: string | null;
  connectedDid: string | null;
  delegateDid: string | null;
  previouslyConnected: string | null;
};

/**
 * Load and validate all durable retry entries. Invalid state is retained and
 * rejected so callers never mistake an unreadable journal for completed work.
 */
export async function readRevocationRetryEntries(
  storage: StorageAdapter,
): Promise<RetryEntry[]> {
  const json = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
  if (json === null) {
    return [];
  }

  return parseRevocationRetryEntries(json);
}

function parseRevocationRetryEntries(json: string): RetryEntry[] {
  try {
    const parsed: unknown = JSON.parse(json);

    // Handle legacy single-object format: wrap in array.
    const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (entries.length > MAX_REVOCATION_RETRY_ENTRIES || !entries.every(isRetryEntry)) {
      throw new Error('invalid retry entries');
    }
    const delegateDids = new Set<string>();
    let revocationCount = 0;
    for (const entry of entries) {
      revocationCount += entry.revocations.length;
      if (delegateDids.has(entry.delegateDid) || revocationCount > MAX_REVOCATION_RETRY_ENTRIES) {
        throw new Error('duplicate delegate retry entry');
      }
      delegateDids.add(entry.delegateDid);
    }
    return entries;
  } catch (error: unknown) {
    throw new Error('AuthManager: Revocation retry context is invalid.', { cause: error });
  }
}

async function readSessionMarkerSnapshot(storage: StorageAdapter): Promise<SessionMarkerSnapshot> {
  const [previouslyConnected, activeIdentity, delegateDid, connectedDid] = await Promise.all([
    storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED),
    storage.get(STORAGE_KEYS.ACTIVE_IDENTITY),
    storage.get(STORAGE_KEYS.DELEGATE_DID),
    storage.get(STORAGE_KEYS.CONNECTED_DID),
  ]);
  return { activeIdentity, connectedDid, delegateDid, previouslyConnected };
}

function findInterruptedDisconnect(
  markers: SessionMarkerSnapshot,
  entries: RetryEntry[],
): RetryEntry | undefined {
  if (markers.previouslyConnected !== 'true' || markers.delegateDid === null) {
    return undefined;
  }

  const entry = entries.find(candidate => candidate.delegateDid === markers.delegateDid);
  if (entry === undefined) {
    return undefined;
  }
  if ((markers.connectedDid !== null && markers.connectedDid !== entry.connectedDid) ||
      (markers.activeIdentity !== null && markers.activeIdentity !== entry.connectedDid)) {
    throw new Error('AuthManager: Session marker binding is inconsistent.');
  }
  return entry;
}

async function isRestoreSnapshotCurrent(
  storage: StorageAdapter,
  expected: SessionMarkerSnapshot,
  connectedDid?: string,
  delegateDid?: string,
): Promise<boolean> {
  const current = await readSessionMarkerSnapshot(storage);
  if (current.previouslyConnected !== 'true' ||
      current.activeIdentity !== expected.activeIdentity ||
      current.delegateDid !== expected.delegateDid ||
      current.connectedDid !== expected.connectedDid) {
    return false;
  }
  if (connectedDid === undefined || delegateDid === undefined) {
    return true;
  }

  const entries = await readRevocationRetryEntries(storage);
  return !entries.some(entry =>
    entry.delegateDid === delegateDid && entry.connectedDid === connectedDid
  );
}

/** Parse the complete grant-revocation set persisted for an active session. */
function parseSessionRevocations(json: string): RevocationEntry[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length > MAX_REVOCATION_RETRY_ENTRIES ||
        !parsed.every(isRevocationEntry) || !hasUniqueRevocations(parsed)) {
      throw new Error('invalid session revocations');
    }
    return parsed;
  } catch (error: unknown) {
    throw new Error('AuthManager: Session revocation state is invalid.', { cause: error });
  }
}

/** Durably merge an active session's complete revocation set before any attempt. */
async function stageRevocationRetryEntry(
  storage: StorageAdapter,
  entries: RetryEntry[],
  entry: RetryEntry,
): Promise<RetryEntry[]> {
  if (!isRetryEntry(entry)) {
    throw new Error('AuthManager: Session revocation binding is invalid.');
  }
  const existing = entries.find(candidate => candidate.delegateDid === entry.delegateDid);
  if (existing !== undefined && existing.connectedDid !== entry.connectedDid) {
    throw new Error('AuthManager: Revocation retry binding is inconsistent.');
  }
  const revocations = mergeRevocations(existing?.revocations ?? [], entry.revocations);
  if (existing !== undefined && revocations.length === existing.revocations.length) {
    return entries;
  }
  const staged = entries.filter(candidate => candidate.delegateDid !== entry.delegateDid);
  if (revocations.length > 0) {
    staged.push({ ...entry, revocations });
  }
  if (staged.length > 0) {
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify(staged));
  }
  return staged;
}

/**
 * Disable restoration and clear a persisted session. Delegated sessions first
 * stage their complete revocation set and retry every durable entry. The caller
 * must hold the auth-session lifecycle lock for the complete operation.
 *
 * @internal
 */
export async function disconnectPersistedSessionWithinLifecycle(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
  delegateDid: string | undefined,
  connectedDid: string | undefined,
): Promise<boolean> {
  if (delegateDid === undefined || connectedDid === undefined) {
    await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
    await clearSessionMarkers(userAgent, storage);
    return false;
  }

  const encodedRevocations = await storage.get(STORAGE_KEYS.SESSION_REVOCATIONS);
  const sessionRevocations = encodedRevocations === null
    ? []
    : parseSessionRevocations(encodedRevocations);
  let entries = await readRevocationRetryEntries(storage);

  if (sessionRevocations.length > 0) {
    entries = await stageRevocationRetryEntry(storage, entries, {
      delegateDid,
      connectedDid,
      revocations: sessionRevocations,
    });
  }

  // This is the lifecycle commit point. The complete journal is durable first;
  // once restore is disabled, remote work may safely be replayed after a crash.
  await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
  let settledEntries: SettledRetryEntry[] = [];
  let hasPendingRevocations = entries.some(entry => entry.delegateDid === delegateDid);
  if (entries.length > 0) {
    try {
      settledEntries = await retryRevocationEntries(userAgent, storage, entries);
    } catch {
      // The complete pre-attempt journal remains durable. Treat this session
      // as pending and let a later restore retry the idempotent operation.
    }
  }

  try {
    const remainingEntries = await readRevocationRetryEntries(storage);
    hasPendingRevocations = remainingEntries.some(entry => entry.delegateDid === delegateDid);
  } catch { /* retain the conservative pre-attempt result */ }

  await clearSessionMarkers(userAgent, storage);
  await retireSettledDelegateIdentities(userAgent, storage, settledEntries);
  return hasPendingRevocations;
}

function isRetryEntry(value: unknown): value is RetryEntry {
  return isRecord(value) && isNonEmptyString(value.delegateDid) && isNonEmptyString(value.connectedDid) &&
    Array.isArray(value.revocations) && value.revocations.length > 0 &&
    value.revocations.length <= MAX_REVOCATION_RETRY_ENTRIES && value.revocations.every(isRevocationEntry) &&
    hasUniqueRevocations(value.revocations);
}

function isRevocationEntry(value: unknown): value is RevocationEntry {
  return isRecord(value) && isNonEmptyString(value.grantId) && isNonEmptyString(value.revocationGrantId);
}

function hasUniqueRevocations(entries: RevocationEntry[]): boolean {
  return new Set(entries.map(entry => entry.grantId)).size === entries.length &&
    new Set(entries.map(entry => entry.revocationGrantId)).size === entries.length;
}

function mergeRevocations(left: RevocationEntry[], right: RevocationEntry[]): RevocationEntry[] {
  const merged = [...left];
  for (const revocation of right) {
    const sameGrant = merged.find(entry => entry.grantId === revocation.grantId);
    const sameRevocationGrant = merged.find(entry => entry.revocationGrantId === revocation.revocationGrantId);
    if ((sameGrant !== undefined && sameGrant.revocationGrantId !== revocation.revocationGrantId) ||
        (sameRevocationGrant !== undefined && sameRevocationGrant.grantId !== revocation.grantId)) {
      throw new Error('AuthManager: Revocation retry mapping is inconsistent.');
    }
    if (sameGrant === undefined) {
      merged.push(revocation);
    }
  }
  if (merged.length > MAX_REVOCATION_RETRY_ENTRIES) {
    throw new Error('AuthManager: Revocation retry context is too large.');
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2_048;
}

/**
 * Ensure the revocation grant exists on the owner's remote DWN before
 * attempting to use it. Reads the grant locally by recordId and sends
 * it to all remote endpoints. This closes the gap where best-effort
 * fanout at connect time may have failed.
 */
async function ensureRevocationGrantOnRemote(
  userAgent: EnboxUserAgent,
  connectedDid: string,
  delegateDid: string,
  revocationGrantId: string,
  dwnEndpointUrls: string[],
): Promise<void> {
  if (dwnEndpointUrls.length === 0) { return; }

  try {
    // Read as the delegate (grant recipient), not the owner.
    const { reply } = await userAgent.dwn.processRequest({
      author        : delegateDid,
      target        : connectedDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: revocationGrantId } },
    });
    if (reply.status.code !== 200 || !reply.entry?.recordsWrite) { return; }

    // `RecordsWriteMessage` doesn't declare `encodedData`, but the
    // wire-format reply may include it; widen the local type to
    // acknowledge that without `any`.
    // NOSONAR S4325 false positive: the cast is required to typecheck
    // the destructuring of the undeclared optional `encodedData`
    // property; removing it fails TS2339. Sonar reads the intersection-
    // with-optional-field as a no-op widening, which it isn't here.
    type RecordsWriteWireMessage = RecordsWriteMessage & { encodedData?: string };
    const { encodedData: _encoded, ...rawMessage } =
      reply.entry.recordsWrite as RecordsWriteWireMessage; // NOSONAR
    const data = reply.entry.data
      ? new Blob([await DataStream.toBytes(reply.entry.data) as BlobPart])
      : undefined;

    for (const dwnUrl of dwnEndpointUrls) {
      try {
        await userAgent.rpc.sendDwnRequest({
          dwnUrl,
          targetDid : connectedDid,
          message   : rawMessage,
          data,
        });
      } catch {
        // Per-endpoint failure — continue.
      }
    }
  } catch {
    // Best-effort — if the grant can't be read or sent, the revocation
    // attempt will fail on auth and be retried next time.
  }
}

/**
 * Revoke a single grant and send the revocation to remote DWN endpoints.
 * First ensures the revocation grant is on the remote DWN (self-healing).
 * Returns `true` if at least one remote endpoint confirmed (202/409).
 */
async function revokeAndSendSingle(
  userAgent: EnboxUserAgent,
  connectedDid: string,
  delegateDid: string,
  entry: RevocationEntry,
  dwnEndpointUrls: string[],
): Promise<boolean> {
  // Self-healing: ensure the revocation grant is on the remote DWN.
  await ensureRevocationGrantOnRemote(
    userAgent, connectedDid, delegateDid, entry.revocationGrantId, dwnEndpointUrls,
  );

  // Read as the delegate (grant recipient), not the owner.
  const { reply: readReply } = await userAgent.dwn.processRequest({
    author        : delegateDid,
    target        : connectedDid,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId: entry.grantId } },
  });
  if (readReply.status.code !== 200 || !readReply.entry?.recordsWrite) { return false; }

  // Reconstruct DwnDataEncodedRecordsWriteMessage: RecordsRead returns
  // the data as a stream, but PermissionGrant.parse needs encodedData.
  const grantDataBytes = readReply.entry.data
    ? await DataStream.toBytes(readReply.entry.data)
    : new Uint8Array(0);
  const grantMessageWithData: DwnDataEncodedRecordsWriteMessage = {
    ...readReply.entry.recordsWrite,
    encodedData: Convert.uint8Array(grantDataBytes).toBase64Url(),
  };
  const grant = DwnPermissionGrant.parse(grantMessageWithData);

  const { message } = await userAgent.permissions.createRevocation({
    author            : connectedDid,
    store             : true,
    grant,
    granteeDid        : delegateDid,
    permissionGrantId : entry.revocationGrantId,
  });

  return sendRevocationToEndpoints(userAgent, connectedDid, message, dwnEndpointUrls);
}

/**
 * Send a revocation message to all owner DWN endpoints.
 * Returns `true` if at least one endpoint confirmed (202/409).
 */
async function sendRevocationToEndpoints(
  userAgent: EnboxUserAgent,
  connectedDid: string,
  revocationMessage: DwnDataEncodedRecordsWriteMessage,
  dwnEndpointUrls: string[],
): Promise<boolean> {
  if (dwnEndpointUrls.length === 0) { return false; }

  const { encodedData, ...rawMessage } = revocationMessage;
  const data = encodedData
    ? new Blob([Convert.base64Url(encodedData).toUint8Array() as BlobPart])
    : undefined;

  for (const dwnUrl of dwnEndpointUrls) {
    try {
      const reply = await userAgent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : connectedDid,
        message   : rawMessage,
        data,
      });
      if (reply?.status?.code === 202 || reply?.status?.code === 409) {
        return true;
      }
    } catch {
      // Per-endpoint failure — try the next one.
    }
  }
  return false;
}

/** Clear the self-contained revocation retry context from storage. */
async function clearRetryState(storage: StorageAdapter): Promise<void> {
  await storage.remove(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
}

async function persistRetryEntries(storage: StorageAdapter, entries: RetryEntry[]): Promise<void> {
  if (entries.length === 0) {
    await clearRetryState(storage);
  } else {
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify(entries));
  }
}

async function clearSessionMarkers(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
): Promise<void> {
  await Promise.allSettled([
    storage.remove(STORAGE_KEYS.ACTIVE_IDENTITY),
    storage.remove(STORAGE_KEYS.DELEGATE_DID),
    storage.remove(STORAGE_KEYS.CONNECTED_DID),
    storage.remove(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS),
    storage.remove(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS),
    storage.remove(STORAGE_KEYS.SESSION_REVOCATIONS),
    userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS),
  ]);
  userAgent.dwn.clearDelegateDecryptionKeys();
}

/**
 * Retry grant revocations that were not confirmed by the owner's remote
 * DWN during a previous disconnect. Called from `restoreSession()` AFTER
 * sync is started and only when `REVOCATION_RETRY_CONTEXT` exists.
 *
 * This function does NOT restore a session — the user explicitly
 * disconnected and the retry is purely a background cleanup.
 */
export async function retryOrphanedRevocations(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
): Promise<void> {
  await runAuthSessionLifecycle(async (): Promise<void> => {
    const entries = await readRevocationRetryEntries(storage);
    const settledEntries = await retryRevocationEntries(userAgent, storage, entries);
    await retireSettledDelegateIdentities(userAgent, storage, settledEntries);
  });
}

async function retryRevocationEntries(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
  initialEntries: RetryEntry[],
): Promise<SettledRetryEntry[]> {
  let entries = initialEntries;
  let journalChanged = false;
  const settledEntries: SettledRetryEntry[] = [];

  if (entries.length === 0) {
    await clearRetryState(storage);
    return [];
  }

  for (const entry of entries) {
    let delegateIdentity: BearerIdentity | undefined;
    try {
      delegateIdentity = await userAgent.identity.get({ didUri: entry.delegateDid });
    } catch {
      continue;
    }
    if (delegateIdentity?.did.uri !== entry.delegateDid ||
        delegateIdentity.metadata.connectedDid !== entry.connectedDid) {
      continue;
    }
    const succeeded = await retryEntryRevocations(userAgent, entry);
    if (succeeded === undefined) {
      continue; // Can't resolve endpoints for this entry — try next.
    }
    if (succeeded.length === 0) {
      continue;
    }

    // Update the in-memory collection so the next iteration sees
    // the correct state (avoid stale-snapshot overwrites).
    journalChanged = true;
    entries = applyRetrySuccesses(entries, entry, succeeded);
    if (!entries.some(candidate => candidate.delegateDid === entry.delegateDid)) {
      settledEntries.push({ entry, identity: delegateIdentity });
    }
  }

  // The complete pre-attempt journal stays durable through all network work.
  // Confirmed 202/409 responses are applied in one locked write at the end.
  if (journalChanged) {
    await persistRetryEntries(storage, entries);
  }
  return settledEntries;
}

async function retireSettledDelegateIdentities(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
  settledEntries: SettledRetryEntry[],
): Promise<void> {
  for (const settled of settledEntries) {
    await retireSettledDelegateIdentity(userAgent, storage, settled.entry, settled.identity);
  }
}

async function retireSettledDelegateIdentity(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
  entry: RetryEntry,
  identity: BearerIdentity,
): Promise<void> {
  try {
    const [previouslyConnected, activeDelegateDid] = await Promise.all([
      storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED),
      storage.get(STORAGE_KEYS.DELEGATE_DID),
    ]);
    if (previouslyConnected === 'true' && activeDelegateDid === entry.delegateDid) {
      return;
    }
    try {
      await userAgent.did.delete({
        didUri    : identity.did.uri,
        tenant    : identity.metadata.tenant,
        deleteKey : true,
      });
    } catch { /* best effort */ }
    await userAgent.identity.delete({ didUri: identity.did.uri });
  } catch {
    // Best-effort local retirement cannot restore remotely settled authority.
  }
}

/**
 * Resolve remote endpoints for a retry entry and attempt each of its
 * revocations. Returns `undefined` when endpoints could not be resolved
 * (the entry is left untouched for the next retry attempt), otherwise the
 * list of grant IDs whose revocation was confirmed.
 */
async function retryEntryRevocations(
  userAgent: EnboxUserAgent,
  entry: RetryEntry,
): Promise<string[] | undefined> {
  let remoteDwnUrls: string[] = [];
  try {
    remoteDwnUrls = await userAgent.dwn.getRemoteDwnEndpointUrls(entry.connectedDid);
  } catch {
    return undefined; // Can't resolve endpoints for this entry — try next.
  }

  const succeeded: string[] = [];
  for (const revEntry of entry.revocations) {
    try {
      const confirmed = await revokeAndSendSingle(
        userAgent, entry.connectedDid, entry.delegateDid, revEntry, remoteDwnUrls,
      );
      if (confirmed) { succeeded.push(revEntry.grantId); }
    } catch {
      // Individual failure — continue.
    }
  }

  return succeeded;
}

/**
 * Remove confirmed revocations from a retry entry within `entries`,
 * dropping the entry entirely once all of its revocations are confirmed.
 */
function applyRetrySuccesses(
  entries: RetryEntry[],
  entry: RetryEntry,
  succeeded: string[],
): RetryEntry[] {
  const remaining = entry.revocations.filter((r) => !succeeded.includes(r.grantId));
  if (remaining.length === 0) {
    return entries.filter((e) => e.delegateDid !== entry.delegateDid);
  }
  return entries.map((e) =>
    e.delegateDid === entry.delegateDid ? { ...e, revocations: remaining } : e,
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Derive the protocol list for a delegate's sync scope by querying
 * stored grant records and extracting their `scope.protocol` fields.
 *
 * Returns a deduplicated array of protocol URIs, excluding the DWN
 * permissions protocol itself (permission records are already included
 * in each protocol's sync stream via `constructAdditionalMessageFilter`).
 */
