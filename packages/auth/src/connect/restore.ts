/**
 * Session restore flow.
 *
 * Restores a previously established session from persisted storage,
 * using its complete atomic session record.
 * @module
 */

import type { FlowContext } from './lifecycle.js';
import type { PersistedSession, RetryEntry, RevocationEntry } from './session-state.js';
import type { RestoreSessionOptions, StorageAdapter } from '../types.js';

import type { RecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { AgentSession, BearerIdentity, DwnDataEncodedRecordsWriteMessage, EnboxUserAgent } from '@enbox/agent';

import { Convert } from '@enbox/common';
import { DataStream } from '@enbox/dwn-sdk-js';
import { DwnInterface, DwnPermissionGrant } from '@enbox/agent';

import { applyLocalDwnDiscovery } from '../discovery.js';
import { STORAGE_KEYS } from '../types.js';
import { ensureVaultReady, finalizeSession, registerSyncScopeForIdentity, resolveIdentityDids, resolvePassword, runAuthSessionLifecycle, startSyncAndWaitIfEnabled, startSyncInBackgroundIfEnabled } from './lifecycle.js';
import { hasSessionBinding, parseRevocationRetryEntries, readPersistedSession, readRevocationRetryEntries, stageRevocationRetryEntry } from './session-state.js';

const SESSION_RESTORE_SYNC_REPAIR_TIMEOUT_MS = 10_000;

/**
 * Attempt to restore a previous session.
 *
 * Returns `undefined` if no previous session exists.
 * Returns an `AgentSession` if the session was successfully restored.
 *
 * Two concerns are handled here:
 * 1. Revocation retry maintenance (from a previous partial disconnect)
 * 2. Normal session restore
 * Retry work for another delegate is independent and can run in the same
 * call. Retry evidence containing the persisted approval's complete revocation
 * map proves disconnect had begun, so recovery completes teardown and suppresses restore.
 */
export async function restoreSession(
  ctx: FlowContext,
  options: RestoreSessionOptions = {},
): Promise<AgentSession | undefined> {
  const { userAgent, emitter, storage } = ctx;
  ctx.assertActive();

  const persistedSession = await readPersistedSession(storage);
  const retryContextJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
  ctx.assertActive();
  const hasRetryContext = retryContextJson !== null;
  if (retryContextJson !== null) {
    parseRevocationRetryEntries(retryContextJson);
  }
  if (persistedSession === null && !hasRetryContext) {
    return undefined;
  }

  const password = await resolveRestorePassword(ctx, options);
  if (password === undefined) {
    return undefined;
  }

  // Start the agent (vault is known to exist).
  await ctx.runMutation(() => ensureVaultReady({
    userAgent,
    emitter,
    password,
    isFirstLaunch: false,
  }));

  // Apply local DWN discovery.
  if (!userAgent.dwn.isRemoteMode) {
    await ctx.runMutation(() => applyLocalDwnDiscovery(userAgent, storage, emitter));
  }

  // --- Retry maintenance and interrupted-disconnect recovery ---
  const interruptedDisconnect = await runRetryMaintenanceIfNeeded(
    ctx, userAgent, storage, hasRetryContext,
  );

  // A retry journal containing this approval's complete revocations means
  // disconnect had begun before the prior process stopped. Recovery may finish
  // that teardown, but must never resurrect the session being disconnected.
  if (interruptedDisconnect) {
    return undefined;
  }

  // --- Normal session restore ---
  // Capture the complete session binding after maintenance. The final commit
  // revalidates it under the cross-context lifecycle lock.
  const snapshot = await readPersistedSession(storage);
  ctx.assertActive();
  if (snapshot === null) {
    return undefined;
  }

  // Determine which identity to reconnect.
  const identity = await userAgent.identity.get({ didUri: snapshot.delegateDid ?? snapshot.connectedDid });

  if (!identity) {
    return handleMissingRestoreIdentity(ctx, snapshot);
  }

  const { connectedDid, delegateDid } = resolveIdentityDids(identity);
  if (!hasSessionBinding(snapshot, connectedDid, delegateDid)) {
    throw new Error('AuthManager: Stored identity does not match the persisted session.');
  }

  return ctx.commitSession(() => finalizeRestoredSession(
    ctx, identity, connectedDid, delegateDid, snapshot,
  ));
}

// ─── restoreSession helpers ─────────────────────────────────────

/**
 * Resolve the vault password for session restore, detecting a stale
 * persisted session left behind when the vault itself was
 * never initialized (e.g. storage cleared without going through
 * `disconnect()`).
 *
 * Returns `undefined` when the stale-session cleanup path was taken and
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
    ctx.assertActive();
    explicitPassword = await options.onPasswordRequired();
    ctx.assertActive();
  }

  // Check for and clear a stale session as one persisted-state transition.
  const isFirstLaunch = await ctx.runMutation(() => runAuthSessionLifecycle(async (): Promise<boolean> => {
    const firstLaunch = await userAgent.firstLaunch();
    if (firstLaunch) {
      await storage.remove(STORAGE_KEYS.SESSION);
    }

    return firstLaunch;
  }));
  if (isFirstLaunch) {
    return undefined;
  }

  const password = await resolvePassword(ctx, explicitPassword, false);
  ctx.assertActive();
  return password;
}

/**
 * Retry orphaned grant revocations left over from a partial disconnect.
 * Unrelated remote-maintenance failures remain best-effort. Present malformed
 * evidence, session-read failures, and failures for the session being torn down
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

  const interruptedDisconnect = await ctx.runMutation(() => runAuthSessionLifecycle(
    async (): Promise<boolean> => {
      const currentEntries = await readRevocationRetryEntries(storage);
      const interruptedEntry = await disableInterruptedSession(storage, currentEntries);

      let settledEntries: SettledRetryEntry[] = [];
      try {
        await startSyncAndWaitIfEnabled(userAgent, ctx.defaultSync);
        settledEntries = await retryRevocationEntries(userAgent, storage, currentEntries);
      } catch {
        // The complete journal remains durable for the next attempt.
      } finally {
        await userAgent.sync.stopSync(2000).catch(() => {});
        if (interruptedEntry !== undefined) {
          userAgent.dwn.clearDelegateDecryptionKeys(interruptedEntry.delegateDid);
        }
      }

      await retireSettledDelegateIdentities(userAgent, storage, settledEntries);

      // Retry maintenance for another delegate is best-effort and must not
      // block restoration of the current session.
      return interruptedEntry !== undefined;
    }
  ));
  ctx.assertActive();
  return interruptedDisconnect;
}

/**
 * Handle session restore when no identity could be resolved. Distinguishes
 * a genuine agent-only session (created with `createIdentity: false`) from
 * stale session data left over from disconnect, cleaning up the latter.
 */
async function handleMissingRestoreIdentity(
  ctx: FlowContext,
  snapshot: PersistedSession,
): Promise<AgentSession | undefined> {
  const { userAgent, emitter, storage } = ctx;

  // No identity found — this is valid for agent-only sessions created
  // with `createIdentity: false`. Restore a session using the agent DID.
  // If the active identity stored was the agent DID, this is an
  // intentional agent-only session rather than stale data.
  const isAgentOnlySession = snapshot.delegateDid === undefined && snapshot.connectedDid === userAgent.agentDid.uri;

  if (!isAgentOnlySession) {
    // Truly stale session data — clean up only if the binding is still the
    // snapshot this restore attempt resolved.
    return ctx.commitSession(async (): Promise<undefined> => {
      if (!await isRestoreSnapshotCurrent(storage, snapshot)) {
        return undefined;
      }
      await storage.remove(STORAGE_KEYS.SESSION);
      // The independent retry journal must survive stale-session cleanup.
      return undefined;
    });
  }

  return ctx.commitSession(async (): Promise<AgentSession | undefined> => {
    if (!await isRestoreSnapshotCurrent(storage, snapshot)) {
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
 * for the resolved identity, restart sync,
 * and build the `AgentSession`.
 */
async function finalizeRestoredSession(
  ctx: FlowContext,
  identity: BearerIdentity,
  connectedDid: string,
  delegateDid: string | undefined,
  snapshot: PersistedSession,
): Promise<AgentSession | undefined> {
  const { userAgent, emitter, storage } = ctx;

  if (!await isRestoreSnapshotCurrent(storage, snapshot)) {
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
      identitySyncProtocols : ctx.defaultIdentitySyncProtocols,
      lifecycleOptions      : { timeout: SESSION_RESTORE_SYNC_REPAIR_TIMEOUT_MS },
    });
  } catch {
    // Grant query or registration repair failed — don't block restore,
    // but don't let a stale registration remain usable.
    syncRepairFailed = true;
    try {
      await userAgent.sync.removeIdentity(connectedDid, { timeout: 0 });
    } catch { /* best-effort cleanup */ }
  }

  // Session restore does not emit `identity-added` (identity was already added in the original flow).
  const session = await finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    signal               : ctx.sessionSignal,
    identityName         : identity.metadata.name,
    identityConnectedDid : identity.metadata.connectedDid,
    emitIdentityAdded    : false,
  });

  if (!syncRepairFailed) {
    startSyncInBackgroundIfEnabled(userAgent, ctx.defaultSync, ctx.sessionSignal);
  }

  return session;
}

// ─── Revocation retry helpers ───────────────────────────────────

type SettledRetryEntry = { entry: RetryEntry; identity: BearerIdentity };

/** Disconnect intent requires every current mapping; older same-delegate grants alone do not qualify. */
function findInterruptedDisconnect(
  session: PersistedSession | null,
  entries: RetryEntry[],
): RetryEntry | undefined {
  if (session?.delegateDid === undefined) {
    return undefined;
  }
  const entry = entries.find(candidate => candidate.delegateDid === session.delegateDid);
  if (entry !== undefined && entry.connectedDid !== session.connectedDid) {
    throw new Error('AuthManager: Revocation retry binding is inconsistent.');
  }
  if (entry === undefined || session.revocations.length === 0) {
    return undefined;
  }
  const stagedRevocations = new Map(entry.revocations.map(({ grantId, revocationGrantId }) => [grantId, revocationGrantId]));
  return session.revocations.every(({ grantId, revocationGrantId }) => stagedRevocations.get(grantId) === revocationGrantId)
    ? entry
    : undefined;
}

/** Disable restore before retry work can consume a staged disconnect's durable intent. */
async function disableInterruptedSession(
  storage: StorageAdapter,
  entries: RetryEntry[],
): Promise<RetryEntry | undefined> {
  const entry = findInterruptedDisconnect(await readPersistedSession(storage), entries);
  if (entry !== undefined) {
    await storage.remove(STORAGE_KEYS.SESSION);
  }
  return entry;
}

async function isRestoreSnapshotCurrent(
  storage: StorageAdapter,
  expected: PersistedSession,
): Promise<boolean> {
  const current = await readPersistedSession(storage);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    return false;
  }
  if (expected.delegateDid === undefined) {
    return true;
  }

  const entries = await readRevocationRetryEntries(storage);
  return findInterruptedDisconnect(expected, entries) === undefined;
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
  const session = await readPersistedSession(storage);
  const ownsSession = hasSessionBinding(session, connectedDid, delegateDid);
  let entries = await readRevocationRetryEntries(storage);

  if (session !== null && ownsSession) {
    if (session.delegateDid !== undefined && session.revocations.length > 0) {
      entries = await stageRevocationRetryEntry(storage, entries, {
        connectedDid : session.connectedDid,
        delegateDid  : session.delegateDid,
        revocations  : session.revocations,
      });
    }
    // Durable retry evidence precedes this atomic removal of restore state.
    await storage.remove(STORAGE_KEYS.SESSION);
  }
  let settledEntries: SettledRetryEntry[] = [];
  let hasPendingRevocations = entries.some(entry => entry.delegateDid === delegateDid);
  if (entries.length > 0) {
    const interruptedEntry = await disableInterruptedSession(storage, entries);
    try {
      settledEntries = await retryRevocationEntries(userAgent, storage, entries);
    } catch {
      // The complete pre-attempt journal remains durable. Treat this session
      // as pending and let a later restore retry the idempotent operation.
    } finally {
      if (interruptedEntry !== undefined) {
        userAgent.dwn.clearDelegateDecryptionKeys(interruptedEntry.delegateDid);
      }
    }
  }

  try {
    const remainingEntries = await readRevocationRetryEntries(storage);
    hasPendingRevocations = remainingEntries.some(entry => entry.delegateDid === delegateDid);
  } catch { /* retain the conservative pre-attempt result */ }

  await retireSettledDelegateIdentities(userAgent, storage, settledEntries);
  return hasPendingRevocations;
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

async function persistRetryEntries(storage: StorageAdapter, entries: RetryEntry[]): Promise<void> {
  if (entries.length === 0) {
    await storage.remove(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
  } else {
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify(entries));
  }
}

/**
 * Retry durable grant revocations without restoring a session.
 * Disable any matching interrupted session before network work can consume
 * its disconnect journal. The caller owns vault unlock and sync startup.
 */
export async function retryOrphanedRevocations(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
): Promise<void> {
  await runAuthSessionLifecycle(async (): Promise<void> => {
    const entries = await readRevocationRetryEntries(storage);
    const interruptedEntry = await disableInterruptedSession(storage, entries);
    let settledEntries: SettledRetryEntry[];
    try {
      settledEntries = await retryRevocationEntries(userAgent, storage, entries);
    } finally {
      if (interruptedEntry !== undefined) {
        userAgent.dwn.clearDelegateDecryptionKeys(interruptedEntry.delegateDid);
      }
    }
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
    await storage.remove(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
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
    const activeSession = await readPersistedSession(storage);
    if (activeSession?.delegateDid === entry.delegateDid) {
      return;
    }
    await userAgent.sync.removeIdentity(entry.connectedDid, { expectedDelegateDid: entry.delegateDid, timeout: 0 });
    await userAgent.did.delete({
      didUri    : identity.did.uri,
      tenant    : identity.metadata.tenant,
      deleteKey : true,
    });
    await userAgent.identity.delete({ didUri: identity.did.uri });
  } catch {
    // Best-effort local retirement cannot restore remotely settled authority.
  }
}

/**
 * Attempt an entry's revocations and return the grant IDs confirmed revoked.
 */
async function retryEntryRevocations(
  userAgent: EnboxUserAgent,
  entry: RetryEntry,
): Promise<string[]> {
  let remoteDwnUrls: string[] = [];
  try {
    remoteDwnUrls = await userAgent.dwn.getRemoteDwnEndpointUrls(entry.connectedDid);
  } catch {
    return []; // Can't resolve endpoints for this entry — try next.
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
