/**
 * Shared helpers for connect flows.
 *
 * Consolidates duplicated logic across `vault-connect`, `session-restore`,
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

import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { PortableDid } from '@enbox/dids';
import type { AgentSessionIdentity, BearerIdentity, DwnDataEncodedRecordsWriteMessage, EnboxUserAgent, PermissionGrantEntry, SyncIdentityOptions } from '@enbox/agent';

import type { AuthEventEmitter } from '../events.js';
import type { PasswordProvider } from '../password-provider.js';
import type { IdentitySyncProtocols, RegistrationOptions, StorageAdapter, SyncOption } from '../types.js';

import { Convert } from '@enbox/common';
import { DataStream, PermissionsProtocol } from '@enbox/dwn-sdk-js';
import { DwnInterface, DwnPermissionGrant, HdIdentityVaultRecoveryPhraseMismatchError } from '@enbox/agent';

import { AuthSession } from '../identity-session.js';
import { RecoveryPhraseMismatchError } from '../errors.js';
import { DEFAULT_DWN_ENDPOINTS, INSECURE_DEFAULT_PASSWORD, STORAGE_KEYS } from '../types.js';

// ─── FlowContext ─────────────────────────────────────────────────

/**
 * Unified context passed from `AuthManager` to every connect flow.
 *
 * Replaces the per-flow `VaultConnectContext`, `SessionRestoreContext`,
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
  defaultIdentitySyncProtocols?: IdentitySyncProtocols;
  defaultDwnEndpoints?: string[];
  registration?: RegistrationOptions;
  /** Throws when teardown invalidated this manager-owned flow. */
  assertActive?: () => void;
  /** Serializes a local mutation against session teardown. */
  runMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Serializes terminal finalization and installs the returned session. */
  commitSession?: (operation: () => Promise<AuthSession>) => Promise<AuthSession>;
}

/** Assert that a manager-owned flow is still active. Direct flow calls are unrestricted. */
export function assertFlowActive(ctx: FlowContext): void {
  ctx.assertActive?.();
}

/** Run a local mutation through the manager lifecycle mutex when one is present. */
export async function runFlowMutation<T>(ctx: FlowContext, operation: () => Promise<T>): Promise<T> {
  return ctx.runMutation === undefined ? operation() : ctx.runMutation(operation);
}

/** Commit a finalized session through the manager lifecycle mutex when one is present. */
export async function commitFlowSession(
  ctx: FlowContext,
  operation: () => Promise<AuthSession>,
): Promise<AuthSession> {
  return ctx.commitSession === undefined ? operation() : ctx.commitSession(operation);
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

  // Two cases reach this branch: no password was supplied at any level
  // (and we fell through to the insecure default), or the caller explicitly
  // supplied an empty string. Both produce a vault with effectively zero
  // password protection — surface a single warning in both cases.
  if (password === INSECURE_DEFAULT_PASSWORD || password.length === 0) {
    console.warn(
      '[@enbox/auth] SECURITY WARNING: No password set (or an empty string was supplied). ' +
      'Using an insecure default; this leaves the identity vault unprotected. ' +
      'Set a non-empty password via AuthManager.create({ password }) or connect({ password }).'
    );
  }

  return password;
}

// ─── ensureVaultReady ────────────────────────────────────────────

/**
 * Initialize or recover the vault, start the agent, then emit `vault-unlocked`.
 *
 * This consolidates the 5 copies of:
 * ```ts
 * if (isFirstLaunch) { await userAgent.initialize({ password, ... }); }
 * await userAgent.start({ password });
 * emitter.emit('vault-unlocked', {});
 * ```
 *
 * When `recoveryPhrase` is supplied for an already-initialized vault, the phrase is verified
 * against the stored agent DID and the vault password is reset without replacing local data.
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
  } else if (params.recoveryPhrase) {
    try {
      await userAgent.vault.resetPasswordWithRecoveryPhrase({
        recoveryPhrase: params.recoveryPhrase,
        password,
      });
    } catch (error) {
      if (error instanceof HdIdentityVaultRecoveryPhraseMismatchError) {
        throw new RecoveryPhraseMismatchError();
      }
      throw error;
    }
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

  if (userAgent.sync.hasActiveSubscriptions) { return; } // registerIdentity() hot-adds inline
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
 * duplicated across vault recovery and identity import flows.
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

// ─── deriveSyncScopeFromGrants ──────────────────────────────────

/**
 * Derive the sync protocol scope from a set of parsed permission grants.
 *
 * Only `Messages.Read` grants authorize feed sync operations. Other grant types
 * (Records.Write, Protocols.Query, etc.) are ignored even if they contain a
 * `protocol` field — they do not authorize message-feed reads.
 *
 * - Unscoped `Messages.Read` (no `protocol`) → `'all'` (full replica)
 * - Scoped `Messages.Read` grants → collected protocol URIs
 * - No sync-relevant grants → `[]` (caller should unregister)
 *
 * Expired grants are excluded.
 *
 * @internal
 */
export function deriveSyncScopeFromGrants(grants: DwnPermissionGrant[]): 'all' | string[] {
  const now = new Date().toISOString();
  const protocols = new Set<string>();

  for (const grant of grants) {
    // Only Messages.Read grants authorize sync. The discriminated union
    // (`PermissionScope = Messages | Protocols | Records`) narrows
    // `scope.protocol` to `string | undefined` after the interface +
    // method checks — no cast needed.
    const { scope } = grant;
    if (scope.interface !== 'Messages' || scope.method !== 'Read') {
      continue;
    }

    // Skip expired grants.
    if (grant.dateExpires && grant.dateExpires <= now) {
      continue;
    }

    const protocol = scope.protocol;
    if (protocol === undefined) {
      // Unrestricted Messages.Read — delegate can sync all protocols.
      return 'all';
    }
    if (protocol !== PermissionsProtocol.uri) {
      if (scope.protocolPath !== undefined || scope.contextId !== undefined) {
        continue;
      }
      protocols.add(protocol);
    }
  }

  return [...protocols];
}

/**
 * Query the delegate's stored grants and revocations, filter out revoked
 * and expired grants, and derive the sync protocol scope.
 *
 * Used by both `restoreSession()` and `switchIdentity()` to compute the
 * correct sync registration from persisted grant state.
 *
 * @internal
 */
export async function deriveActiveSyncScope(
  userAgent: EnboxUserAgent,
  delegateDid: string,
): Promise<'all' | string[]> {
  const grantEntries: PermissionGrantEntry[] = await userAgent.permissions.fetchGrants({
    author       : delegateDid,
    target       : delegateDid,
    grantee      : delegateDid,
    checkRevoked : true,
  });

  return deriveSyncScopeFromGrants(grantEntries.map(({ grant }) => grant));
}

// ─── toSyncIdentityProtocols ────────────────────────────────────

/**
 * Narrow a derived sync scope (`'all' | string[]`) to the form required by
 * `SyncIdentityOptions.protocols` (`'all' | [string, ...string[]]`).
 *
 * Returns `undefined` when the scope is an empty array, signalling the
 * caller should unregister the identity rather than register it.
 *
 * @internal
 */
export function toSyncIdentityProtocols(
  scope: 'all' | string[],
): 'all' | [string, ...string[]] | undefined {
  if (scope === 'all') { return 'all'; }
  if (scope.length === 0) { return undefined; }
  return scope as [string, ...string[]];
}

// ─── sync registration helpers ──────────────────────────────────

/**
 * Register a sync identity, falling back to `updateIdentityOptions` when the
 * identity is already registered from a prior session.
 *
 * @internal
 */
async function registerOrUpdateIdentitySync(
  userAgent: EnboxUserAgent,
  connectedDid: string,
  options: SyncIdentityOptions,
): Promise<void> {
  try {
    await userAgent.sync.registerIdentity({ did: connectedDid, options });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('already registered')) {
      await userAgent.sync.updateIdentityOptions({ did: connectedDid, options });
    } else {
      throw error;
    }
  }
}

/**
 * Clear a stale sync registration, tolerating an "is not registered" error
 * from an identity that was never registered (or already unregistered).
 *
 * @internal
 */
async function unregisterStaleIdentitySync(
  userAgent: EnboxUserAgent,
  connectedDid: string,
): Promise<void> {
  try {
    await userAgent.sync.unregisterIdentity(connectedDid);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : '';
    if (!msg.includes('is not registered')) { throw error; }
  }
}

/**
 * Derive a delegate's active sync scope from its stored grants and either
 * register/update its sync protocol list, or clear a stale registration when
 * no sync-relevant grants remain.
 *
 * @internal
 */
async function registerDelegateSyncScope(
  userAgent: EnboxUserAgent,
  connectedDid: string,
  delegateDid: string,
): Promise<void> {
  const scope = await deriveActiveSyncScope(userAgent, delegateDid);
  const narrowed = toSyncIdentityProtocols(scope);
  if (narrowed === undefined) {
    // Zero grants — clear any stale sync registration so revoked protocols stop syncing.
    await unregisterStaleIdentitySync(userAgent, connectedDid);
    return;
  }

  await registerOrUpdateIdentitySync(userAgent, connectedDid, { delegateDid, protocols: narrowed });
}

// ─── registerSyncScopeForIdentity ───────────────────────────────

/**
 * Register (or update, or clear) the sync registration for an identity based on
 * its derived protocol scope.
 *
 * - For a **delegate session**: queries the delegate's active grants via
 *   {@link deriveActiveSyncScope}, then registers with `protocols: 'all'` or a
 *   scoped list when grants are present, or unregisters the identity when no
 *   sync-relevant grants remain (so revoked protocols stop syncing). The
 *   "is not registered" error from unregister is silently tolerated;
 *   `"already registered"` from register falls back to `updateIdentityOptions`.
 *
 * - For a **local session** (no `delegateDid`): registers only when the
 *   caller supplied an explicit protocol scope. If no scope is supplied, auth
 *   leaves local identity sync registration to the application.
 *
 * @internal
 */
export async function registerSyncScopeForIdentity(params: {
  userAgent: EnboxUserAgent;
  connectedDid: string;
  delegateDid?: string;
  identitySyncProtocols?: IdentitySyncProtocols;
}): Promise<void> {
  const { userAgent, connectedDid, delegateDid, identitySyncProtocols } = params;

  if (delegateDid !== undefined) {
    await registerDelegateSyncScope(userAgent, connectedDid, delegateDid);
    return;
  }

  if (identitySyncProtocols === undefined) {
    return;
  }

  await registerOrUpdateIdentitySync(userAgent, connectedDid, { protocols: identitySyncProtocols });
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
}): Promise<'all' | string[]> {
  const { agent, connectedDid, delegateDid, grants } = params;

  // Two-phase write strategy:
  //
  // Phase 1 — delegate partition (rollbackable): write all grants into
  // the delegateDid's partition using the delegate's signing key. If any
  // write fails, delete the ones that succeeded and throw.
  //
  // Phase 2 — connected partition (not rollbackable): write grants into
  // the connectedDid's partition using processRawMessage (the delegate
  // agent doesn't hold the connectedDid's signing key, so it cannot
  // create a signed RecordsDelete to roll these back). Phase 2 only
  // runs after all phase-1 writes succeed, minimizing the orphan window.
  //
  // Both phases process grants concurrently with allSettled so a single
  // failure doesn't leave other writes racing against cleanup.

  // Prepare decoded grant data for both phases.
  const parsed = grants.map((grantMessage) => {
    const grant = DwnPermissionGrant.parse(grantMessage);
    const { encodedData, ...rawMessage } = grantMessage;
    return { grant, rawMessage, encodedData };
  });

  // ── Phase 1: delegate partition ───────────────────────────────────

  // Track which grants were actually created (202) vs already existed (409).
  // Only newly created grants should be rolled back on failure.
  const createdInPhase1 = new Set<number>();

  const delegateResults = await Promise.allSettled(parsed.map(async ({ rawMessage, encodedData }, index) => {
    const dataStream = new Blob([Convert.base64Url(encodedData).toUint8Array() as BlobPart]);
    const { reply } = await agent.processDwnRequest({
      store       : true,
      author      : delegateDid,
      target      : delegateDid,
      messageType : DwnInterface.RecordsWrite,
      signAsOwner : true,
      rawMessage,
      dataStream,
    });

    if (reply.status.code === 202) {
      createdInPhase1.add(index);
    } else if (reply.status.code !== 409) {
      throw new Error(
        `[@enbox/auth] Failed to store grant in delegate partition: ${reply.status.detail}`
      );
    }
  }));

  const delegateFailure = delegateResults.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  );
  if (delegateFailure) {
    // Roll back only the grants we actually created (202), not
    // pre-existing ones that returned 409.
    await Promise.allSettled(parsed.map(async ({ rawMessage }, i) => {
      if (createdInPhase1.has(i)) {
        try {
          await agent.processDwnRequest({
            author        : delegateDid,
            target        : delegateDid,
            messageType   : DwnInterface.RecordsDelete,
            messageParams : { recordId: rawMessage.recordId },
          });
        } catch { /* best-effort rollback */ }
      }
    }));
    throw delegateFailure.reason;
  }

  // ── Phase 2: connected partition ──────────────────────────────────

  const connectedResults = await Promise.allSettled(parsed.map(async ({ rawMessage, encodedData }) => {
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
  }));

  const connectedFailure = connectedResults.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  );
  if (connectedFailure) {
    // Connected-partition grants cannot be rolled back (the delegate
    // agent cannot sign RecordsDelete as connectedDid). The orphaned
    // records are harmless: the connect flow will throw, the imported
    // identity is cleaned up by importDelegateAndSetupSync(), and
    // without a registered sync identity the grants are never used.
    // Roll back only the delegate-partition grants we actually created.
    await Promise.allSettled(parsed.map(async ({ rawMessage }, i) => {
      if (!createdInPhase1.has(i)) { return; }
      try {
        await agent.processDwnRequest({
          author        : delegateDid,
          target        : delegateDid,
          messageType   : DwnInterface.RecordsDelete,
          messageParams : { recordId: rawMessage.recordId },
        });
      } catch { /* best-effort rollback */ }
    }));
    throw connectedFailure.reason;
  }

  // ── Derive sync scope from the processed grants ──────────────────

  return deriveSyncScopeFromGrants(parsed.map((p) => p.grant));
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
  flowName: string;
}): Promise<BearerIdentity> {
  const {
    userAgent, delegatePortableDid, connectedDid, delegateGrants, flowName,
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

    await processDelegateGrantsForExistingIdentity({
      userAgent,
      connectedDid,
      delegateDid: delegatePortableDid.uri,
      delegateGrants,
    });

    // No explicit sync('pull') here — startSyncIfEnabled() in the caller
    // runs an immediate sync cycle (both pull and push) when it starts.
    // Doing a manual pull first would double the startup burst and can
    // trigger rate limits on the remote DWN.

    // Delegate protocol keys / multi-party state / revocation map are
    // passed back to the caller explicitly via the return value so
    // `finalizeDelegateSession` can persist them. (The previous flow
    // smuggled them through `(identity as any)._foo`, which traded
    // type safety for one fewer return value.)
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

/**
 * Process a new grant bundle and repair sync for a delegate identity that is
 * already stored locally.
 *
 * Unlike {@link importDelegateAndSetupSync}, this helper never imports or
 * deletes identity/key material. A failed refresh must leave the active
 * delegate identity usable by its previous grants.
 *
 * @internal
 */
export async function processDelegateGrantsForExistingIdentity(params: {
  userAgent: EnboxUserAgent;
  connectedDid: string;
  delegateDid: string;
  delegateGrants: DwnDataEncodedRecordsWriteMessage[];
}): Promise<void> {
  const { userAgent, connectedDid, delegateDid, delegateGrants } = params;
  const connectedProtocols = await processConnectedGrants({
    agent: userAgent, connectedDid, delegateDid, grants: delegateGrants,
  });

  // Register (or update) the identity for protocol-scoped sync. If the
  // identity is already registered from a prior session, update its protocol
  // list so it matches the replacement grant bundle.
  const narrowedProtocols = toSyncIdentityProtocols(connectedProtocols);
  if (narrowedProtocols === undefined) {
    // Zero grants — remove any stale sync registration so revoked protocols stop syncing.
    await unregisterStaleIdentitySync(userAgent, connectedDid);
    return;
  }

  await registerOrUpdateIdentitySync(userAgent, connectedDid, { delegateDid, protocols: narrowedProtocols });
}

// ─── finalizeDelegateSession ────────────────────────────────────

/**
 * Transient state produced by a successful delegated connect flow that
 * `finalizeDelegateSession` persists into the SecretStore + storage
 * adapter. Passed explicitly through the call chain rather than
 * smuggled via private fields on `BearerIdentity`.
 *
 * @internal
 */
export type DelegateSessionState = {
  sessionRevocations?: { grantId: string; revocationGrantId: string }[];
};

/**
 * Build an `AuthSession` for a delegated connect flow (DWeb Connect or
 * relay WalletConnect). Optionally starts sync and persists delegate/connected
 * DID markers.
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
  delegateState?: DelegateSessionState;
  /** Whether to start sync as part of finalization. Defaults to `true`. */
  startSync?: boolean;
  /** Whether to emit `identity-added`. Defaults to `true`. */
  emitIdentityAdded?: boolean;
  /** Whether to emit `session-start`. Defaults to `true`. */
  emitSessionStart?: boolean;
}): Promise<AuthSession> {
  const {
    userAgent, emitter, storage, identity, connectedDid, delegateDid, sync,
    delegateState = {}, startSync = true, emitIdentityAdded = true, emitSessionStart = true,
  } = params;

  if (startSync) {
    await startSyncIfEnabled(userAgent, sync);
  }

  // Persist protocol path keys alongside the delegate session markers
  // so they survive agent restarts.  Delegate keys are stored in the
  // vault-backed SecretStore (encrypted at rest), while non-secret
  // session markers go into the plaintext StorageAdapter.
  const extraStorageKeys: Record<string, string> = {
    [STORAGE_KEYS.DELEGATE_DID]  : delegateDid,
    [STORAGE_KEYS.CONNECTED_DID] : connectedDid,
  };

  // Persist or clear delegate keys/revocations. Clearing stale values
  // from prior sessions prevents a reconnect with fewer capabilities
  // from retaining old decryption material.
  await persistOrClearDelegateSecrets(userAgent, storage, extraStorageKeys, delegateState);

  return finalizeSession({
    userAgent,
    emitter,
    storage,
    connectedDid,
    delegateDid,
    identityName         : identity.metadata.name,
    identityConnectedDid : identity.metadata.connectedDid,
    emitIdentityAdded,
    emitSessionStart,
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
 * @param params.emitSessionStart - Whether to emit `session-start`. Defaults to `true`.
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
  emitSessionStart?: boolean;
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
    emitSessionStart = true,
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
  // Build an AgentSessionIdentity with the agent DID as a fallback.
  const identityInfo: AgentSessionIdentity = {
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

  if (emitSessionStart) {
    emitter.emit('session-start', {
      session: { did: connectedDid, delegateDid, identity: identityInfo },
    });
  }

  return session;
}

// ─── persistOrClearDelegateSecrets ──────────────────────────────

/** @internal */
async function persistOrClearDelegateSecrets(
  userAgent: EnboxUserAgent,
  storage: StorageAdapter,
  extraStorageKeys: Record<string, string>,
  delegateState: DelegateSessionState,
): Promise<void> {
  const {
    sessionRevocations,
  } = delegateState;

  // Clear legacy key caches that are no longer populated by connect.
  const secretWrites: Promise<void>[] = [];
  secretWrites.push(
    userAgent.secrets.delete(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS).then(() => {}).catch(() => {}),
    storage.remove(STORAGE_KEYS.DELEGATE_CONTEXT_KEYS).catch(() => {}),
    storage.remove(STORAGE_KEYS.DELEGATE_MULTI_PARTY_PROTOCOLS).catch(() => {}),
  );
  await Promise.all(secretWrites);

  if (sessionRevocations?.length) {
    extraStorageKeys[STORAGE_KEYS.SESSION_REVOCATIONS] = JSON.stringify(sessionRevocations);
  } else {
    try { await storage.remove(STORAGE_KEYS.SESSION_REVOCATIONS); } catch { /* best-effort */ }
  }
}
