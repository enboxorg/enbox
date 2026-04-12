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

import type { DwnDataEncodedRecordsWriteMessage } from '@enbox/agent';

import { Convert } from '@enbox/common';
import { DataStream, PermissionsProtocol } from '@enbox/dwn-sdk-js';
import { DwnInterface, DwnPermissionGrant } from '@enbox/agent';

import { applyLocalDwnDiscovery } from '../discovery.js';
import { STORAGE_KEYS } from '../types.js';
import { ensureVaultReady, finalizeSession, resolveIdentityDids, resolvePassword, startSyncIfEnabled } from './lifecycle.js';

/**
 * Decrypt a stored key blob.
 *
 * The stored value is either a compact JWE (encrypted with the vault CEK)
 * or a plaintext JSON string (from sessions created before the encryption-
 * at-rest fix). This function tries JWE decryption first, then falls back
 * to treating the value as raw JSON for backward compatibility.
 */
async function decryptStoredKeys(
  userAgent: EnboxUserAgent,
  stored: string,
): Promise<string> {
  // JWE compact serialization has exactly 4 dots (5 segments).
  if (stored.split('.').length === 5) {
    const plaintext = await userAgent.vault.decryptData({ jwe: stored });
    return Convert.uint8Array(plaintext).toString();
  }
  // Not a JWE — assume plaintext JSON (backward compat).
  return stored;
}

/**
 * Load delegate keys from SecretStore, falling back to legacy StorageAdapter.
 *
 * On a successful legacy read the keys are migrated into the SecretStore and
 * the plaintext/JWE copy is removed (best-effort). Returns the JSON string
 * representation of the keys, or `undefined` if nothing is stored.
 */
async function loadDelegateKeysWithFallback(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
  key: string,
): Promise<string | undefined> {
  // 1. Try SecretStore (preferred path).
  try {
    const bytes = await userAgent.secrets.get(key);
    if (bytes) {
      return Convert.uint8Array(bytes).toString();
    }
  } catch { /* vault may be locked — fall through to legacy path */ }

  // 2. Fall back to legacy StorageAdapter (JWE or plaintext JSON).
  const legacy = await storage.get(key);
  if (!legacy) { return undefined; }

  try {
    const json = await decryptStoredKeys(userAgent, legacy);

    // Migrate into SecretStore and remove legacy copy (best-effort).
    try {
      await userAgent.secrets.put(key, Convert.string(json).toUint8Array());
      await storage.remove(key);
    } catch { /* best-effort migration */ }

    return json;
  } catch {
    return undefined;
  }
}

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

  if (!identity) {
    // No identity found — this is valid for agent-only sessions created
    // with `createIdentity: false`. Restore a session using the agent DID.
    // If the active identity stored was the agent DID, this is an
    // intentional agent-only session rather than stale data.
    const isAgentOnlySession = activeIdentityDid === userAgent.agentDid.uri;

    if (!isAgentOnlySession) {
      // Truly stale session data — clean up and bail.
      // Remove delegate keys from both SecretStore and legacy StorageAdapter.
      await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
      await storage.remove(STORAGE_KEYS.ACTIVE_IDENTITY);
      await storage.remove(STORAGE_KEYS.DELEGATE_DID);
      await storage.remove(STORAGE_KEYS.CONNECTED_DID);
      await storage.remove(STORAGE_KEYS.DELEGATE_DECRYPTION_KEYS);
      await storage.remove(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS);
      await storage.remove(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS);
      await storage.remove(STORAGE_KEYS.SESSION_REVOCATIONS);
      try { await userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_DECRYPTION_KEYS); } catch { /* best-effort */ }
      try { await userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS); } catch { /* best-effort */ }
      // Do NOT remove REVOCATION_RETRY_CONTEXT here — it has its own
      // lifecycle managed by the retry maintenance path. Stale session
      // cleanup must not silently drop pending revocations.
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

  // Ensure the sync registration is protocol-scoped for delegate sessions.
  // Previous versions registered delegates with protocols: [] (global sync),
  // which causes the sync engine to attempt syncing the permissions protocol
  // and fail with "No permissions found for MessagesSync".
  // Derive the correct protocol list from stored grants and update.
  // Always repair regardless of sync state — a stale registration persists
  // on disk and would take effect if sync is later enabled.
  let syncRepairFailed = false;
  if (delegateDid) {
    try {
      const protocols = await deriveProtocolsFromGrants(userAgent, delegateDid);
      if (protocols === 'all' || protocols.length > 0) {
        const options = {
          delegateDid,
          protocols: protocols === 'all' ? 'all' as const : protocols as [string, ...string[]],
        };
        try {
          await userAgent.sync.registerIdentity({ did: connectedDid, options });
        } catch (regError: unknown) {
          const msg = regError instanceof Error ? regError.message : '';
          if (msg.includes('already registered')) {
            await userAgent.sync.updateIdentityOptions({ did: connectedDid, options });
          } else {
            throw regError;
          }
        }
      } else {
        // Zero grants — remove any stale sync registration so revoked protocols stop syncing.
        try {
          await userAgent.sync.unregisterIdentity(connectedDid);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : '';
          if (!msg.includes('is not registered')) { throw error; }
        }
      }
    } catch {
      // Grant query failed — don't block restore, but don't start sync
      // with a potentially stale registration.
      syncRepairFailed = true;
    }
  }

  // Restore delegate decryption/context keys BEFORE starting sync so that
  // the first sync cycle can decrypt encrypted records.
  //
  // Keys are loaded from the vault-backed SecretStore (preferred). When
  // the SecretStore is empty, we fall back to the legacy StorageAdapter
  // which may hold either a compact JWE (encrypted with the vault CEK)
  // or raw JSON (from sessions created before the encryption-at-rest fix).
  // On successful fallback, the legacy copy is removed (best-effort) so
  // all future reads come from the SecretStore.
  if (delegateDid && connectedDid) {
    const decryptionKeysJson = await loadDelegateKeysWithFallback(userAgent, storage, STORAGE_KEYS.DELEGATE_DECRYPTION_KEYS);
    if (decryptionKeysJson) {
      try {
        const keys = JSON.parse(decryptionKeysJson);
        if (Array.isArray(keys) && keys.length > 0) {
          userAgent.dwn.importDelegateDecryptionKeys(delegateDid, keys);
        }
      } catch { /* best effort — keys will be refreshed on next connect */ }
    }

    // Restore context keys for multi-party encrypted protocols.
    const contextKeysJson = await loadDelegateKeysWithFallback(userAgent, storage, STORAGE_KEYS.DELEGATE_CONTEXT_KEYS);
    // Restore multi-party protocol registrations (not encrypted — no key material).
    const mpProtocolsJson = await storage.get(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS);
    let multiPartyProtocols: string[] | undefined;
    if (mpProtocolsJson) {
      try {
        const parsed = JSON.parse(mpProtocolsJson);
        if (Array.isArray(parsed)) { multiPartyProtocols = parsed; }
      } catch { /* best effort */ }
    }

    if (contextKeysJson || multiPartyProtocols) {
      try {
        const ctxKeys = contextKeysJson ? JSON.parse(contextKeysJson) : [];
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
        const bytes = Convert.string(JSON.stringify(keys)).toUint8Array();
        await userAgent.secrets.put(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS, bytes);
      } catch { /* best effort — keys will be re-derived on next connect */ }
    };
  }

  // Start sync only if the registration repair succeeded (or was not needed).
  // If repair failed, don't start sync with potentially stale scope.
  if (!syncRepairFailed) {
    await startSyncIfEnabled(userAgent, ctx.defaultSync);
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
    const entries = Array.isArray(parsed)
      ? parsed
      : (parsed?.delegateDid && parsed?.connectedDid && Array.isArray(parsed?.revocations))
        ? [parsed]
        : [];

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

    const { encodedData, ...rawMessage } = reply.entry.recordsWrite as any;
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
  if (readReply.status.code !== 200 || !readReply.entry) { return false; }

  // Reconstruct DwnDataEncodedRecordsWriteMessage: RecordsRead returns
  // the data as a stream, but PermissionGrant.parse needs encodedData.
  const grantDataBytes = readReply.entry.data
    ? await DataStream.toBytes(readReply.entry.data)
    : new Uint8Array(0);
  const grantMessageWithData = {
    ...readReply.entry.recordsWrite,
    encodedData: Convert.uint8Array(grantDataBytes).toBase64Url(),
  };
  const grant = DwnPermissionGrant.parse(grantMessageWithData as any);

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

  for (const entry of [...entries]) {
    let remoteDwnUrls: string[] = [];
    try {
      remoteDwnUrls = await userAgent.dwn.getRemoteDwnEndpointUrls(entry.connectedDid);
    } catch {
      continue; // Can't resolve endpoints for this entry — try next.
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

    // Update the in-memory collection so the next iteration sees
    // the correct state (avoid stale-snapshot overwrites).
    const remaining = entry.revocations.filter((r) => !succeeded.includes(r.grantId));
    if (remaining.length === 0) {
      entries = entries.filter((e) => e.delegateDid !== entry.delegateDid);
    } else {
      entries = entries.map((e) =>
        e.delegateDid === entry.delegateDid ? { ...e, revocations: remaining } : e,
      );
    }
  }

  // Write the final state once after processing all entries.
  if (entries.length === 0) {
    await clearRetryState(storage);
  } else {
    await storage.set(STORAGE_KEYS.REVOCATION_RETRY_CONTEXT, JSON.stringify(entries));
  }
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
async function deriveProtocolsFromGrants(
  userAgent: EnboxUserAgent,
  delegateDid: string,
): Promise<'all' | string[]> {
  const response = await userAgent.processDwnRequest({
    author        : delegateDid,
    target        : delegateDid,
    messageType   : DwnInterface.RecordsQuery,
    messageParams : {
      filter: {
        protocol     : PermissionsProtocol.uri,
        protocolPath : PermissionsProtocol.grantPath,
      },
    },
  });

  const protocols: string[] = [];
  if (response.reply.status.code === 200 && response.reply.entries) {
    for (const entry of response.reply.entries as DwnDataEncodedRecordsWriteMessage[]) {
      const grant = DwnPermissionGrant.parse(entry);
      const scope = grant.scope;
      const scopeProtocol = scope.protocol;
      if (scopeProtocol === undefined && (scope as any).interface === 'Messages') {
        // Unrestricted Messages grant (no protocol scope) — delegate can sync all protocols.
        return 'all';
      }
      if (scopeProtocol && scopeProtocol !== PermissionsProtocol.uri) {
        protocols.push(scopeProtocol);
      }
    }
  }

  return [...new Set(protocols)];
}
