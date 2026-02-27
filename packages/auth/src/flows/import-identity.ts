/**
 * Identity import flows.
 *
 * - Import from BIP-39 recovery phrase (re-derive vault + identity).
 * - Import from PortableIdentity JSON.
 * @module
 */

import type { Web5UserAgent } from '@enbox/agent';

import { Web5 } from '@enbox/api';

import type { AuthEventEmitter } from '../events.js';
import type {
  ImportFromPhraseOptions,
  ImportFromPortableOptions,
  StorageAdapter,
  SyncOption,
} from '../types.js';
import { AuthSession } from '../identity-session.js';
import { STORAGE_KEYS } from '../types.js';

/** @internal */
export interface ImportContext {
  userAgent: Web5UserAgent;
  emitter: AuthEventEmitter;
  storage: StorageAdapter;
  defaultSync?: SyncOption;
  defaultDwnEndpoints?: string[];
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

  const web5 = new Web5({ agent: userAgent, connectedDid });

  await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
  await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, connectedDid);

  const identityInfo = {
    didUri : connectedDid,
    name   : identity.metadata.name,
  };

  const session = new AuthSession({
    web5,
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

  const web5 = new Web5({ agent: userAgent, connectedDid, delegateDid });

  await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
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

  emitter.emit('identity-added', { identity: identityInfo });
  emitter.emit('session-start', {
    session: { did: connectedDid, delegateDid, identity: identityInfo },
  });

  return session;
}
