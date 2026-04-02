/**
 * Shared helpers for connect flows.
 *
 * Consolidates duplicated logic across `local-connect`, `session-restore`,
 * `wallet-connect`, and `import-identity` flows:
 *
 * - Password resolution chain
 * - Vault init/start lifecycle
 * - Sync mode/interval calculation and startup
 * - `connectedDid` / `delegateDid` derivation from identity metadata
 * - Session finalization (storage persistence + AuthSession construction + events)
 *
 * @module
 * @internal
 */

import type { PortableDid } from '@enbox/dids';
import type { BearerIdentity, DelegateDecryptionKey, DwnDataEncodedRecordsWriteMessage, DwnMessagesPermissionScope, DwnRecordsPermissionScope, EnboxUserAgent } from '@enbox/agent';

import type { AuthEventEmitter } from '../events.js';
import type { PasswordProvider } from '../password-provider.js';
import type { IdentityInfo, RegistrationOptions, StorageAdapter, SyncOption } from '../types.js';

import { Convert } from '@enbox/common';
import type { GenericMessage } from '@enbox/dwn-sdk-js';

import { DataStream } from '@enbox/dwn-sdk-js';
import { DwnInterface, DwnPermissionGrant } from '@enbox/agent';

import { AuthSession } from '../identity-session.js';
import { DEFAULT_DWN_ENDPOINTS, INSECURE_DEFAULT_PASSWORD, STORAGE_KEYS } from '../types.js';

// ─── FlowContext ─────────────────────────────────────────────────

/**
 * Unified context passed from `AuthManager` to every connect flow.
 *
 * Replaces the per-flow `LocalConnectContext`, `SessionRestoreContext`,
 * `WalletConnectContext`, and `ImportContext` interfaces. All fields are
 * optional beyond the core triple (`userAgent`, `emitter`, `storage`) so
 * flows only consume what they need.
 *
 * @internal
 */
export interface FlowContext {
  userAgent: EnboxUserAgent;
  emitter: AuthEventEmitter;
  storage: StorageAdapter;
  defaultPassword?: string;
  passwordProvider?: PasswordProvider;
  defaultSync?: SyncOption;
  defaultDwnEndpoints?: string[];
  registration?: RegistrationOptions;
}

// ─── resolvePassword ─────────────────────────────────────────────

/**
 * Resolve a password through the standard chain:
 * explicit option → manager default → provider → insecure fallback.
 *
 * Emits a console warning when the insecure default is used.
 *
 * @param ctx          - The flow context (provides `defaultPassword` and `passwordProvider`).
 * @param explicit     - An explicit password from the caller (highest priority).
 * @param isFirstLaunch - Whether the vault has never been initialized.
 * @returns The resolved password string.
 *
 * @internal
 */
export async function resolvePassword(
  ctx: Pick<FlowContext, 'defaultPassword' | 'passwordProvider'>,
  explicit: string | undefined,
  isFirstLaunch: boolean,
): Promise<string> {
  let password = explicit ?? ctx.defaultPassword;

  if (!password && ctx.passwordProvider) {
    try {
      password = await ctx.passwordProvider.getPassword({
        reason: isFirstLaunch ? 'create' : 'unlock',
      });
    } catch (error: unknown) {
      // Log the provider error so developers can distinguish "provider
      // threw" from "no provider configured".  We still fall through to
      // the insecure default because the vault must be unlockable for the
      // session to proceed — but the warning below will fire.
      console.error('[@enbox/auth] Password provider threw an error:', error);
    }
  }

  password ??= INSECURE_DEFAULT_PASSWORD;

  if (password === INSECURE_DEFAULT_PASSWORD) {
    console.warn(
      '[@enbox/auth] SECURITY WARNING: No password set. Using insecure default. ' +
      'Set a password via AuthManager.create({ password }) or connect({ password }) ' +
      'to protect your identity vault.'
    );
  }

  return password;
}

// ─── ensureVaultReady ────────────────────────────────────────────

/**
 * Initialize (on first launch) and start the agent, then emit `vault-unlocked`.
 *
 * This consolidates the 5 copies of:
 * ```ts
 * if (isFirstLaunch) { await userAgent.initialize({ password, ... }); }
 * await userAgent.start({ password });
 * emitter.emit('vault-unlocked', {});
 * ```
 *
 * @returns The recovery phrase if the vault was just initialized, otherwise `undefined`.
 *
 * @internal
 */
export async function ensureVaultReady(params: {
  userAgent: EnboxUserAgent;
  emitter: AuthEventEmitter;
  password: string;
  isFirstLaunch: boolean;
  recoveryPhrase?: string;
  dwnEndpoints?: string[];
}): Promise<string | undefined> {
  const { userAgent, emitter, password, isFirstLaunch } = params;
  let recoveryPhrase: string | undefined;

  if (isFirstLaunch) {
    recoveryPhrase = await userAgent.initialize({
      password,
      recoveryPhrase : params.recoveryPhrase,
      dwnEndpoints   : params.dwnEndpoints,
    });
  }

  await userAgent.start({ password });
  emitter.emit('vault-unlocked', {});

  return recoveryPhrase;
}

// ─── startSyncIfEnabled ─────────────────────────────────────────

/**
 * Start DWN synchronisation if `sync` is not `'off'`.
 *
 * Consolidates 6 copies of:
 * ```ts
 * const syncMode = sync === undefined ? 'live' : 'poll';
 * const syncInterval = sync ?? (syncMode === 'live' ? '5m' : '2m');
 * userAgent.sync.startSync({ mode: syncMode, interval: syncInterval })
 *   .catch((err) => console.error('[@enbox/auth] Sync failed:', err));
 * ```
 *
 * @internal
 */
export async function startSyncIfEnabled(
  userAgent: EnboxUserAgent,
  sync: SyncOption | undefined,
): Promise<void> {
  if (sync === 'off') {
    return;
  }

  const syncMode = sync === undefined ? 'live' : 'poll';
  const syncInterval = sync ?? (syncMode === 'live' ? '5m' : '2m');

  await userAgent.sync.startSync({ mode: syncMode, interval: syncInterval });
}

// ─── createDefaultIdentity ──────────────────────────────────────

/**
 * Create a new `did:dht` identity with Ed25519 signing and X25519
 * encryption keys, and a DWN service endpoint.
 *
 * This consolidates the identical identity creation block that was
 * duplicated in `localConnect` and `importFromPhrase`.
 *
 * @internal
 */
export async function createDefaultIdentity(
  userAgent: EnboxUserAgent,
  dwnEndpoints: string[] = DEFAULT_DWN_ENDPOINTS,
  name = 'Default',
): Promise<BearerIdentity> {
  return userAgent.identity.create({
    didMethod  : 'dht',
    metadata   : { name },
    didOptions : {
      services: [
        {
          id              : 'dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : dwnEndpoints,
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

// ─── resolveIdentityDids ────────────────────────────────────────

/**
 * Derive `connectedDid` and `delegateDid` from identity metadata.
 *
 * For a **local** identity: `connectedDid` is the identity's own DID URI
 * and `delegateDid` is `undefined`.
 *
 * For a **wallet-connected** identity: `connectedDid` is the external wallet
 * DID, and `delegateDid` is the local identity's DID URI.
 *
 * @param identity            - The bearer identity to extract DIDs from.
 * @param storedDelegateDid   - Optional fallback delegate DID from storage,
 *   used by session-restore when the identity metadata doesn't include a
 *   `connectedDid` but a delegate DID was persisted in a prior session.
 *
 * @internal
 */
export function resolveIdentityDids(
  identity: BearerIdentity,
  storedDelegateDid?: string,
): {
  connectedDid: string;
  delegateDid: string | undefined;
} {
  const connectedDid = identity.metadata.connectedDid ?? identity.did.uri;
  const delegateDid = identity.metadata.connectedDid
    ? identity.did.uri
    : (storedDelegateDid ?? undefined);
  return { connectedDid, delegateDid };
}

// ─── processConnectedGrants ─────────────────────────────────────

/**
 * Process connected grants by storing them in the local DWN as the owner.
 *
 * This is the agent-level equivalent of `Enbox.processConnectedGrants()`.
 * It stores each grant, signed as owner, and returns the deduplicated
 * list of protocol URIs represented by the grants.
 *
 * @internal
 */
export async function processConnectedGrants(params: {
  agent: EnboxUserAgent;
  connectedDid: string;
  delegateDid: string;
  grants: DwnDataEncodedRecordsWriteMessage[];
}): Promise<string[]> {
  const { agent, connectedDid, delegateDid, grants } = params;
  const connectedProtocols = new Set<string>();

  for (const grantMessage of grants) {
    const grant = DwnPermissionGrant.parse(grantMessage);

    const { encodedData, ...rawMessage } = grantMessage;
    const dataStream = new Blob([Convert.base64Url(encodedData).toUint8Array() as BlobPart]);

    // Store the grant in the delegateDid's partition so the permissions
    // API can look it up when building delegate-signed requests.
    const { reply: delegateReply } = await agent.processDwnRequest({
      store       : true,
      author      : delegateDid,
      target      : delegateDid,
      messageType : DwnInterface.RecordsWrite,
      signAsOwner : true,
      rawMessage,
      dataStream,
    });

    if (delegateReply.status.code !== 202) {
      throw new Error(
        `[@enbox/auth] Failed to store grant in delegate partition: ${delegateReply.status.detail}`
      );
    }

    // Also store the grant in the connectedDid's local DWN partition.
    // When the sync engine (or any delegate-authorized operation) processes
    // a request against the connectedDid's tenant, the DWN needs to find
    // the grant record there to authorize the delegate.
    //
    // We use processRawMessage because the delegate agent does not hold the
    // connectedDid's private keys — we cannot re-sign the message.  The
    // rawMessage already carries valid authorization from the connectedDid
    // (the wallet signed it), so we pass it directly to the local DWN.
    const connectedReply = await agent.dwn.processRawMessage(
      connectedDid,
      rawMessage as GenericMessage,
      { dataStream: DataStream.fromBytes(Convert.base64Url(encodedData).toUint8Array()) },
    );

    if (connectedReply.status.code !== 202 && connectedReply.status.code !== 409) {
      throw new Error(
        `[@enbox/auth] Failed to store grant in connected partition: ${connectedReply.status.detail}`
      );
    }

    const protocol = (grant.scope as DwnMessagesPermissionScope | DwnRecordsPermissionScope).protocol;
    if (protocol) {
      connectedProtocols.add(protocol);
    }
  }

  return [...connectedProtocols];
}

// ─── importDelegateAndSetupSync ─────────────────────────────────

/**
 * Import a delegated DID, process its grants, register sync, and pull.
 *
 * This is the shared post-connect lifecycle used by both the DWeb Connect
 * and relay WalletConnect flows. On failure, the imported identity is
 * cleaned up before re-throwing.
 *
 * @internal
 */
export async function importDelegateAndSetupSync(params: {
  userAgent: EnboxUserAgent;
  delegatePortableDid: PortableDid;
  connectedDid: string;
  delegateGrants: DwnDataEncodedRecordsWriteMessage[];
  delegateDecryptionKeys?: DelegateDecryptionKey[];
  flowName: string;
}): Promise<BearerIdentity> {
  const { userAgent, delegatePortableDid, connectedDid, delegateGrants, delegateDecryptionKeys, flowName } = params;

  let identity: BearerIdentity | undefined;
  try {
    identity = await userAgent.identity.import({
      portableIdentity: {
        portableDid : delegatePortableDid,
        metadata    : {
          connectedDid,
          name   : 'Default',
          uri    : delegatePortableDid.uri,
          tenant : userAgent.agentDid.uri,
        },
      },
    });

    const connectedProtocols = await processConnectedGrants({
      agent       : userAgent,
      connectedDid,
      delegateDid : delegatePortableDid.uri,
      grants      : delegateGrants,
    });

    // Import delegate protocol path decryption keys if the wallet provided
    // them. These enable the delegate to decrypt ProtocolPath-encrypted
    // records without possessing the owner's root X25519 private key.
    if (delegateDecryptionKeys && delegateDecryptionKeys.length > 0) {
      userAgent.dwn.importDelegateDecryptionKeys(delegatePortableDid.uri, delegateDecryptionKeys);
    }

    await userAgent.sync.registerIdentity({
      did     : connectedDid,
      options : {
        delegateDid : delegatePortableDid.uri,
        protocols   : connectedProtocols,
      },
    });

    // No explicit sync('pull') here — startSyncIfEnabled() in the caller
    // runs an immediate sync cycle (both pull and push) when it starts.
    // Doing a manual pull first would double the startup burst and can
    // trigger rate limits on the remote DWN.

    // Store protocol keys on the identity for finalize to persist.
    if (delegateDecryptionKeys && delegateDecryptionKeys.length > 0) {
      (identity as any)._delegateDecryptionKeys = delegateDecryptionKeys;
    }

    return identity;
  } catch (error: unknown) {
    if (identity) {
      try {
        await userAgent.did.delete({
          didUri    : identity.did.uri,
          tenant    : identity.metadata.tenant,
          deleteKey : true,
        });
      } catch { /* best effort */ }

      try {
        await userAgent.identity.delete({ didUri: identity.did.uri });
      } catch { /* best effort */ }
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[@enbox/auth] ${flowName} failed: ${message}`);
  }
}

// ─── finalizeDelegateSession ────────────────────────────────────

/**
 * Build an `AuthSession` for a delegated connect flow (DWeb Connect or
 * relay WalletConnect). Starts sync and persists delegate/connected DID
 * markers.
 *
 * @internal
 */
export async function finalizeDelegateSession(params: {
  userAgent: EnboxUserAgent;
  emitter: AuthEventEmitter;
  storage: StorageAdapter;
  identity: BearerIdentity;
  connectedDid: string;
  delegateDid: string;
  sync: SyncOption | undefined;
}): Promise<AuthSession> {
  const { userAgent, emitter, storage, identity, connectedDid, delegateDid, sync } = params;

  await startSyncIfEnabled(userAgent, sync);

  // Persist protocol path keys alongside the delegate session markers
  // so they survive agent restarts.
  const delegateDecryptionKeys = (identity as any)._delegateDecryptionKeys as DelegateDecryptionKey[] | undefined;
  const extraStorageKeys: Record<string, string> = {
    [STORAGE_KEYS.DELEGATE_DID]  : delegateDid,
    [STORAGE_KEYS.CONNECTED_DID] : connectedDid,
  };
  if (delegateDecryptionKeys && delegateDecryptionKeys.length > 0) {
    extraStorageKeys[STORAGE_KEYS.DELEGATE_DECRYPTION_KEYS] = JSON.stringify(delegateDecryptionKeys);
  }

  return finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    identityName         : identity.metadata.name,
    identityConnectedDid : identity.metadata.connectedDid,
    extraStorageKeys,
  });
}

// ─── finalizeSession ────────────────────────────────────────────

/**
 * Persist session markers, build an `AuthSession`, and emit lifecycle events.
 *
 * Consolidates 5 copies of:
 * ```ts
 * await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
 * await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, connectedDid);
 * const session = new AuthSession({ ... });
 * emitter.emit('identity-added', { identity: identityInfo });
 * emitter.emit('session-start', { session: { ... } });
 * ```
 *
 * @param params.emitIdentityAdded - Whether to emit `identity-added`. Defaults to `true`.
 *   Set to `false` for session-restore (identity was already added in the original flow).
 * @param params.extraStorageKeys  - Additional key-value pairs to persist (e.g. delegate/connected DIDs
 *   for wallet-connect flows).
 *
 * @internal
 */
export async function finalizeSession(params: {
  userAgent: EnboxUserAgent;
  emitter: AuthEventEmitter;
  storage: StorageAdapter;
  connectedDid: string;
  delegateDid?: string;
  recoveryPhrase?: string;
  identityName?: string;
  identityConnectedDid?: string;
  emitIdentityAdded?: boolean;
  extraStorageKeys?: Record<string, string>;
}): Promise<AuthSession> {
  const {
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    recoveryPhrase,
    identityName,
    identityConnectedDid,
    emitIdentityAdded = true,
    extraStorageKeys,
  } = params;

  // Persist session markers.
  await storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true');
  await storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, connectedDid);

  if (extraStorageKeys) {
    for (const [key, value] of Object.entries(extraStorageKeys)) {
      await storage.set(key, value);
    }
  }

  // When identityName is undefined, no user identity exists (agent-only session).
  // Build an IdentityInfo with the agent DID as a fallback.
  const identityInfo: IdentityInfo = {
    didUri       : connectedDid,
    name         : identityName ?? 'Agent',
    connectedDid : identityConnectedDid,
  };

  const session = new AuthSession({
    agent    : userAgent,
    did      : connectedDid,
    delegateDid,
    recoveryPhrase,
    identity : identityInfo,
  });

  if (emitIdentityAdded && identityName !== undefined) {
    emitter.emit('identity-added', { identity: identityInfo });
  }

  emitter.emit('session-start', {
    session: { did: connectedDid, delegateDid, identity: identityInfo },
  });

  return session;
}
