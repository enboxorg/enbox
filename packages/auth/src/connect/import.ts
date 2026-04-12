/**
 * Identity import flows.
 *
 * - Import from BIP-39 recovery phrase (re-derive vault + identity).
 * - Import from PortableIdentity JSON.
 * @module
 */

import type { AuthSession } from '../identity-session.js';
import type { FlowContext } from './lifecycle.js';
import type { ImportFromPhraseOptions, ImportFromPortableOptions } from '../types.js';

import { DEFAULT_DWN_ENDPOINTS } from '../types.js';
import { registerWithDwnEndpoints } from '../registration.js';
import { createDefaultIdentity, ensureVaultReady, finalizeSession, resolveIdentityDids, startSyncIfEnabled } from './lifecycle.js';

/**
 * Import (or recover) an identity from a BIP-39 recovery phrase.
 *
 * This re-initializes the vault with the given phrase and password,
 * recovering the agent DID and all derived keys.
 */
export async function importFromPhrase(
  ctx: FlowContext,
  options: ImportFromPhraseOptions,
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  const { recoveryPhrase, password } = options;
  const sync = options.sync ?? ctx.defaultSync;
  const dwnEndpoints = options.dwnEndpoints ?? ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;

  // Initialize the vault with the recovery phrase and start the agent.
  const isFirstLaunch = await userAgent.firstLaunch();
  await ensureVaultReady({
    userAgent,
    emitter,
    password,
    isFirstLaunch,
    recoveryPhrase,
    dwnEndpoints,
  });

  // The recovery phrase re-derives the same agent DID,
  // but the user identity might not exist yet — create one if needed.
  const identities = await userAgent.identity.list();
  let identity = identities[0];
  let isNewIdentity = false;

  if (!identity) {
    isNewIdentity = true;
    identity = await createDefaultIdentity(userAgent, dwnEndpoints);
  }

  const { connectedDid, delegateDid } = resolveIdentityDids(identity);

  // Register with DWN endpoints (if registration options are provided).
  if (ctx.registration) {
    await registerWithDwnEndpoints(
      {
        userAgent   : userAgent,
        dwnEndpoints,
        agentDid    : userAgent.agentDid.uri,
        connectedDid,
        secretStore : userAgent.secrets,
        storage     : storage,
      },
      ctx.registration,
    );
  }

  // Register sync for new identities.
  if (isNewIdentity && sync !== 'off') {
    await userAgent.sync.registerIdentity({
      did     : connectedDid,
      options : { delegateDid, protocols: [] },
    });
  }

  // Start sync.
  await startSyncIfEnabled(userAgent, sync);

  // Persist session info, build AuthSession, and emit lifecycle events.
  return finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    identityName         : identity.metadata.name,
    identityConnectedDid : identity.metadata.connectedDid,
  });
}

/**
 * Import an identity from a PortableIdentity JSON object.
 *
 * The portable identity contains the DID's private keys and metadata,
 * allowing it to be used on this device.
 */
export async function importFromPortable(
  ctx: FlowContext,
  options: ImportFromPortableOptions,
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  const sync = options.sync ?? ctx.defaultSync;

  const identity = await userAgent.identity.import({
    portableIdentity: options.portableIdentity,
  });

  const { connectedDid, delegateDid } = resolveIdentityDids(identity);

  // Register with DWN endpoints (if registration options are provided).
  // For portable imports, extract endpoints from the DID document's DWN service.
  if (ctx.registration) {
    const dwnEndpoints = ctx.defaultDwnEndpoints ?? DEFAULT_DWN_ENDPOINTS;
    await registerWithDwnEndpoints(
      {
        userAgent   : userAgent,
        dwnEndpoints,
        agentDid    : userAgent.agentDid.uri,
        connectedDid,
        secretStore : userAgent.secrets,
        storage     : storage,
      },
      ctx.registration,
    );
  }

  // Register and start sync.
  if (sync !== 'off') {
    await userAgent.sync.registerIdentity({
      did     : connectedDid,
      options : { delegateDid, protocols: [] },
    });
  }

  await startSyncIfEnabled(userAgent, sync);

  // Persist session info, build AuthSession, and emit lifecycle events.
  return finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    identityName         : identity.metadata.name,
    identityConnectedDid : identity.metadata.connectedDid,
  });
}
