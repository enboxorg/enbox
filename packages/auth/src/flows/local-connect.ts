/**
 * Local DID connect flow.
 *
 * Creates or reconnects a local identity with vault-protected keys.
 * This replaces the "Mode D/E" paths in Enbox.connect().
 * @module
 */

import type { EnboxUserAgent } from '@enbox/agent';

import type { AuthEventEmitter } from '../events.js';
import type { PasswordProvider } from '../password-provider.js';
import type { LocalConnectOptions, RegistrationOptions, StorageAdapter, SyncOption } from '../types.js';

import { applyLocalDwnDiscovery } from './dwn-discovery.js';
import { AuthSession } from '../identity-session.js';
import { registerWithDwnEndpoints } from './dwn-registration.js';
import { INSECURE_DEFAULT_PASSWORD, STORAGE_KEYS } from '../types.js';

/** @internal */
export interface LocalConnectContext {
  userAgent: EnboxUserAgent;
  emitter: AuthEventEmitter;
  storage: StorageAdapter;
  defaultPassword?: string;
  passwordProvider?: PasswordProvider;
  defaultSync?: SyncOption;
  defaultDwnEndpoints?: string[];
  registration?: RegistrationOptions;
}

/**
 * Execute the local connect flow.
 *
 * - On first launch: initializes the vault, creates a new DID, returns recovery phrase.
 * - On subsequent launches: unlocks the vault and reconnects to the existing identity.
 */
export async function localConnect(
  ctx: LocalConnectContext,
  options: LocalConnectOptions = {},
): Promise<AuthSession> {
  const { userAgent, emitter, storage } = ctx;

  // Resolve password: explicit option → provider → manager default → insecure fallback.
  const isFirstLaunch = await userAgent.firstLaunch();
  let password = options.password ?? ctx.defaultPassword;

  if (!password && ctx.passwordProvider) {
    try {
      password = await ctx.passwordProvider.getPassword({
        reason: isFirstLaunch ? 'create' : 'unlock',
      });
    } catch {
      // Provider failed — fall through to insecure default.
    }
  }

  password ??= INSECURE_DEFAULT_PASSWORD;

  const sync = options.sync ?? ctx.defaultSync;
  const dwnEndpoints = options.dwnEndpoints ?? ctx.defaultDwnEndpoints ?? ['https://enbox-dwn.fly.dev'];

  // Warn if using insecure default.
  if (password === INSECURE_DEFAULT_PASSWORD) {
    console.warn(
      '[@enbox/auth] SECURITY WARNING: No password set. Using insecure default. ' +
      'Set a password via AuthManager.create({ password }) or connect({ password }) ' +
      'to protect your identity vault.'
    );
  }

  let recoveryPhrase: string | undefined;

  // Initialize vault on first launch.
  if (isFirstLaunch) {
    recoveryPhrase = await userAgent.initialize({
      password,
      recoveryPhrase: options.recoveryPhrase,
      dwnEndpoints,
    });
  }

  // Start the agent (unlocks vault if locked, sets agentDid).
  await userAgent.start({ password });
  emitter.emit('vault-unlocked', {});

  // Apply local DWN discovery (browser redirect payload or persisted endpoint).
  await applyLocalDwnDiscovery(userAgent, storage, emitter);

  // Find or create the user identity.
  const identities = await userAgent.identity.list();
  let identity = identities[0];
  let isNewIdentity = false;

  if (!identity) {
    isNewIdentity = true;
    identity = await userAgent.identity.create({
      didMethod  : 'dht',
      metadata   : { name: options.metadata?.name ?? 'Default' },
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

  const connectedDid = identity.metadata.connectedDid ?? identity.did.uri;
  const delegateDid = identity.metadata.connectedDid ? identity.did.uri : undefined;

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

  // Register sync for new identities.
  if (isNewIdentity && sync !== 'off') {
    await userAgent.sync.registerIdentity({
      did     : connectedDid,
      options : { delegateDid, protocols: [] },
    });
  }

  // Start sync.
  if (sync !== 'off') {
    const syncMode = sync === undefined ? 'live' : 'poll';
    const syncInterval = sync ?? (syncMode === 'live' ? '5m' : '2m');
    userAgent.sync.startSync({ mode: syncMode, interval: syncInterval })
      .catch((error: unknown) => {
        console.error('[@enbox/auth] Sync failed:', error);
      });
  }

  // Persist session info.
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
    recoveryPhrase,
    identity : identityInfo,
  });

  emitter.emit('identity-added', { identity: identityInfo });
  emitter.emit('session-start', {
    session: {
      did      : session.did,
      delegateDid,
      identity : identityInfo,
    },
  });

  return session;
}
