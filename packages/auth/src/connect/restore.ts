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
import { registerWithDwnEndpoints } from '../registration.js';
import { STORAGE_KEYS } from '../types.js';
import { assertFlowActive, commitFlowSession, ensureVaultReady, finalizeSession, refreshDwnEndpointsForConnection, registerSyncScopeForIdentity, resolveIdentityDids, resolvePassword, runFlowMutation, startSyncIfEnabled } from './lifecycle.js';

/**
 * Attempt to restore a previous session.
 *
 * Returns `undefined` if no previous session exists.
 * Returns an `AuthSession` if the session was successfully restored.
 *
 * Two independent concerns are handled here:
 * 1. Revocation retry maintenance (from a previous partial disconnect)
 * 2. Normal session restore
 * They do NOT depend on each other. Both can run in the same call.
 */
export async function restoreSession(
  ctx: FlowContext,
  options: RestoreSessionOptions = {},
): Promise<AuthSession | undefined> {
  const { userAgent, emitter, storage } = ctx;
  assertFlowActive(ctx);

  // Two independent concerns:
  // 1. PREVIOUSLY_CONNECTED — normal session restore
  // 2. REVOCATION_RETRY_CONTEXT — orphaned revocations from partial disconnect
  // If neither is set, nothing to do.
  const previouslyConnected = await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
  const retryContextJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
  assertFlowActive(ctx);
  if (previouslyConnected !== 'true' && !retryContextJson) {
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

  // The agent DID is a persisted sync target used by retry maintenance and identity recovery.
  // Refresh it before either path can start sync, and tenant-register it at only its own endpoints.
  await prepareRestoredDidRouting(ctx, userAgent.agentDid.uri);

  // --- Retry maintenance (independent from session restore) ---
  await runRetryMaintenanceIfNeeded(ctx, userAgent, storage, retryContextJson);

  // --- Normal session restore ---
  if (previouslyConnected !== 'true') {
    return undefined;
  }

  // Determine which identity to reconnect.
  const activeIdentityDid = await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY);
  const storedDelegateDid = await storage.get(STORAGE_KEYS.DELEGATE_DID);
  const identity = await resolveIdentityForRestore(userAgent, storedDelegateDid, activeIdentityDid);

  if (!identity) {
    return handleMissingRestoreIdentity(ctx, activeIdentityDid);
  }

  const { connectedDid, delegateDid } = resolveIdentityDids(
    identity, storedDelegateDid ?? undefined,
  );
  if (connectedDid !== userAgent.agentDid.uri) {
    await prepareRestoredDidRouting(ctx, connectedDid);
  }

  return commitFlowSession(ctx, () => finalizeRestoredSession(ctx, identity, connectedDid, delegateDid));
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

  // Check for stale session marker.
  const isFirstLaunch = await userAgent.firstLaunch();
  assertFlowActive(ctx);
  if (isFirstLaunch) {
    await runFlowMutation(ctx, async (): Promise<void> => {
      await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
      await storage.remove(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
    });
    return undefined;
  }

  const password = await resolvePassword(ctx, explicitPassword, false);
  assertFlowActive(ctx);
  return password;
}

/**
 * Best-effort retry of orphaned grant revocations left over from a partial
 * disconnect. Starts sync temporarily for remote delivery, runs the retry,
 * then stops sync. Failures here must NOT break a legitimate restore path —
 * the retry context simply remains in storage for the next attempt.
 */
async function runRetryMaintenanceIfNeeded(
  ctx: FlowContext,
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
  retryContextJson: string | null,
): Promise<void> {
  if (!retryContextJson) {
    return;
  }

  try {
    await runFlowMutation(ctx, async (): Promise<void> => {
      await startSyncIfEnabled(userAgent, ctx.defaultSync);
      try {
        await retryOrphanedRevocations(userAgent, storage);
      } finally {
        await userAgent.sync.stopSync(2000);
      }
    });
  } catch {
    // Retry maintenance is best-effort. If sync startup or retry
    // fails, the retry context remains in storage for next attempt.
    // Do NOT let this block normal session restore below.
  }
  assertFlowActive(ctx);
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
  activeIdentityDid: string | null,
): Promise<AuthSession | undefined> {
  const { userAgent, emitter, storage } = ctx;

  // No identity found — this is valid for agent-only sessions created
  // with `createIdentity: false`. Restore a session using the agent DID.
  // If the active identity stored was the agent DID, this is an
  // intentional agent-only session rather than stale data.
  const isAgentOnlySession = activeIdentityDid === userAgent.agentDid.uri;

  if (!isAgentOnlySession) {
    // Truly stale session data — clean up and bail.
    await runFlowMutation(ctx, async (): Promise<void> => {
      await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
      await storage.remove(STORAGE_KEYS.ACTIVE_IDENTITY);
      await storage.remove(STORAGE_KEYS.DELEGATE_DID);
      await storage.remove(STORAGE_KEYS.CONNECTED_DID);
      await storage.remove(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS);
      await storage.remove(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS);
      await storage.remove(STORAGE_KEYS.SESSION_REVOCATIONS);
      try { await userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS); } catch { /* best-effort */ }
    });
    // Do NOT remove REVOCATION_RETRY_CONTEXT here — it has its own
    // lifecycle managed by the retry maintenance path. Stale session
    // cleanup must not silently drop pending revocations.
    return undefined;
  }

  return commitFlowSession(ctx, () => finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid      : userAgent.agentDid.uri,
    emitIdentityAdded : false,
    signal            : ctx.sessionSignal,
  }));
}

/** Refresh and, when configured, tenant-register the DID selected by persisted session state. */
async function prepareRestoredDidRouting(ctx: FlowContext, connectedDid: string): Promise<void> {
  const { userAgent, storage } = ctx;
  const dwnEndpoints = await refreshDwnEndpointsForConnection({
    userAgent,
    didUri   : connectedDid,
    required : ctx.registration !== undefined || ctx.defaultSync !== 'off',
  });
  assertFlowActive(ctx);

  if (ctx.registration === undefined) {
    return;
  }
  if (dwnEndpoints === undefined) {
    throw new Error(`[@enbox/auth] No DWN endpoints are available for registration of '${connectedDid}'.`);
  }

  await registerWithDwnEndpoints(
    {
      userAgent,
      targets      : [{ did: connectedDid, dwnEndpoints }],
      secretStore  : userAgent.secrets,
      storage,
      assertActive : ctx.assertActive,
      runMutation  : ctx.runMutation,
    },
    ctx.registration,
  );
  assertFlowActive(ctx);
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
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;

  // Ensure the sync registration is scoped explicitly. Delegate sessions derive
  // scope from grants; local sessions are updated only when the caller provides
  // an explicit identity sync scope.
  let syncRepairFailed = false;
  try {
    if (delegateDid) {
      await registerSyncScopeForIdentity({ userAgent, connectedDid, delegateDid });
    } else {
      await registerSyncScopeForIdentity({
        userAgent,
        connectedDid,
        identitySyncProtocols: ctx.defaultIdentitySyncProtocols,
      });
    }
  } catch {
    // Grant query or registration repair failed — don't block restore,
    // but don't let a stale registration remain usable.
    syncRepairFailed = true;
    try { await userAgent.sync.unregisterIdentity(connectedDid); } catch { /* already gone or store error */ }
  }

  if (delegateDid && connectedDid) {
    await storage.remove(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS).catch(() => {});
    await userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS).catch(() => {});
    await storage.remove(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS).catch(() => {});
  }

  if (!syncRepairFailed) {
    await startSyncIfEnabled(userAgent, ctx.defaultSync);
  }

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
  });
}

// ─── Revocation retry helpers ───────────────────────────────────

type RevocationEntry = { grantId: string; revocationGrantId: string };

type RetryEntry = {
  delegateDid: string;
  connectedDid: string;
  revocations: RevocationEntry[];
};

/**
 * Load all retry entries from `REVOCATION_RETRY_CONTEXT`.
 * Returns an empty array if the data is missing or malformed.
 */
async function loadRetryEntries(
  storage: StorageAdapter,
): Promise<RetryEntry[]> {
  const json = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
  if (!json) { return []; }

  try {
    const parsed = JSON.parse(json);

    // Handle legacy single-object format: wrap in array.
    const legacyEntries = (parsed?.delegateDid && parsed?.connectedDid && Array.isArray(parsed?.revocations))
      ? [parsed]
      : [];
    const entries = Array.isArray(parsed)
      ? parsed
      : legacyEntries;

    if (entries.length === 0 && !Array.isArray(parsed)) {
      // Truly malformed (not a valid legacy object either).
      await clearRetryState(storage);
      return [];
    }

    // Filter out malformed entries.
    return entries.filter(
      (e: any): e is RetryEntry => e?.delegateDid && e?.connectedDid && Array.isArray(e?.revocations),
    );
  } catch {
    await clearRetryState(storage);
    return [];
  }
}

/**
 * Revoke a single grant and send the revocation to remote DWN endpoints.
 * Returns `true` if at least one remote endpoint confirmed (202/409).
 */
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
  revocationMessage: any,
  dwnEndpointUrls: string[],
): Promise<boolean> {
  if (!revocationMessage || dwnEndpointUrls.length === 0) { return false; }

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
  let entries = await loadRetryEntries(storage);
  if (entries.length === 0) {
    await clearRetryState(storage);
    return;
  }

  for (const entry of entries) {
    const succeeded = await retryEntryRevocations(userAgent, entry);
    if (succeeded === undefined) {
      continue; // Can't resolve endpoints for this entry — try next.
    }

    // Update the in-memory collection so the next iteration sees
    // the correct state (avoid stale-snapshot overwrites).
    entries = applyRetrySuccesses(entries, entry, succeeded);
  }

  // Write the final state once after processing all entries.
  if (entries.length === 0) {
    await clearRetryState(storage);
  } else {
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify(entries));
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
