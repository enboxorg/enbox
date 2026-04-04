/**
 * Session restore flow.
 *
 * Restores a previously established session from persisted storage,
 * replacing the "previouslyConnected" pattern in apps.
 * @module
 */

import type { AuthSession } from '../identity-session.js';
import type { FlowContext } from './lifecycle.js';
import type { RestoreSessionOptions } from '../types.js';

import type { StorageAdapter } from '../types.js';

import type { EnboxUserAgent } from '@enbox/agent';

import { DwnInterface, DwnPermissionGrant } from '@enbox/agent';

import { applyLocalDwnDiscovery } from '../discovery.js';
import { STORAGE_KEYS } from '../types.js';
import { ensureVaultReady, finalizeSession, resolveIdentityDids, resolvePassword, startSyncIfEnabled } from './lifecycle.js';

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

  // Two independent concerns:
  // 1. PREVIOUSLY_CONNECTED — normal session restore
  // 2. REVOCATION_RETRY_CONTEXT — orphaned revocations from partial disconnect
  // If neither is set, nothing to do.
  const previouslyConnected = await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
  const retryContextJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
  if (previouslyConnected !== 'true' && !retryContextJson) {
    return undefined;
  }

  // Resolve password.
  let explicitPassword = options.password;
  if (!explicitPassword && !ctx.defaultPassword && options.onPasswordRequired) {
    explicitPassword = await options.onPasswordRequired();
  }

  // Check for stale session marker.
  const isFirstLaunch = await userAgent.firstLaunch();
  if (isFirstLaunch) {
    await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
    await storage.remove(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
    return undefined;
  }

  const password = await resolvePassword(ctx, explicitPassword, false);

  // Start the agent (vault is known to exist).
  await ensureVaultReady({
    userAgent,
    emitter,
    password,
    isFirstLaunch: false,
  });

  // Apply local DWN discovery.
  if (!userAgent.dwn.isRemoteMode) {
    await applyLocalDwnDiscovery(userAgent, storage, emitter);
  }

  // --- Retry maintenance (independent from session restore) ---
  // Best-effort: start sync temporarily for remote delivery, run retry,
  // then stop. Failures here must NOT break a legitimate restore path.
  if (retryContextJson) {
    try {
      await startSyncIfEnabled(userAgent, ctx.defaultSync);
      try {
        await retryOrphanedRevocations(userAgent, storage);
      } finally {
        await userAgent.sync.stopSync(2000);
      }
    } catch {
      // Retry maintenance is best-effort. If sync startup or retry
      // fails, the retry context remains in storage for next attempt.
      // Do NOT let this block normal session restore below.
    }
  }

  // --- Normal session restore ---
  if (previouslyConnected !== 'true') {
    return undefined;
  }

  // Start sync for the restored session.
  await startSyncIfEnabled(userAgent, ctx.defaultSync);

  // Determine which identity to reconnect.
  const activeIdentityDid = await storage.get(STORAGE_KEYS.ACTIVE_IDENTITY);
  const storedDelegateDid = await storage.get(STORAGE_KEYS.DELEGATE_DID);

  // First try the connected identity (wallet-connected sessions).
  let identity = await userAgent.identity.connectedIdentity();

  if (!identity) {
    // Try to find the specific active identity.
    if (activeIdentityDid) {
      identity = await userAgent.identity.get({ didUri: activeIdentityDid });
    }

    // Fall back to the first available identity.
    if (!identity) {
      const identities = await userAgent.identity.list();
      identity = identities[0];
    }
  }

  // Sync was already started above (for the restored session).

  if (!identity) {
    // No identity found — this is valid for agent-only sessions created
    // with `createIdentity: false`. Restore a session using the agent DID.
    // If the active identity stored was the agent DID, this is an
    // intentional agent-only session rather than stale data.
    const isAgentOnlySession = activeIdentityDid === userAgent.agentDid.uri;

    if (!isAgentOnlySession) {
      // Truly stale session data — clean up and bail.
      await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
      await storage.remove(STORAGE_KEYS.ACTIVE_IDENTITY);
      await storage.remove(STORAGE_KEYS.DELEGATE_DID);
      await storage.remove(STORAGE_KEYS.CONNECTED_DID);
      await storage.remove(STORAGE_KEYS.DELEGATE_DECRYPTION_KEYS);
      await storage.remove(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS);
      await storage.remove(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS);
      await storage.remove(STORAGE_KEYS.SESSION_REVOCATIONS);
      await storage.remove(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
      return undefined;
    }

    return finalizeSession({
      userAgent,
      emitter,
      storage,
      connectedDid      : userAgent.agentDid.uri,
      emitIdentityAdded : false,
    });
  }

  const { connectedDid, delegateDid } = resolveIdentityDids(
    identity, storedDelegateDid ?? undefined,
  );

  // Restore delegate decryption keys if persisted.
  if (delegateDid && connectedDid) {
    const keysJson = await storage.get(STORAGE_KEYS.DELEGATE_DECRYPTION_KEYS);
    if (keysJson) {
      try {
        const keys = JSON.parse(keysJson);
        if (Array.isArray(keys) && keys.length > 0) {
          userAgent.dwn.importDelegateDecryptionKeys(delegateDid, keys);
        }
      } catch { /* best effort — keys will be refreshed on next connect */ }
    }

    // Restore context keys for multi-party encrypted protocols.
    const ctxKeysJson = await storage.get(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS);
    // Restore multi-party protocol registrations.
    const mpProtocolsJson = await storage.get(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS);
    let multiPartyProtocols: string[] | undefined;
    if (mpProtocolsJson) {
      try {
        const parsed = JSON.parse(mpProtocolsJson);
        if (Array.isArray(parsed)) { multiPartyProtocols = parsed; }
      } catch { /* best effort */ }
    }

    if (ctxKeysJson || multiPartyProtocols) {
      try {
        const ctxKeys = ctxKeysJson ? JSON.parse(ctxKeysJson) : [];
        userAgent.dwn.importDelegateContextKeys(
          delegateDid,
          Array.isArray(ctxKeys) ? ctxKeys : [],
          multiPartyProtocols,
        );
      } catch { /* best effort — keys will be refreshed on next connect */ }
    }

    // Wire post-connect context key persistence so keys delivered after
    // restore survive the next restart. Same callback as finalizeDelegateSession.
    const restoreDelegateDid = delegateDid;
    userAgent.dwn.onDelegateContextKeysChanged = async (changedDelegateDid: string): Promise<void> => {
      if (changedDelegateDid !== restoreDelegateDid) { return; }
      try {
        const keys = userAgent.dwn.exportDelegateContextKeys(restoreDelegateDid);
        await storage.set(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS, JSON.stringify(keys));
      } catch { /* best effort — keys will be re-derived on next connect */ }
    };
  }

  // Persist session info, build AuthSession, and emit lifecycle events.
  // Session restore does not emit `identity-added` (identity was already added in the original flow).
  return finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    identityName         : identity.metadata.name,
    identityConnectedDid : identity.metadata.connectedDid,
    emitIdentityAdded    : false,
  });
}

// ─── Revocation retry helpers ───────────────────────────────────

type RevocationEntry = { grantId: string; revocationGrantId: string };

/**
 * Load the retry context from the self-contained `REVOCATION_RETRY_CONTEXT`
 * blob. Returns `undefined` if the context is missing or malformed
 * (cleans up orphaned data).
 */
async function loadRetryContext(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
): Promise<{
    delegateDid: string;
    connectedDid: string;
    revocations: RevocationEntry[];
    dwnEndpointUrls: string[];
  } | undefined> {
  const retryJson = await storage.get(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT);
  if (!retryJson) {
    return undefined;
  }

  let parsed: { delegateDid?: string; connectedDid?: string; revocations?: RevocationEntry[] };
  try {
    parsed = JSON.parse(retryJson);
  } catch {
    await clearRetryState(storage);
    return undefined;
  }

  const { delegateDid, connectedDid, revocations } = parsed;
  if (!delegateDid || !connectedDid || !Array.isArray(revocations) || revocations.length === 0) {
    await clearRetryState(storage);
    return undefined;
  }

  let dwnEndpointUrls: string[] = [];
  try {
    dwnEndpointUrls = await userAgent.dwn.getDwnEndpointUrlsForTarget(connectedDid);
  } catch {
    // Can't resolve endpoints — leave for next attempt.
    return undefined;
  }

  return { delegateDid, connectedDid, revocations, dwnEndpointUrls };
}

/**
 * Revoke a single grant and send the revocation to remote DWN endpoints.
 * Returns `true` if at least one remote endpoint confirmed (202/409).
 */
async function revokeAndSendSingle(
  userAgent: EnboxUserAgent,
  connectedDid: string,
  delegateDid: string,
  entry: RevocationEntry,
  dwnEndpointUrls: string[],
): Promise<boolean> {
  const { reply: readReply } = await userAgent.dwn.processRequest({
    author        : connectedDid,
    target        : connectedDid,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId: entry.grantId } },
  });
  if (readReply.status.code !== 200 || !readReply.entry) { return false; }

  const grant = DwnPermissionGrant.parse(readReply.entry.recordsWrite as any);
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
    ? new Blob([Uint8Array.from(atob(encodedData), (c: string): number => c.charCodeAt(0))])
    : undefined;

  for (const dwnUrl of dwnEndpointUrls) {
    try {
      const reply = await userAgent.rpc.sendDwnRequest({
        dwnUrl,
        targetDid : connectedDid,
        message   : rawMessage as any,
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
 * Persist the outcome of a retry attempt. If all revocations succeeded,
 * clears the retry context. If some failed, rewrites the context with
 * only the remaining entries.
 */
async function persistRetryOutcome(
  storage: StorageAdapter,
  delegateDid: string,
  connectedDid: string,
  revocations: RevocationEntry[],
  succeeded: string[],
): Promise<void> {
  if (succeeded.length === revocations.length) {
    await clearRetryState(storage);
  } else if (succeeded.length > 0) {
    const remaining = revocations.filter((r) => !succeeded.includes(r.grantId));
    const retryCtx = { delegateDid, connectedDid, revocations: remaining };
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify(retryCtx));
  }
  // If nothing succeeded, leave the retry context for next attempt.
}

/**
 * Retry grant revocations that were not confirmed by the owner's remote
 * DWN during a previous disconnect. Called from `restoreSession()` AFTER
 * sync is started and only when `REVOCATION_RETRY_CONTEXT` exists.
 *
 * This function does NOT restore a session — the user explicitly
 * disconnected and the retry is purely a background cleanup.
 */
async function retryOrphanedRevocations(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
): Promise<void> {
  const ctx = await loadRetryContext(userAgent, storage);
  if (!ctx) { return; }

  const { delegateDid, connectedDid, revocations, dwnEndpointUrls } = ctx;
  const succeeded: string[] = [];

  for (const entry of revocations) {
    try {
      const confirmed = await revokeAndSendSingle(
        userAgent, connectedDid, delegateDid, entry, dwnEndpointUrls,
      );
      if (confirmed) { succeeded.push(entry.grantId); }
    } catch {
      // Individual failure — continue with others.
    }
  }

  await persistRetryOutcome(storage, delegateDid, connectedDid, revocations, succeeded);
}
