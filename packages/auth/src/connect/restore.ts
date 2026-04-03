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

import { applyLocalDwnDiscovery } from '../discovery.js';
import { STORAGE_KEYS } from '../types.js';
import { ensureVaultReady, finalizeSession, resolveIdentityDids, resolvePassword, startSyncIfEnabled } from './lifecycle.js';

/**
 * Attempt to restore a previous session.
 *
 * Returns `undefined` if no previous session exists.
 * Returns an `AuthSession` if the session was successfully restored.
 */
export async function restoreSession(
  ctx: FlowContext,
  options: RestoreSessionOptions = {},
): Promise<AuthSession | undefined> {
  const { userAgent, emitter, storage } = ctx;

  // Check if there was a previous session.
  const previouslyConnected = await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
  if (previouslyConnected !== 'true') {
    return undefined;
  }

  // Resolve password: explicit option → callback → provider → manager default → insecure fallback.
  // Note: restoreSession has an extra `onPasswordRequired` callback that sits between
  // the explicit password and the provider. We handle that here, then delegate the
  // remainder of the chain to `resolvePassword()`.
  let explicitPassword = options.password;

  if (!explicitPassword && !ctx.defaultPassword && options.onPasswordRequired) {
    explicitPassword = await options.onPasswordRequired();
  }

  // Check for stale session marker: if the vault was never initialized,
  // previouslyConnected is a leftover — clean up and bail.
  const isFirstLaunch = await userAgent.firstLaunch();
  if (isFirstLaunch) {
    await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
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

  // Apply local DWN discovery (browser redirect payload or persisted endpoint).
  // In remote mode, discovery already ran before agent creation — skip.
  if (!userAgent.dwn.isRemoteMode) {
    await applyLocalDwnDiscovery(userAgent, storage, emitter);
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

  // Start sync.
  await startSyncIfEnabled(userAgent, ctx.defaultSync);

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
