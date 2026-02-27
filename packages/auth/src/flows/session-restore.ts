/**
 * Session restore flow.
 *
 * Restores a previously established session from persisted storage,
 * replacing the "previouslyConnected" pattern in apps.
 * @module
 */

import type { Web5UserAgent } from '@enbox/agent';

import { Web5 } from '@enbox/api';

import type { AuthEventEmitter } from '../events.js';
import type { RestoreSessionOptions, StorageAdapter, SyncOption } from '../types.js';
import { AuthSession } from '../identity-session.js';
import { INSECURE_DEFAULT_PASSWORD, STORAGE_KEYS } from '../types.js';

/** @internal */
export interface SessionRestoreContext {
  userAgent: Web5UserAgent;
  emitter: AuthEventEmitter;
  storage: StorageAdapter;
  defaultPassword?: string;
  defaultSync?: SyncOption;
}

/**
 * Attempt to restore a previous session.
 *
 * Returns `undefined` if no previous session exists.
 * Returns an `AuthSession` if the session was successfully restored.
 */
export async function restoreSession(
  ctx: SessionRestoreContext,
  options: RestoreSessionOptions = {},
): Promise<AuthSession | undefined> {
  const { userAgent, emitter, storage } = ctx;

  // Check if there was a previous session.
  const previouslyConnected = await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
  if (previouslyConnected !== 'true') {
    return undefined;
  }

  const password = options.password ?? ctx.defaultPassword ?? INSECURE_DEFAULT_PASSWORD;

  // Warn if using insecure default.
  if (password === INSECURE_DEFAULT_PASSWORD) {
    console.warn(
      '[@enbox/auth] SECURITY WARNING: No password set. Using insecure default. ' +
      'Set a password to protect your identity vault.'
    );
  }

  // Start the agent (initializes + unlocks vault).
  if (await userAgent.firstLaunch()) {
    // Vault doesn't exist yet — this shouldn't happen if previouslyConnected is true.
    // Clean up the stale flag and return undefined.
    await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
    return undefined;
  }

  await userAgent.start({ password });
  emitter.emit('vault-unlocked', {});

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
    // No identity found — clean up stale session data.
    await storage.remove(STORAGE_KEYS.PREVIOUSLY_CONNECTED);
    await storage.remove(STORAGE_KEYS.ACTIVE_IDENTITY);
    await storage.remove(STORAGE_KEYS.DELEGATE_DID);
    await storage.remove(STORAGE_KEYS.CONNECTED_DID);
    return undefined;
  }

  const connectedDid = identity.metadata.connectedDid ?? identity.did.uri;
  const delegateDid = identity.metadata.connectedDid
    ? identity.did.uri
    : (storedDelegateDid ?? undefined);

  // Start sync.
  const sync = ctx.defaultSync;
  if (sync !== 'off') {
    const syncMode = sync === undefined ? 'live' : 'poll';
    const syncInterval = sync ?? (syncMode === 'live' ? '5m' : '2m');
    userAgent.sync.startSync({ mode: syncMode, interval: syncInterval })
      .catch((err: unknown) => {
        console.error('[@enbox/auth] Sync failed:', err);
      });
  }

  const web5 = new Web5({ agent: userAgent, connectedDid, delegateDid });

  // Update persisted session info.
  await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, connectedDid);

  const identityInfo = {
    didUri       : connectedDid,
    name         : identity.metadata.name,
    connectedDid : identity.metadata.connectedDid,
  };

  const session = new AuthSession({
    web5,
    did: connectedDid,
    delegateDid,
    identity: identityInfo,
  });

  emitter.emit('session-start', {
    session: { did: connectedDid, delegateDid, identity: identityInfo },
  });

  return session;
}
