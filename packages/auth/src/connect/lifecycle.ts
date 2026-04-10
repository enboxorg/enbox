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
import type { BearerIdentity, DelegateContextKey, DelegateDecryptionKey, DwnDataEncodedRecordsWriteMessage, DwnMessagesPermissionScope, DwnRecordsPermissionScope, EnboxUserAgent } from '@enbox/agent';

import type { AuthEventEmitter } from '../events.js';
import type { PasswordProvider } from '../password-provider.js';
import type { IdentityInfo, RegistrationOptions, StorageAdapter, SyncOption } from '../types.js';

import { Convert } from '@enbox/common';
import type { GenericMessage } from '@enbox/dwn-sdk-js';

import { DataStream, PermissionsProtocol } from '@enbox/dwn-sdk-js';
import { DwnInterface, DwnPermissionGrant, KeyDeliveryProtocolDefinition } from '@enbox/agent';

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

  // Track successfully-written grant recordIds so we can roll them back
  // if any grant fails. Each entry records which partitions were written.
  const written: { recordId: string; delegateWritten: boolean; connectedWritten: boolean }[] = [];

  // Process all grants concurrently — each grant is independent of
  // the others. Within a single grant, the delegate-partition write
  // must succeed before the connected-partition write so that a
  // delegate failure doesn't leave an orphaned connected-partition
  // record.
  //
  // We use allSettled (not all) so that a failure in one grant does
  // not leave other grant writes racing against cleanup. All writes
  // settle before we inspect results.
  const results = await Promise.allSettled(grants.map(async (grantMessage) => {
    const grant = DwnPermissionGrant.parse(grantMessage);

    const { encodedData, ...rawMessage } = grantMessage;
    const recordId = rawMessage.recordId;
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

    written.push({ recordId, delegateWritten: true, connectedWritten: false });

    // Also store the grant in the connectedDid's local DWN partition.
    // We use processRawMessage because the delegate agent does not hold
    // the connectedDid's private keys — we cannot re-sign the message.
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

    // Mark connected partition as written (find our entry by recordId).
    const entry = written.find(w => w.recordId === recordId);
    if (entry) { entry.connectedWritten = true; }

    const protocol = (grant.scope as DwnMessagesPermissionScope | DwnRecordsPermissionScope).protocol;
    // Exclude the permissions protocol — revocation grants are scoped to it
    // but the sync engine must not attempt to sync it separately. Permission
    // records are already included in each protocol's sync stream via
    // PermissionsProtocol.constructAdditionalMessageFilter().
    if (protocol && protocol !== PermissionsProtocol.uri) {
      connectedProtocols.add(protocol);
    }
  }));

  // If any grant failed, roll back all successfully-written grant records
  // before throwing. Without this, stale permission records would remain
  // in the delegate/connected partitions after the connect flow errors.
  const firstFailure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (firstFailure) {
    await Promise.allSettled(written.map(async ({ recordId, delegateWritten, connectedWritten }) => {
      if (delegateWritten) {
        try {
          await agent.processDwnRequest({
            author        : delegateDid,
            target        : delegateDid,
            messageType   : DwnInterface.RecordsDelete,
            messageParams : { recordId },
          });
        } catch { /* best-effort rollback */ }
      }
      if (connectedWritten) {
        try {
          await agent.processDwnRequest({
            author        : connectedDid,
            target        : connectedDid,
            messageType   : DwnInterface.RecordsDelete,
            messageParams : { recordId },
          });
        } catch { /* best-effort rollback */ }
      }
    }));
    throw firstFailure.reason;
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
  delegateContextKeys?: DelegateContextKey[];
  delegateMultiPartyProtocols?: string[];
  sessionRevocations?: { grantId: string; revocationGrantId: string }[];
  flowName: string;
}): Promise<BearerIdentity> {
  const {
    userAgent, delegatePortableDid, connectedDid, delegateGrants,
    delegateDecryptionKeys, delegateContextKeys, delegateMultiPartyProtocols,
    sessionRevocations, flowName,
  } = params;

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

    // Install the key-delivery protocol on the delegate's local DWN so the
    // sync engine's closure validator doesn't flag encrypted records as
    // missing the `keyDeliveryProtocol` dependency.  This is a best-effort
    // install — the protocol only needs to exist locally (it is never sent
    // to the remote DWN for delegates).
    try {
      await userAgent.processDwnRequest({
        author        : connectedDid,
        target        : connectedDid,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: KeyDeliveryProtocolDefinition },
      });
    } catch { /* best effort — closure will fall back to repairing */ }

    // Import delegate protocol path decryption keys if the wallet provided
    // them. These enable the delegate to decrypt ProtocolPath-encrypted
    // records without possessing the owner's root X25519 private key.
    if (delegateDecryptionKeys && delegateDecryptionKeys.length > 0) {
      userAgent.dwn.importDelegateDecryptionKeys(delegatePortableDid.uri, delegateDecryptionKeys);
    }

    // Import context-scoped decryption keys for multi-party encrypted protocols.
    // Always register multi-party protocols (even with zero keys) so the
    // agent can deliver context keys for contexts created after connect.
    if ((delegateContextKeys && delegateContextKeys.length > 0) || (delegateMultiPartyProtocols && delegateMultiPartyProtocols.length > 0)) {
      userAgent.dwn.importDelegateContextKeys(
        delegatePortableDid.uri,
        delegateContextKeys ?? [],
        delegateMultiPartyProtocols,
      );
    }

    // Register (or update) the identity for protocol-scoped sync.
    // If the identity is already registered from a prior session, update
    // the protocol list so it matches the new grants — otherwise a stale
    // `protocols: []` (global sync) would remain and the sync engine
    // would try to sync every protocol including the DWN permissions
    // protocol, which the delegate has no grant for.
    const syncOptions = {
      delegateDid : delegatePortableDid.uri,
      protocols   : connectedProtocols,
    };
    try {
      await userAgent.sync.registerIdentity({ did: connectedDid, options: syncOptions });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '';
      if (msg.includes('already registered')) {
        await userAgent.sync.updateIdentityOptions({ did: connectedDid, options: syncOptions });
      } else {
        throw error;
      }
    }

    // No explicit sync('pull') here — startSyncIfEnabled() in the caller
    // runs an immediate sync cycle (both pull and push) when it starts.
    // Doing a manual pull first would double the startup burst and can
    // trigger rate limits on the remote DWN.

    // Store protocol keys on the identity for finalize to persist.
    if (delegateDecryptionKeys && delegateDecryptionKeys.length > 0) {
      (identity as any)._delegateDecryptionKeys = delegateDecryptionKeys;
    }
    if (delegateContextKeys && delegateContextKeys.length > 0) {
      (identity as any)._delegateContextKeys = delegateContextKeys;
    }
    if (delegateMultiPartyProtocols && delegateMultiPartyProtocols.length > 0) {
      (identity as any)._delegateMultiPartyProtocols = delegateMultiPartyProtocols;
    }
    if (sessionRevocations && sessionRevocations.length > 0) {
      (identity as any)._sessionRevocations = sessionRevocations;
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
  const delegateContextKeys = (identity as any)._delegateContextKeys as DelegateContextKey[] | undefined;

  // Encrypt decryption keys and context keys in parallel — both are independent.
  const [decKeysJwe, ctxKeysJwe] = await Promise.all([
    delegateDecryptionKeys?.length
      ? userAgent.vault.encryptData({ plaintext: Convert.string(JSON.stringify(delegateDecryptionKeys)).toUint8Array() })
      : undefined,
    delegateContextKeys?.length
      ? userAgent.vault.encryptData({ plaintext: Convert.string(JSON.stringify(delegateContextKeys)).toUint8Array() })
      : undefined,
  ]);
  if (decKeysJwe) {
    extraStorageKeys[STORAGE_KEYS.DELEGATE_DECRYPTION_KEYS] = decKeysJwe;
  }
  if (ctxKeysJwe) {
    extraStorageKeys[STORAGE_KEYS.DELEGATE_CONTEXT_KEYS] = ctxKeysJwe;
  }
  const delegateMultiPartyProtocols = (identity as any)._delegateMultiPartyProtocols as string[] | undefined;
  if (delegateMultiPartyProtocols && delegateMultiPartyProtocols.length > 0) {
    extraStorageKeys[STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS] = JSON.stringify(delegateMultiPartyProtocols);
  }
  const sessionRevocations = (identity as any)._sessionRevocations as { grantId: string; revocationGrantId: string }[] | undefined;
  if (sessionRevocations && sessionRevocations.length > 0) {
    extraStorageKeys[STORAGE_KEYS.SESSION_REVOCATIONS] = JSON.stringify(sessionRevocations);
  }

  // Wire post-connect context key persistence: when the owner creates a
  // new multi-party context, the agent injects the key into the delegate
  // cache and fires this callback so we persist the updated keys.
  userAgent.dwn.onDelegateContextKeysChanged = async (changedDelegateDid: string): Promise<void> => {
    if (changedDelegateDid !== delegateDid) { return; }
    try {
      const keys = userAgent.dwn.exportDelegateContextKeys(delegateDid);
      const pt = Convert.string(JSON.stringify(keys)).toUint8Array();
      const encrypted = await userAgent.vault.encryptData({ plaintext: pt });
      await storage.set(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS, encrypted);
    } catch { /* best effort — keys will be re-derived on next connect */ }
  };

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

  // Persist all session markers concurrently — all writes are independent.
  const storageWrites: Promise<void>[] = [
    storage.set(STORAGE_KEYS.PREVIOUSLY_CONNECTED, 'true'),
    storage.set(STORAGE_KEYS.ACTIVE_IDENTITY, connectedDid),
  ];
  if (extraStorageKeys) {
    for (const [key, value] of Object.entries(extraStorageKeys)) {
      storageWrites.push(storage.set(key, value));
    }
  }
  await Promise.all(storageWrites);

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
