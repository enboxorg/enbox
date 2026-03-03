/**
 * Identity import flows.
 *
 * - Import from BIP-39 recovery phrase (re-derive vault + identity).
 * - Import from PortableIdentity JSON.
 * @module
 */

import type { EnboxUserAgent } from '@enbox/agent';

import type { AuthEventEmitter } from '../events.js';
import { AuthSession } from '../identity-session.js';
import { registerWithDwnEndpoints } from './dwn-registration.js';
import { STORAGE_KEYS } from '../types.js';
import type {
  ImportFromPhraseOptions,
  ImportFromPortableOptions,
  RegistrationOptions,
  StorageAdapter,
  SyncOption,
} from '../types.js';

/** @internal */
export interface ImportContext {
  userAgent: EnboxUserAgent;
  emitter: AuthEventEmitter;
  storage: StorageAdapter;
  defaultSync?: SyncOption;
  defaultDwnEndpoints?: string[];
  registration?: RegistrationOptions;
}

/**
 * Import (or recover) an identity from a BIP-39 recovery phrase.
 *
 * This re-initializes the vault with the given phrase and password,
 * recovering the agent DID and all derived keys.
 */
export async function importFromPhrase(
  ctx: ImportContext,
  options: ImportFromPhraseOptions,
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  const { recoveryPhrase, password } = options;
  const sync = options.sync ?? ctx.defaultSync;
  const dwnEndpoints = options.dwnEndpoints ?? ctx.defaultDwnEndpoints ?? ['https://enbox-dwn.fly.dev'];

  // Initialize the vault with the recovery phrase.
  // This re-derives the same agent DID and CEK from the mnemonic.
  if (await userAgent.firstLaunch()) {
    await userAgent.initialize({
      password,
      recoveryPhrase,
      dwnEndpoints,
    });
  }

  await userAgent.start({ password });
  emitter.emit('vault-unlocked', {});

  // The recovery phrase re-derives the same agent DID,
  // but the user identity might not exist yet — create one if needed.
  const identities = await userAgent.identity.list();
  let identity = identities[0];
  let isNewIdentity = false;

  if (!identity) {
    isNewIdentity = true;
    identity = await userAgent.identity.create({
      didMethod  : 'dht',
      metadata   : { name: 'Default' },
      didOptions : {
        services: [
          {
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : dwnEndpoints,
            enc             : '#enc',
            sig             : '#sig',
          }
        ],
        verificationMethods: [
          {
            algorithm : 'Ed25519',
            id        : 'sig',
            purposes  : ['assertionMethod', 'authentication'],
          },
          {
            algorithm : 'X25519',
            id        : 'enc',
            purposes  : ['keyAgreement'],
          },
        ],
      },
    });
  }

  const connectedDid = identity.did.uri;

  // Register with DWN endpoints (if registration options are provided).
  if (ctx.registration) {
    await registerWithDwnEndpoints(
      {
        userAgent : userAgent,
        dwnEndpoints,
        agentDid  : userAgent.agentDid.uri,
        connectedDid,
        storage   : storage,
      },
      ctx.registration,
    );
  }

  // Register and start sync.
  if (isNewIdentity && sync !== 'off') {
    await userAgent.sync.registerIdentity({ did: connectedDid, options: { protocols: [] } });
  }

  if (sync !== 'off') {
    const syncMode = sync === undefined ? 'live' : 'poll';
    const syncInterval = sync ?? (syncMode === 'live' ? '5m' : '2m');
    userAgent.sync.startSync({ mode: syncMode, interval: syncInterval })
      .catch((err: unknown) => console.error('[@enbox/auth] Sync failed:', err));
  }

  await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
  await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, connectedDid);

  const identityInfo = {
    didUri : connectedDid,
    name   : identity.metadata.name,
  };

  const session = new AuthSession({
    agent    : userAgent,
    did      : connectedDid,
    identity : identityInfo,
  });

  emitter.emit('identity-added', { identity: identityInfo });
  emitter.emit('session-start', {
    session: { did: connectedDid, identity: identityInfo },
  });

  return session;
}

/**
 * Import an identity from a PortableIdentity JSON object.
 *
 * The portable identity contains the DID's private keys and metadata,
 * allowing it to be used on this device.
 */
export async function importFromPortable(
  ctx: ImportContext,
  options: ImportFromPortableOptions,
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;
  const sync = options.sync ?? ctx.defaultSync;

  const identity = await userAgent.identity.import({
    portableIdentity: options.portableIdentity,
  });

  const connectedDid = identity.metadata.connectedDid ?? identity.did.uri;
  const delegateDid = identity.metadata.connectedDid ? identity.did.uri : undefined;

  // Register with DWN endpoints (if registration options are provided).
  // For portable imports, extract endpoints from the DID document's DWN service.
  if (ctx.registration) {
    const dwnEndpoints = ctx.defaultDwnEndpoints ?? ['https://enbox-dwn.fly.dev'];
    await registerWithDwnEndpoints(
      {
        userAgent : userAgent,
        dwnEndpoints,
        agentDid  : userAgent.agentDid.uri,
        connectedDid,
        storage   : storage,
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

    const syncMode = sync === undefined ? 'live' : 'poll';
    const syncInterval = sync ?? (syncMode === 'live' ? '5m' : '2m');
    userAgent.sync.startSync({ mode: syncMode, interval: syncInterval })
      .catch((err: unknown) => console.error('[@enbox/auth] Sync failed:', err));
  }

  await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
  await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, connectedDid);

  const identityInfo = {
    didUri       : connectedDid,
    name         : identity.metadata.name,
    connectedDid : identity.metadata.connectedDid,
  };

  const session = new AuthSession({
    agent    : userAgent,
    did      : connectedDid,
    delegateDid,
    identity : identityInfo,
  });

  emitter.emit('identity-added', { identity: identityInfo });
  emitter.emit('session-start', {
    session: { did: connectedDid, delegateDid, identity: identityInfo },
  });

  return session;
}
