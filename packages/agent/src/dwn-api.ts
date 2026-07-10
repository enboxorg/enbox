import type { PublicKeyJwk } from '@enbox/crypto';
import type {
  DataEncodedRecordsWriteMessage,
  DwnConfig,
  EncryptionControlAudiencePayload,
  EncryptionKeyDeriver,
  EventLog,
  GenericMessage,
  MessageStore,
  ProgressToken,
  ProtocolActionRule,
  ProtocolDefinition,
  ProtocolRuleSet,
  RecordsWriteDescriptor,
  RecordsWriteMessage,
  ReplicationApplyResult,
  SourceRoleAudienceKeyEncryptionInput,
} from '@enbox/dwn-sdk-js';
import type { DwnSubscriptionHandler, ResubscribeFactory } from '@enbox/dwn-clients';

import {
  Cid,
  ContentEncryptionAlgorithm,
  DataStream,
  DurableEventLog,
  Dwn,
  DwnMethodName,
  Encoder,
  Encryption,
  ENCRYPTION_CONTROL_AUDIENCE_PATH,
  EncryptionControl,
  EncryptionControlDeliveryRecipientAuthority,
  EventEmitterWakePublisher,
  getRoleAudienceContextId,
  getRuleSetAtPath,
  isCrossProtocolRef,
  KeyAgreementAlgorithm,
  KeyDerivationScheme,
  Message,
  Protocols,
  RecordsWrite,
  ROLE_AUDIENCE_DERIVATION_SCHEME,
  Time,
} from '@enbox/dwn-sdk-js';
import { Convert, TtlCache } from '@enbox/common';
import { CryptoUtils, X25519 } from '@enbox/crypto';
import { DidDht, DidJwk, UniversalResolver } from '@enbox/dids';

import type { EnboxPlatformAgent } from './types/agent.js';
import type { LocalDwnStrategy } from './local-dwn.js';
import type { AudienceDecryptionKeyEntry, AudienceKeyPayload, DelegateDecryptionKeyEntry } from './dwn-encryption.js';
import type {
  AudienceKeyDeliveryOutcome,
  DwnMessage,
  DwnMessageInstance,
  DwnMessageParams,
  DwnMessageReply,
  DwnMessageWithData,
  DwnResponse,
  DwnSigner,
  MessageHandler,
  ProcessDwnRequest,
  SendDwnRequest,
} from './types/dwn.js';

import { AgentPermissionsApi } from './permissions-api.js';
import { DwnDiscoveryFile } from './dwn-discovery-file.js';
import { DEFAULT_LOCAL_DWN_STRATEGY, LocalDwnDiscovery } from './local-dwn.js';
import { DwnInterface, dwnMessageConstructors } from './types/dwn.js';
import { getDwnServiceEndpointUrls, isRecordsWrite } from './utils.js';

// Re-export DWN type guards from the agent API surface.
export { isDwnMessage, isDwnRequest, isMessagesPermissionScope, isRecordPermissionScope, isRecordsType } from './dwn-type-guards.js';

// Import type guards for internal use
import { isDwnRequest } from './dwn-type-guards.js';
import { processDwnRequestWithRemoteFallback as processDwnReadThrough } from './dwn-read-through.js';

// Import extracted encryption functions
import {
  buildEncryptionInput as buildEncryptionInputFn,
  createAudienceDeliveryRecord as createAudienceDeliveryRecordFn,
  createAudienceRecord as createAudienceRecordFn,
  encryptAndComputeCid as encryptAndComputeCidFn,
  generateAudienceKey as generateAudienceKeyFn,
  getAudienceDecryptionKeyCacheKey,
  getEncryptionKeyDeriver as getEncryptionKeyDeriverFn,
  hasAudienceSealCoverage as hasAudienceSealCoverageFn,
  ivLength as ivLengthFn,
  maybeDecryptReply as maybeDecryptReplyFn,
  resolveAudienceDecryptionKey as resolveAudienceDecryptionKeyFn,
} from './dwn-encryption.js';

// Import extracted protocol definition fetching functions
import {
  fetchRemoteProtocolDefinition as fetchRemoteProtocolDefinitionFn,
  getProtocolDefinition as getProtocolDefinitionFn,
} from './dwn-protocol-cache.js';

type DwnRpcData = Blob | ReadableStream<Uint8Array>;

type DwnMessageWithRpcData<T extends DwnInterface> = {
  message: DwnMessage[T];
  data?: DwnRpcData;
};

type PendingAudienceRecord = {
  audienceKey: AudienceKeyPayload;
  rolePath: string;
  sealingPublicKey: PublicKeyJwk;
};

type DwnApiParams = {
  agent?: EnboxPlatformAgent;
  localDwnStrategy?: LocalDwnStrategy;
} & (
  | { dwn: Dwn; localDwnEndpoint?: never }
  | { dwn?: never; localDwnEndpoint: string }
);

type MessageLog = {
  eventLog: EventLog;
  messageStore: MessageStore;
};

type DwnApiCreateDwnParams = Omit<Partial<DwnConfig>, 'eventLog' | 'messageStore'> & {
  dataPath?: string;

  /**
   * Inject a platform-specific message store together with its durable event log.
   * They are coupled because the event log reads the store's replication feed and must
   * share its wake publisher, so they are provided as a pair or omitted for defaults.
   */
  messageLog?: MessageLog;
};

/**
 * Validates a caller-supplied `recipientRolePublicKey`. A role-path key is a
 * hardened X25519 derivation of the recipient's own encryption root, so the
 * supplied value MUST be a well-formed AND usable X25519 OKP public key. Beyond
 * the shape (`kty: 'OKP'`, `crv: 'X25519'`, no private `d`, 32-byte `x`), two
 * further checks reject keys that pass the shape test but still can't deliver:
 *
 *   - The `x` must be the CANONICAL (unpadded) base64url of those 32 bytes. The
 *     recipient derives its role-path key id from the canonical encoding, so a
 *     padded or otherwise non-canonical `x` would key the delivery to a different
 *     id than the recipient looks up — reported `delivered: true`, undecryptable.
 *   - The point must not be low-order. An ephemeral ECDH against a low-order point
 *     (e.g. the all-zero key) fails key agreement, so the wrapped delivery key
 *     would be undecryptable/insecure.
 *
 * An Ed25519 (or any non-X25519) key would wrap through the X25519 ECDH without
 * error but produce a delivery the recipient cannot decrypt — so it is rejected,
 * not converted (converting the recipient's root would yield the wrong key, not
 * the role-path child). Throws with a clear message on any violation.
 */
async function assertX25519RolePublicKey(jwk: PublicKeyJwk): Promise<void> {
  const { kty, crv, x, d } = jwk as { kty?: string; crv?: string; x?: string; d?: string };
  if (kty !== 'OKP' || crv !== 'X25519') {
    throw new Error(
      `AgentDwnApi: recipientRolePublicKey must be an X25519 OKP public key (got kty='${kty}', ` +
      `crv='${crv}'). The role-path key is a hardened X25519 derivation of the recipient's ` +
      `encryption root and must not be an Ed25519 or otherwise non-X25519 key.`,
    );
  }
  if (d !== undefined) {
    throw new Error(
      'AgentDwnApi: recipientRolePublicKey must be a PUBLIC key, but a private key (\'d\') was provided.',
    );
  }
  let publicKeyBytes: Uint8Array | undefined;
  try {
    publicKeyBytes = Convert.base64Url(x ?? '').toUint8Array();
  } catch { /* reported as invalid below */ }
  if (publicKeyBytes?.length !== 32) {
    const detail = publicKeyBytes === undefined ? 'invalid base64url' : `${publicKeyBytes.length} bytes`;
    throw new Error(
      'AgentDwnApi: recipientRolePublicKey must have a 32-byte base64url \'x\' (X25519 public key); ' +
      `got ${detail}.`,
    );
  }
  if (Convert.uint8Array(publicKeyBytes).toBase64Url() !== x) {
    throw new Error(
      'AgentDwnApi: recipientRolePublicKey \'x\' is not canonical base64url; re-encode the 32-byte ' +
      'X25519 public key without padding so its key id matches what the recipient derives.',
    );
  }
  try {
    // A low-order point (e.g. the all-zero key) produces a degenerate shared secret;
    // the X25519 agreement rejects it here, so we never wrap a delivery to a key the
    // recipient cannot decrypt.
    const ephemeral = await X25519.generateKey();
    await X25519.sharedSecret({ privateKeyA: ephemeral, publicKeyB: jwk });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'AgentDwnApi: recipientRolePublicKey failed X25519 key agreement (e.g. a low-order point) and ' +
      `cannot wrap a delivery: ${detail}`,
    );
  }
}

export class AgentDwnApi {
  /**
   * Holds the instance of a `EnboxPlatformAgent` that represents the current execution context for
   * the `AgentDwnApi`. This agent is used to interact with other Enbox agent components. It's vital
   * to ensure this instance is set to correctly contextualize operations within the broader Enbox
   * Agent framework.
   */
  private _agent?: EnboxPlatformAgent;

  /**
   * The DWN instance to use for this API.
   * `undefined` in remote mode — all operations route through RPC to
   * the local DWN server endpoint.
   */
  private readonly _dwn?: Dwn;

  /**
   * The local DWN server endpoint for remote mode.
   * When set, `_dwn` is `undefined` and `processRequest()` routes
   * through `sendDwnRpcRequest()`.
   */
  private readonly _localDwnEndpoint?: string;

  /**
   * Protocol definition cache — TTL 30 minutes. Protocols rarely change.
   * Keyed by `${tenantDid}~${protocolUri}`.
   */
  private readonly _protocolDefinitionCache = new TtlCache<string, ProtocolDefinition>({
    ttl: 30 * 60 * 1000
  });

  /**
   * Delegate decryption key cache — stores scope-aware decryption keys
   * delivered to delegates during the connect flow. These keys enable
   * delegates to decrypt encrypted records without possessing the owner's
   * root X25519 private key.
   *
   * Keyed by `ddk~${delegateDid}`. Each entry is an array covering all
   * granted read scopes for that delegate session.
   * TTL 24 hours (keys are re-populated on session restore).
   */
  private readonly _delegateDecryptionKeyCache = new TtlCache<string, DelegateDecryptionKeyEntry[]>({
    ttl: 24 * 60 * 60 * 1000
  });

  /**
   * Role-audience private keys hydrated from durable audience seals or delivery records.
   * This is a memory-only session cache; the records remain the durable source of truth.
   */
  private readonly _audienceDecryptionKeyCache = new TtlCache<string, AudienceDecryptionKeyEntry>({
    ttl: 24 * 60 * 60 * 1000
  });

  /**
   * Cache of locally-managed DIDs (agent DID + identities). Used to decide
   * whether a target DID should be routed through the local DWN server.
   */
  private readonly _localManagedDidCache = new TtlCache<string, boolean>({
    ttl: 30 * 60 * 1000
  });

  /** Controls local DWN discovery behavior ('prefer' | 'only' | 'off'). */
  private _localDwnStrategy: LocalDwnStrategy;

  /** Lazy-initialized local DWN discovery instance. */
  private _localDwnDiscovery?: LocalDwnDiscovery;

  constructor(params: DwnApiParams) {
    const { agent, localDwnStrategy = DEFAULT_LOCAL_DWN_STRATEGY } = params;

    // If an agent is provided, set it as the execution context for this API.
    this._agent = agent;

    // Set the DWN instance (undefined in remote mode).
    this._dwn = 'dwn' in params ? params.dwn : undefined;

    // Set the remote endpoint (undefined in local mode).
    this._localDwnEndpoint = 'localDwnEndpoint' in params ? params.localDwnEndpoint : undefined;

    // Set the local DWN discovery strategy.
    this._localDwnStrategy = localDwnStrategy;

    // If agent is already available, eagerly initialize the discovery instance.
    if (agent) {
      this._localDwnDiscovery = new LocalDwnDiscovery(
        agent.rpc,
        10_000,
        AgentDwnApi._tryCreateDiscoveryFile(),
      );
    }
  }

  /**
   * Whether the API is operating in remote mode (no in-process DWN).
   * In remote mode, all DWN operations are routed through RPC.
   */
  get isRemoteMode(): boolean {
    return this._dwn === undefined;
  }

  /** The fixed local-side DWN endpoint used when this API operates in remote mode. */
  get localDwnEndpoint(): string | undefined {
    return this._localDwnEndpoint;
  }

  /**
   * Retrieves the `EnboxPlatformAgent` execution context.
   *
   * @returns The `EnboxPlatformAgent` instance that represents the current execution context.
   * @throws Will throw an error if the `agent` instance property is undefined.
   */
  get agent(): EnboxPlatformAgent {
    if (this._agent === undefined) {
      throw new Error('AgentDwnApi: Unable to determine agent execution context.');
    }

    return this._agent;
  }

  set agent(agent: EnboxPlatformAgent) {
    this._agent = agent;
    // Re-initialize local DWN discovery with the new agent's RPC client.
    this._localDwnDiscovery = new LocalDwnDiscovery(
      agent.rpc,
      10_000,
      AgentDwnApi._tryCreateDiscoveryFile(),
    );
    this._localManagedDidCache.clear();
  }

  get localDwnStrategy(): LocalDwnStrategy {
    return this._localDwnStrategy;
  }

  public setLocalDwnStrategy(strategy: LocalDwnStrategy): void {
    this._localDwnStrategy = strategy;
  }

  /**
   * Inject a cached local DWN endpoint from a validated discovery channel.
   * The endpoint is validated via `GET /info` before being accepted.
   *
   * @param endpoint - The local DWN server base URL.
   * @returns `true` if the endpoint was validated and cached, `false` otherwise.
   * @see https://github.com/enboxorg/enbox/issues/589
   */
  public async setCachedLocalDwnEndpoint(endpoint: string): Promise<boolean> {
    this._localDwnDiscovery ??= new LocalDwnDiscovery(
      this.agent.rpc,
      10_000,
      AgentDwnApi._tryCreateDiscoveryFile(),
    );
    return this._localDwnDiscovery.setCachedEndpoint(endpoint);
  }

  /**
   * Resolves the DWN service endpoint URLs for the given target DID, optionally
   * prepending a local DWN server endpoint when local discovery is enabled and
   * the target is a locally-managed DID.
   *
   * @param targetDid - The DID whose DWN endpoints should be resolved.
   * @returns An array of endpoint URLs.
   * @throws When strategy is `'only'` and no local server is available.
   */
  public async getDwnEndpointUrlsForTarget(targetDid: string): Promise<string[]> {
    const shouldUseLocalDwn = await this.shouldUseLocalDwnForTarget(targetDid);

    if (!shouldUseLocalDwn) {
      return getDwnServiceEndpointUrls(targetDid, this.agent.did);
    }

    const localDwnEndpoint = await this.getLocalDwnEndpoint();
    if (this._localDwnStrategy === 'only') {
      if (!localDwnEndpoint) {
        throw new Error(
          `AgentDwnApi: Local DWN strategy is 'only' but no local DWN endpoint was discovered. ` +
          `Ensure the local DWN server is running and discoverable via the discovery file (~/.enbox/dwn.json) or a browser pairing.`
        );
      }

      return [localDwnEndpoint];
    }

    let dwnEndpointUrls: string[] = [];
    try {
      dwnEndpointUrls = await getDwnServiceEndpointUrls(targetDid, this.agent.did);
    } catch (error) {
      if (!localDwnEndpoint) {
        throw error;
      }
    }

    if (!localDwnEndpoint) {
      return dwnEndpointUrls;
    }

    const uniqueEndpoints = new Set<string>([
      localDwnEndpoint,
      ...dwnEndpointUrls,
    ]);

    return [...uniqueEndpoints];
  }

  /**
   * Returns only the DWN service endpoints from the DID document (no local
   * discovery endpoint). Use this when you need to confirm that a message
   * reached the owner's actual remote DWN, not just the delegate's local server.
   */
  public async getRemoteDwnEndpointUrls(targetDid: string): Promise<string[]> {
    return getDwnServiceEndpointUrls(targetDid, this.agent.did);
  }

  /** Lazily retrieves the local DWN server endpoint via discovery. */
  private async getLocalDwnEndpoint(): Promise<string | undefined> {
    // In remote mode, the endpoint is always known.
    if (this._localDwnEndpoint) {
      return this._localDwnEndpoint;
    }

    this._localDwnDiscovery ??= new LocalDwnDiscovery(
      this.agent.rpc,
      10_000,
      AgentDwnApi._tryCreateDiscoveryFile(),
    );
    return this._localDwnDiscovery.getEndpoint();
  }

  /**
   * Attempt to create a {@link DwnDiscoveryFile} for file-based local DWN
   * discovery. Returns `undefined` in environments where the filesystem
   * is not available (e.g. browsers).
   */
  private static _tryCreateDiscoveryFile(): DwnDiscoveryFile | undefined {
    try {
      return new DwnDiscoveryFile();
    } catch {
      // Browser environment — node:fs/promises not available.
      return undefined;
    }
  }

  /**
   * Determines whether the given target DID should be routed through the
   * local DWN server. Returns `true` if the DID is the agent DID or one
   * of the locally-managed identity DIDs.
   */
  private async shouldUseLocalDwnForTarget(targetDid: string): Promise<boolean> {
    if (this._localDwnStrategy === 'off') {
      return false;
    }

    const cached = this._localManagedDidCache.get(targetDid);
    if (cached !== undefined) {
      return cached;
    }

    if (targetDid === this.agent.agentDid.uri) {
      this._localManagedDidCache.set(targetDid, true);
      return true;
    }

    const identities = await this.agent.identity.list();
    const localManagedDids = new Set<string>();

    for (const identity of identities) {
      localManagedDids.add(identity.did.uri);
      if (identity.metadata.connectedDid) {
        localManagedDids.add(identity.metadata.connectedDid);
      }
    }

    for (const localDid of localManagedDids) {
      this._localManagedDidCache.set(localDid, true);
    }

    const isLocalManaged = localManagedDids.has(targetDid);
    if (!isLocalManaged) {
      this._localManagedDidCache.set(targetDid, false);
    }

    return isLocalManaged;
  }

  /**
   * Public getter for the DWN instance used by this API.
   *
   * Notes:
   * - This getter is public to allow advanced developers to access the DWN instance directly.
   *   However, it is recommended to use the `processRequest` method to interact with the DWN
   *   instance to ensure that the DWN message is constructed correctly.
   * - The getter is named `node` to avoid confusion with the `dwn` property of the
   *   `EnboxPlatformAgent`. In other words, so that a developer can call `agent.dwn.node` to access
   *   the DWN instance and not `agent.dwn.dwn`.
   */
  /**
   * Closes the in-process DWN's stores (message store, data store, event log,
   * resumable task store), releasing their LevelDB handles. No-op when the
   * agent operates in remote mode (no in-process DWN).
   */
  public async close(): Promise<void> {
    if (this._dwn !== undefined) {
      await this._dwn.close();
    }
  }

  get node(): Dwn {
    if (!this._dwn) {
      throw new Error(
        'AgentDwnApi: The in-process DWN instance is not available. ' +
        'The agent is operating in remote mode (local DWN server at ' +
        `'${this._localDwnEndpoint}'). Use processRequest() instead ` +
        'of accessing the DWN node directly.'
      );
    }
    return this._dwn;
  }

  public static async createDwn({
    dataPath, dataStore, didResolver, messageLog, tenantGate, resumableTaskStore
  }: DwnApiCreateDwnParams): Promise<Dwn> {
    if (dataStore === undefined) {
      const { DataStoreLevel } = await import('@enbox/dwn-sdk-js/stores/level');
      dataStore = new DataStoreLevel({ blockstoreLocation: `${dataPath}/DWN_DATASTORE` });
    }

    if (didResolver === undefined) {
      const { DidResolverCacheLevel } = await import('@enbox/dids/resolver-cache-level');
      didResolver = new UniversalResolver({
        didResolvers : [DidDht, DidJwk],
        cache        : new DidResolverCacheLevel({ location: `${dataPath}/DID_RESOLVERCACHE` }),
      });
    }

    if (resumableTaskStore === undefined) {
      const { ResumableTaskStoreLevel } = await import('@enbox/dwn-sdk-js/stores/level');
      resumableTaskStore = new ResumableTaskStoreLevel({ location: `${dataPath}/DWN_RESUMABLETASKSTORE` });
    }

    const { eventLog, messageStore } = messageLog ?? await AgentDwnApi.createDefaultMessageLog(dataPath);

    return await Dwn.create({ dataStore, didResolver, eventLog, messageStore, tenantGate, resumableTaskStore });
  }

  private static async createDefaultMessageLog(dataPath?: string): Promise<MessageLog> {
    const { MessageStoreLevel } = await import('@enbox/dwn-sdk-js/stores/level');
    const wakePublisher = new EventEmitterWakePublisher();
    const messageStore = new MessageStoreLevel({
      location: `${dataPath}/DWN_MESSAGESTORE`,
      wakePublisher,
    });

    return { eventLog: new DurableEventLog(messageStore, wakePublisher), messageStore };
  }

  public async processRequest<T extends DwnInterface>(
    request: ProcessDwnRequest<T>
  ): Promise<DwnResponse<T>> {
    await this.assertRecipientRolePublicKeyUsable(request);

    // Constructs a DWN message. and if there is a data payload, prepares the data as a
    // Web ReadableStream.
    const { message, dataStream } =
      await this.constructDwnMessage({ request });

    // Extracts the optional subscription handler from the request to pass into `processMessage.
    const { subscriptionHandler } = request;

    // Conditionally processes the message with the DWN instance:
    // - If `store` is not explicitly set to false, it sends the message to the DWN node for
    //   processing, passing along the target DID, the message, and any associated data stream.
    // - If `store` is set to false, it immediately returns a simulated 'accepted' status without
    //   storing the message/data in the DWN node.
    let reply: DwnMessageReply[T];

    if (request.store === false) {
      reply = { status: { code: 202, detail: 'Accepted' } };
    } else if (this._dwn) {
      // Local mode: process directly with the in-process DWN.
      reply = await this._dwn.processMessage(
        request.target, message,
        { dataStream: dataStream as any, subscriptionHandler },
      );
    } else {
      // Remote mode: route through RPC to the local DWN server.
      reply = await this.sendDwnRpcRequest({
        targetDid       : request.target,
        dwnEndpointUrls : [this._localDwnEndpoint!],
        message,
        data            : dataStream,
        subscriptionHandler,
      });
    }

    const audienceKeyDelivery = await this.provisionAudienceKeyDeliveryForReply(request, message, reply);

    await this.maybeDecryptReply(request, reply);

    // Returns an object containing the reply from processing the message, the original message,
    // and the content identifier (CID) of the message.
    return {
      reply,
      message,
      messageCid: await Message.getCid(message),
      ...(audienceKeyDelivery ? { audienceKeyDelivery } : {}),
    };
  }

  /**
   * Guards use of `recipientRolePublicKey`, which only drives role-audience key
   * delivery provisioning for an accepted, stored, non-raw RecordsWrite to a
   * `$role` path with a `recipient`. Runs BEFORE the record is written so caller
   * MISUSE fails fast without leaving state behind. Rejects:
   *   - a non-RecordsWrite, a raw/replayed message, or `store: false` (nothing is
   *     persisted to deliver against), so a supplied key is never silently ignored;
   *   - a malformed/unusable key (see {@link assertX25519RolePublicKey}); and
   *   - a target path that is not a `$role` with a `$keyAgreement` audience and a
   *     `recipient` (see {@link assertRoleRecipientPathDeliverable}), which could
   *     never provision a delivery to wrap the key to.
   *
   * It does NOT reject a grant-authorized write. A supplied key drives BEST-EFFORT
   * delivery whose outcome is reported on `DwnResponse.audienceKeyDelivery`; it never
   * makes the SDK throw a delivery failure or roll the `$role` record back, so no
   * delete authorization (which a write-scoped grant lacks) is ever required. A caller
   * that needs delivery to be fatal inspects the reported outcome and compensates with
   * the authority it holds (e.g. its own delete grant). This is the primary path for
   * the dashboard delegate, which authors every write via a `delegatedGrant`.
   */
  private async assertRecipientRolePublicKeyUsable<T extends DwnInterface>(request: ProcessDwnRequest<T>): Promise<void> {
    if (request.recipientRolePublicKey === undefined) {
      return;
    }
    if (!isDwnRequest(request, DwnInterface.RecordsWrite) ||
        request.rawMessage !== undefined ||
        request.store === false) {
      throw new Error(
        'AgentDwnApi: recipientRolePublicKey is only supported when writing (and storing) a $role ' +
        'record via processRequest (a non-raw, stored RecordsWrite); it is not honored for other ' +
        'message types, raw messages, or store:false, so it must not be supplied there.',
      );
    }
    await assertX25519RolePublicKey(request.recipientRolePublicKey);
    await this.assertRoleRecipientPathDeliverable(request);
  }

  /**
   * Confirms — before the write — that a `recipientRolePublicKey`-bearing request
   * actually targets a deliverable role audience. A supplied key asserts delivery
   * MUST happen, so a path that cannot provision one is a caller error caught up
   * front rather than an accepted write whose delivery is silently skipped. Shares
   * {@link resolveDeliverableRoleAudience} with post-write provisioning so the
   * strict guard and the best-effort skip can never drift.
   */
  private async assertRoleRecipientPathDeliverable(
    request: ProcessDwnRequest<DwnInterface.RecordsWrite>,
  ): Promise<void> {
    const { protocol, protocolPath, recipient } = request.messageParams ?? {};
    const resolved = await this.resolveDeliverableRoleAudience({
      target: request.target, protocol, protocolPath, recipient, granteeDid: request.granteeDid,
    });
    if (!resolved.deliverable) {
      throw new Error(
        `AgentDwnApi: recipientRolePublicKey was supplied but ${resolved.reason}, so its role-audience ` +
        'delivery cannot be provisioned.',
      );
    }
  }

  /**
   * Resolves whether `protocolPath` on `protocol` (as installed at `target`) is a
   * deliverable role audience for a grant to `recipient`: the write must name all
   * three, the protocol must resolve, the path must be a `$role` rule, and that
   * rule must carry a `$keyAgreement` audience to wrap the delivery to. Returns the
   * (now-defined) identifiers when deliverable, or a human-readable reason it is
   * not. The pre-write strict guard throws the reason; post-write provisioning
   * skips on it — one ladder, so the two never disagree.
   */
  private async resolveDeliverableRoleAudience(params: {
    target: string;
    protocol?: string;
    protocolPath?: string;
    recipient?: string;
    granteeDid?: string;
  }): Promise<
    | { deliverable: true; protocol: string; protocolPath: string; recipient: string }
    | { deliverable: false; reason: string }
  > {
    const { target, protocol, protocolPath, recipient, granteeDid } = params;
    if (protocol === undefined || protocolPath === undefined || recipient === undefined) {
      return { deliverable: false, reason: 'the write must set protocol, protocolPath, and recipient (a $role grant to a specific recipient)' };
    }
    const protocolDefinition = await this.getProtocolDefinition(target, protocol, granteeDid);
    if (protocolDefinition === undefined) {
      return { deliverable: false, reason: `protocol '${protocol}' is not installed on target '${target}'` };
    }
    const ruleSet = getRuleSetAtPath(protocolPath, protocolDefinition.structure);
    if (ruleSet?.$role !== true) {
      return { deliverable: false, reason: `'${protocol}/${protocolPath}' is not a $role path` };
    }
    if (ruleSet.$keyAgreement?.publicKeyJwk === undefined) {
      return { deliverable: false, reason: `'${protocol}/${protocolPath}' has no $keyAgreement audience` };
    }
    return { deliverable: true, protocol, protocolPath, recipient };
  }

  /**
   * Provisions role-audience key delivery for a RecordsWrite reply and reports the
   * outcome — always BEST-EFFORT.
   *
   * Runs ONLY on a fresh 202 accept of a stored, non-raw RecordsWrite. A 409 means
   * the identical record already existed — it was provisioned when first accepted,
   * and `createAudienceDeliveryRecord` mints a fresh DEK/IV per call, so re-running
   * on 409 would pile up duplicate delivery records; 409 is therefore skipped.
   * `store: false` persists nothing to deliver against and is excluded too.
   * `!rawMessage` keeps this off the sync/replay path.
   *
   * The `$role` write is already accepted and valid, so a delivery that cannot be
   * provisioned is surfaced on `DwnResponse.audienceKeyDelivery` as
   * `{ delivered: false, reason }` for the caller to act on — never by throwing or
   * unwinding the write. That holds whether or not a `recipientRolePublicKey` was
   * supplied: the supplied key only chooses which key the delivery is wrapped to
   * (the caller's, skipping recipient DID resolution), not whether a failure is
   * fatal. A non-role write (nothing to deliver) yields `undefined`; a supplied key
   * always yields an outcome (delivered, or a reported failure) so the caller can
   * enforce its own delivery policy with the authority it holds.
   */
  private async provisionAudienceKeyDeliveryForReply<T extends DwnInterface>(
    request: ProcessDwnRequest<T>,
    message: DwnMessage[T],
    reply: DwnMessageReply[T],
  ): Promise<AudienceKeyDeliveryOutcome | undefined> {
    if (reply.status.code !== 202 || request.rawMessage !== undefined || request.store === false) {
      return undefined;
    }
    if (!isDwnRequest(request, DwnInterface.RecordsWrite)) {
      return undefined;
    }

    const recordsWrite = message as RecordsWriteMessage;
    try {
      const outcome = await this.provisionAudienceKeyForAcceptedRoleRecord(request, recordsWrite);
      if (outcome !== undefined) {
        return outcome;
      }
      // A non-role (non-deliverable) write has nothing to deliver — no outcome. But a
      // supplied key targeted a specific recipient and the preflight proved the path
      // deliverable, so a skip here is an unexpected race (e.g. a concurrent protocol
      // reconfigure). Report it as a failure rather than dropping it silently.
      if (request.recipientRolePublicKey !== undefined) {
        return {
          delivered    : false,
          recipientDid : recordsWrite.descriptor.recipient ?? '',
          reason       : 'role-audience delivery was skipped for the supplied recipient key ' +
            '(the path is no longer a deliverable role audience)',
        };
      }
      return undefined;
    } catch (error) {
      // Delivery is best-effort. A recipient whose delivery cannot be provisioned — a
      // DWN-less `did:jwk` with no supplied key, or a supplied key that fails to wrap —
      // is reported here; the already-accepted `$role` write is never unwound. A caller
      // that treats delivery as required inspects this outcome and compensates with the
      // authority it holds (e.g. deleting the record with its own delete grant).
      const detail = error instanceof Error ? error.message : String(error);
      return {
        delivered    : false,
        recipientDid : recordsWrite.descriptor.recipient ?? '',
        reason       : detail,
      };
    }
  }

  /**
   * Process a pre-constructed DWN message against the local DWN (in-process
   * or remote server). Used by the sync engine to store messages that were
   * already fetched from a remote DWN.
   *
   * Unlike {@link processRequest}, this method does NOT construct a new
   * message — it takes an already-signed `GenericMessage` and routes it
   * to the appropriate backend.
   *
   * @param tenant - The DID of the DWN tenant (target).
   * @param message - The pre-constructed DWN message.
   * @param options - Optional data stream and subscription handler.
   * @returns The reply from processing the message.
   */
  public async processRawMessage(
    tenant: string,
    message: GenericMessage,
    options?: { dataStream?: ReadableStream<Uint8Array> },
  ): Promise<{ status: { code: number; detail: string } }> {
    if (this._dwn) {
      return this._dwn.processMessage(tenant, message, { dataStream: options?.dataStream });
    }

    return this.sendDwnRpcRequest({
      targetDid       : tenant,
      dwnEndpointUrls : [this._localDwnEndpoint!],
      message         : message as DwnMessage[DwnInterface],
      data            : options?.dataStream,
    });
  }

  /**
   * Applies a replicated message to the local DWN and returns a structured sync
   * outcome. In-process DWNs call the native entry point directly. Local DWN
   * server mode calls the server's matching replication RPC so duplicate replay
   * and replication-index repair stay server-side instead of falling back to the
   * normal authoring path.
   */
  public async applyReplicatedMessage(
    tenant: string,
    message: GenericMessage,
    options?: { dataStream?: ReadableStream<Uint8Array> },
  ): Promise<ReplicationApplyResult> {
    if (this._dwn) {
      return this._dwn.applyReplicatedMessage(tenant, message, options);
    }

    return this.agent.rpc.applyReplicatedMessage({
      targetDid : tenant,
      dwnUrl    : this._localDwnEndpoint!,
      message,
      data      : options?.dataStream,
    });
  }

  public async sendRequest<T extends DwnInterface>(
    request: SendDwnRequest<T>
  ): Promise<DwnResponse<T>> {
    // Role-audience key delivery is provisioned on the owner's LOCAL DWN during
    // processRequest; sendRequest dispatches to a remote target and never provisions.
    // Reject a supplied key here so it can't be silently ignored on a path that would
    // never wrap a delivery to it.
    if ('recipientRolePublicKey' in request && request.recipientRolePublicKey !== undefined) {
      throw new Error(
        'AgentDwnApi: recipientRolePublicKey is not supported on sendRequest. Role-audience key ' +
        'delivery is provisioned on the owner\'s local DWN via processRequest; supply it there.',
      );
    }

    // Resolve DWN service endpoint URLs, with local DWN discovery if enabled.
    const dwnEndpointUrls = await this.getDwnEndpointUrlsForTarget(request.target);
    if (dwnEndpointUrls.length === 0) {
      throw new Error(`AgentDwnApi: DID Service is missing or malformed: ${request.target}#dwn`);
    }

    let messageCid: string | undefined;
    let message: DwnMessage[T];
    let data: DwnRpcData | undefined;
    let subscriptionHandler: MessageHandler[T] | undefined;

    // If `messageCid` is given, retrieve message and data, if any.
    if ('messageCid' in request) {
      ({ message, data } = await this.getDwnMessage({
        author      : request.author,
        messageCid  : request.messageCid,
        messageType : request.messageType
      }));
      messageCid = request.messageCid;

    } else {
      // Otherwise, construct a new message.
      ({ message, dataStream: data } = await this.constructDwnMessage({ request }));
      subscriptionHandler = request.subscriptionHandler;
    }

    // Build a resubscribe factory for subscribe requests. This closure
    // captures the original request so it can reconstruct and re-sign a new
    // subscribe message with a cursor on reconnection.
    let resubscribeFactory: ResubscribeFactory | undefined;
    if (subscriptionHandler !== undefined && !('messageCid' in request)) {
      resubscribeFactory = async (cursor?: ProgressToken): Promise<GenericMessage> => {
        const resumeParams = cursor === undefined
          ? request.messageParams
          : { ...request.messageParams, cursor } as DwnMessageParams[T];

        const resumeRequest: ProcessDwnRequest<T> = { ...request, messageParams: resumeParams };
        const { message: resumeMessage } = await this.constructDwnMessage({ request: resumeRequest });
        return resumeMessage;
      };
    }

    // Send the RPC request to the target DID's DWN service endpoint using the Agent's RPC client.
    const reply = await this.sendDwnRpcRequest({
      targetDid: request.target,
      dwnEndpointUrls,
      message,
      data,
      subscriptionHandler,
      resubscribeFactory,
    });

    // Auto-decrypt reply data if encryption is enabled (Component 7)
    await this.maybeDecryptReply(request, reply);

    // If the message CID was not given in the `request`, compute it.
    messageCid ??= await Message.getCid(message);

    // Returns an object containing the reply from processing the message, the original message,
    // and the content identifier (CID) of the message.
    return { reply, message, messageCid };
  }

  private async sendDwnRpcRequest<T extends DwnInterface>({
    targetDid, dwnEndpointUrls, message, data, subscriptionHandler, resubscribeFactory
  }: {
      targetDid: string;
      dwnEndpointUrls: string[];
      message: DwnMessage[T];
      data?: DwnRpcData;
      subscriptionHandler?: MessageHandler[T];
      resubscribeFactory?: ResubscribeFactory;
    }
  ): Promise<DwnMessageReply[T]> {
    const errorMessages: { url: string, message: string }[] = [];

    if (message.descriptor.method === DwnMethodName.Subscribe && subscriptionHandler === undefined) {
      throw new Error('AgentDwnApi: Subscription handler is required for subscription requests.');
    }

    // Try sending to author's publicly addressable DWNs until the first request succeeds.
    for (let dwnUrl of dwnEndpointUrls) {
      try {
        if (subscriptionHandler !== undefined) {
          // we get the server info to check if the server supports WebSocket for subscription requests
          const serverInfo = await this.agent.rpc.getServerInfo(dwnUrl);
          if (!serverInfo.webSocketSupport) {
            // If the server does not support WebSocket, add an error message and continue to the next URL.
            errorMessages.push({
              url     : dwnUrl,
              message : 'WebSocket support is not enabled on the server.'
            });
            continue;
          }

          // If the server supports WebSocket, replace the subscription URL with a socket transport.
          // For `http` we use the unsecured `ws` protocol, and for `https` we use the secured `wss` protocol.
          const parsedUrl = new URL(dwnUrl);
          parsedUrl.protocol = parsedUrl.protocol === 'http:' ? 'ws:' : 'wss:';
          dwnUrl = parsedUrl.toString();
        }

        const dwnReply = await this.agent.rpc.sendDwnRequest({
          dwnUrl,
          targetDid,
          message,
          data,
          subscription: subscriptionHandler ? {
            handler: subscriptionHandler as DwnSubscriptionHandler,
            resubscribeFactory,
          } : undefined,
        });

        return dwnReply;
      } catch (error: any) {
        errorMessages.push({
          url     : dwnUrl,
          message : (error instanceof Error) ? error.message : 'Unknown error',
        });
      }
    }

    throw new Error(`Failed to send DWN RPC request: ${JSON.stringify(errorMessages)}`);
  }

  /**
   * Provisions role-audience key delivery for an accepted `$role` record write.
   *
   * Returns `undefined` when the record is not a deliverable role audience (via the
   * shared {@link resolveDeliverableRoleAudience} check — nothing to deliver), or an
   * {@link AudienceKeyDeliveryOutcome} with `delivered: true` on success. It throws
   * if delivery cannot be provisioned; the caller
   * ({@link provisionAudienceKeyDeliveryForReply}) turns that into a best-effort
   * `{ delivered: false, reason }` outcome and never unwinds the accepted write.
   */
  private async provisionAudienceKeyForAcceptedRoleRecord(
    request: ProcessDwnRequest<DwnInterface.RecordsWrite>,
    recordsWrite: RecordsWriteMessage,
  ): Promise<AudienceKeyDeliveryOutcome | undefined> {
    const descriptor = recordsWrite.descriptor;
    const resolved = await this.resolveDeliverableRoleAudience({
      target       : request.target,
      protocol     : descriptor.protocol,
      protocolPath : descriptor.protocolPath,
      recipient    : descriptor.recipient,
      granteeDid   : request.granteeDid,
    });
    if (!resolved.deliverable) {
      return;
    }
    const { protocol, protocolPath, recipient } = resolved;

    const contextId = getRoleAudienceContextId(protocolPath, recordsWrite.contextId);
    if (contextId === undefined) {
      throw new Error(`AgentDwnApi: Unable to determine role audience context for '${protocolPath}'.`);
    }

    const audienceKey = await this.getOrCreateAudienceKey({
      authorDid         : request.author,
      contextId,
      delegatedGrant    : request.messageParams?.delegatedGrant,
      granteeDid        : request.granteeDid,
      permissionGrantId : request.messageParams?.permissionGrantId,
      protocol,
      protocolRole      : request.messageParams?.protocolRole,
      rolePath          : protocolPath,
      sourceDid         : request.target,
    });
    // Prefer a caller-supplied recipient role-path key. Endpoint-less recipients
    // (e.g. a bare `did:jwk` in "remote-only" mode) publish no DWN to resolve, so
    // the caller — which learned the key out of band (e.g. from the recipient's
    // enrollment request) — supplies it here. Otherwise resolve it from the
    // recipient's installed protocol definition.
    const recipientRolePublicKey = request.recipientRolePublicKey
      ?? await this.getRecipientRolePublicKey({
        protocol,
        recipientDid : recipient,
        rolePath     : protocolPath,
      });

    await createAudienceDeliveryRecordFn({
      agent              : this.agent,
      audienceKey,
      authorDid          : request.author,
      delegatedGrant     : request.messageParams?.delegatedGrant,
      granteeDid         : request.granteeDid,
      permissionGrantId  : request.messageParams?.permissionGrantId,
      protocolRole       : request.messageParams?.protocolRole,
      recipientAuthority : EncryptionControlDeliveryRecipientAuthority.RoleHolder,
      recipientDid       : recipient,
      recipientRolePublicKey,
      sourceDid          : request.target,
    });

    return { delivered: true, recipientDid: recipient };
  }

  private async getRoleAudienceKeyEncryptionInputs(params: {
    authorDid: string;
    granteeDid?: string;
    permissionGrantId?: string;
    delegatedGrant?: DataEncodedRecordsWriteMessage;
    sourceDid: string;
    protocol: string;
    sourceProtocolPath: string;
    parentContextId?: string;
    protocolRole?: string;
    protocolDefinition: ProtocolDefinition;
    sourceRuleSet: ProtocolRuleSet;
  }): Promise<{ inputs: SourceRoleAudienceKeyEncryptionInput[]; pendingAudienceRecords: PendingAudienceRecord[] }> {
    const inputs: SourceRoleAudienceKeyEncryptionInput[] = [];
    const pendingAudienceRecords: PendingAudienceRecord[] = [];
    const readRules = params.sourceRuleSet.$actions?.filter((rule: ProtocolActionRule): boolean =>
      rule.role !== undefined && rule.can?.includes('read')
    ) ?? [];

    for (const rule of readRules) {
      const roleAudience = this.resolveRoleAudienceRule(rule.role!, params.protocolDefinition, params.parentContextId);
      const pendingRoleAudience = roleAudience === undefined &&
        this.canPreparePendingAudienceRecord(rule.role!, params.parentContextId)
        ? await this.preparePendingAudienceRecord(rule.role!, params.protocolDefinition)
        : undefined;
      if (roleAudience === undefined && pendingRoleAudience === undefined) {
        throw new Error(
          `AgentDwnApi: Unable to resolve encrypted role audience '${rule.role}' ` +
          `for '${params.protocol}/${params.sourceProtocolPath}'.`
        );
      }

      const audienceKey = roleAudience === undefined
        ? pendingRoleAudience!.audienceKey
        : await this.getOrCreateAudiencePublicKey({
          authorDid         : params.authorDid,
          contextId         : roleAudience.contextId,
          delegatedGrant    : params.delegatedGrant,
          granteeDid        : params.granteeDid,
          permissionGrantId : params.permissionGrantId,
          protocol          : roleAudience.protocol,
          protocolRole      : params.protocolRole,
          rolePath          : roleAudience.rolePath,
          sourceDid         : params.sourceDid,
        });
      if (pendingRoleAudience !== undefined) {
        pendingAudienceRecords.push(pendingRoleAudience);
      }
      const audiencePublicKey = 'publicKeyJwk' in audienceKey
        ? audienceKey.publicKeyJwk
        : audienceKey.keyMaterial.publicKeyJwk;

      inputs.push({
        algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
        derivationScheme : ROLE_AUDIENCE_DERIVATION_SCHEME,
        keyId            : audienceKey.keyId,
        protocol         : audienceKey.protocol,
        publicKey        : audiencePublicKey,
        rolePath         : audienceKey.rolePath,
      });
    }

    return { inputs, pendingAudienceRecords };
  }

  private canPreparePendingAudienceRecord(
    roleRef: string,
    parentContextId: string | undefined,
  ): boolean {
    if (isCrossProtocolRef(roleRef)) {
      return false;
    }

    const pendingContextId = parentContextId === undefined ? 'pending-record' : `${parentContextId}/pending-record`;
    return getRoleAudienceContextId(roleRef, pendingContextId) !== undefined;
  }

  private async preparePendingAudienceRecord(
    roleRef: string,
    protocolDefinition: ProtocolDefinition,
  ): Promise<PendingAudienceRecord | undefined> {
    if (isCrossProtocolRef(roleRef)) {
      return undefined;
    }

    const ruleSet = getRuleSetAtPath(roleRef, protocolDefinition.structure);
    const sealingPublicKey = ruleSet?.$keyAgreement?.publicKeyJwk as PublicKeyJwk | undefined;
    if (ruleSet?.$role !== true || sealingPublicKey === undefined) {
      return undefined;
    }

    return {
      audienceKey: await generateAudienceKeyFn({
        contextId : '',
        protocol  : protocolDefinition.protocol,
        rolePath  : roleRef,
      }),
      rolePath: roleRef,
      sealingPublicKey,
    };
  }

  private resolveRoleAudienceRule(
    roleRef: string,
    protocolDefinition: ProtocolDefinition,
    parentContextId: string | undefined,
  ): { protocol: string; rolePath: string; contextId: string } | undefined {
    if (isCrossProtocolRef(roleRef)) {
      return undefined;
    }

    const contextId = getRoleAudienceContextId(roleRef, parentContextId);
    return contextId === undefined ? undefined : { protocol: protocolDefinition.protocol, rolePath: roleRef, contextId };
  }

  private getRoleAudienceSourceContextId(params: {
    protocolPath: string;
    parentContextId?: string;
    recordId?: string;
  }): string | undefined {
    if (params.parentContextId !== undefined) {
      return params.parentContextId;
    }

    return params.protocolPath.includes('/') ? undefined : params.recordId;
  }

  private async getOrCreateAudiencePublicKey(params: {
    authorDid: string;
    sourceDid: string;
    protocol: string;
    contextId: string;
    rolePath: string;
    granteeDid?: string;
    permissionGrantId?: string;
    delegatedGrant?: DataEncodedRecordsWriteMessage;
    protocolRole?: string;
  }): Promise<{
    protocol: string;
    rolePath: string;
    contextId: string;
    keyId: string;
    publicKeyJwk: PublicKeyJwk;
  }> {
    const existingAudience = await this.resolveCurrentAudienceRecord({
      authorDid : params.granteeDid ?? params.authorDid,
      contextId : params.contextId,
      protocol  : params.protocol,
      rolePath  : params.rolePath,
      sourceDid : params.sourceDid,
    });
    if (existingAudience !== undefined) {
      return {
        contextId    : existingAudience.payload.contextId,
        keyId        : existingAudience.payload.keyId,
        protocol     : existingAudience.payload.protocol,
        publicKeyJwk : existingAudience.payload.publicKeyJwk,
        rolePath     : existingAudience.payload.rolePath,
      };
    }

    const audienceKey = await this.getOrCreateAudienceKey(params);
    return {
      contextId    : audienceKey.contextId,
      keyId        : audienceKey.keyId,
      protocol     : audienceKey.protocol,
      publicKeyJwk : audienceKey.keyMaterial.publicKeyJwk,
      rolePath     : audienceKey.rolePath,
    };
  }

  private async getOrCreateAudienceKey(params: {
    authorDid: string;
    sourceDid: string;
    protocol: string;
    contextId: string;
    rolePath: string;
    granteeDid?: string;
    permissionGrantId?: string;
    delegatedGrant?: DataEncodedRecordsWriteMessage;
    protocolRole?: string;
  }): Promise<AudienceKeyPayload> {
    const existingAudience = await this.resolveCurrentAudienceRecord({
      authorDid : params.granteeDid ?? params.authorDid,
      contextId : params.contextId,
      protocol  : params.protocol,
      rolePath  : params.rolePath,
      sourceDid : params.sourceDid,
    });
    if (existingAudience !== undefined) {
      const resolved = await resolveAudienceDecryptionKeyFn({
        agent                      : this.agent,
        audienceDecryptionKeyCache : this._audienceDecryptionKeyCache,
        delegateDecryptionKeyCache : this._delegateDecryptionKeyCache,
        contextId                  : existingAudience.payload.contextId,
        granteeDid                 : params.granteeDid,
        keyId                      : existingAudience.payload.keyId,
        protocol                   : existingAudience.payload.protocol,
        recipientDid               : params.authorDid,
        rolePath                   : existingAudience.payload.rolePath,
        sourceDid                  : params.sourceDid,
      });
      if (resolved === undefined) {
        throw new Error(
          `AgentDwnApi: Audience key '${existingAudience.payload.keyId}' exists, but no seal or delivery can open it.`
        );
      }
      return {
        contextId   : existingAudience.payload.contextId,
        keyId       : existingAudience.payload.keyId,
        keyMaterial : resolved.keyMaterial,
        protocol    : existingAudience.payload.protocol,
        rolePath    : existingAudience.payload.rolePath,
      };
    }

    const protocolDefinition = await this.getProtocolDefinition(params.sourceDid, params.protocol, params.granteeDid);
    if (protocolDefinition === undefined) {
      throw new Error(`AgentDwnApi: protocol '${params.protocol}' is not installed for '${params.sourceDid}'.`);
    }

    const ruleSet = getRuleSetAtPath(params.rolePath, protocolDefinition.structure);
    const sealingPublicKey = ruleSet?.$keyAgreement?.publicKeyJwk as PublicKeyJwk | undefined;
    if (ruleSet?.$role !== true || sealingPublicKey === undefined) {
      throw new Error(
        `AgentDwnApi: role '${params.rolePath}' is not an encrypted audience ` +
        `(requires $role with $keyAgreement) in protocol '${params.protocol}'.`,
      );
    }

    await this.assertAudienceSealCoverage({
      contextId  : params.contextId,
      granteeDid : params.granteeDid,
      protocol   : params.protocol,
      rolePath   : params.rolePath,
      sourceDid  : params.sourceDid,
    });

    const created = await createAudienceRecordFn({
      agent             : this.agent,
      authorDid         : params.authorDid,
      contextId         : params.contextId,
      delegatedGrant    : params.delegatedGrant,
      granteeDid        : params.granteeDid,
      permissionGrantId : params.permissionGrantId,
      protocol          : params.protocol,
      protocolRole      : params.protocolRole,
      rolePath          : params.rolePath,
      sealingPublicKey,
      sourceDid         : params.sourceDid,
    });
    this._audienceDecryptionKeyCache.set(getAudienceDecryptionKeyCacheKey({
      contextId    : params.contextId,
      keyId        : created.audienceKey.keyId,
      protocol     : params.protocol,
      recipientDid : params.authorDid,
      rolePath     : params.rolePath,
      sourceDid    : params.sourceDid,
    }), {
      contextId    : params.contextId,
      keyMaterial  : created.audienceKey.keyMaterial,
      protocol     : params.protocol,
      recipientDid : params.authorDid,
      rolePath     : params.rolePath,
      sourceDid    : params.sourceDid,
    });

    return created.audienceKey;
  }

  private async assertAudienceSealCoverage(params: {
    sourceDid: string;
    protocol: string;
    rolePath: string;
    contextId: string;
    granteeDid?: string;
  }): Promise<void> {
    const hasCoverage = await hasAudienceSealCoverageFn({
      agent                      : this.agent,
      delegateDecryptionKeyCache : this._delegateDecryptionKeyCache,
      granteeDid                 : params.granteeDid,
      protocol                   : params.protocol,
      rolePath                   : params.rolePath,
      sourceDid                  : params.sourceDid,
    });
    if (!hasCoverage) {
      throw new Error(
        `AgentDwnApi: Cannot mint role audience (${params.protocol}, ${params.rolePath}, ${params.contextId}) without seal coverage. ` +
        'Use the owner identity or a delegate with grantKey material covering the role path, or provision the audience with a seal-covered actor first.'
      );
    }
  }

  private async resolveCurrentAudienceRecord(params: {
    authorDid: string;
    sourceDid: string;
    protocol: string;
    contextId: string;
    rolePath: string;
  }): Promise<{ message: RecordsWriteMessage; payload: EncryptionControlAudiencePayload } | undefined> {
    if (this._dwn !== undefined) {
      const record = await EncryptionControl.resolveCurrentAudienceRecord({
        contextId    : params.contextId,
        messageStore : this._dwn.storage.messageStore,
        protocol     : params.protocol,
        rolePath     : params.rolePath,
        tenant       : params.sourceDid,
      });
      if (record !== undefined) {
        const payload = await this.readAudiencePayload(params.authorDid, params.sourceDid, record);
        return payload === undefined ? undefined : { message: record, payload };
      }
    }

    const { reply } = await this.processRequestWithRemoteFallback({
      author        : params.authorDid,
      target        : params.sourceDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : params.protocol,
          protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
          tags         : {
            protocol  : params.protocol,
            rolePath  : params.rolePath,
            contextId : params.contextId,
          },
        },
      },
    }, (reply): boolean => reply.status.code === 200 && reply.entries !== undefined && reply.entries.length > 0);

    if (reply.status.code !== 200 || reply.entries === undefined || reply.entries.length === 0) {
      return undefined;
    }

    const records = reply.entries as RecordsWriteMessage[];
    records.sort((left, right): number => EncryptionControl.compareAudienceProjectionCandidates(params.sourceDid, left, right));
    for (const record of records) {
      const payload = await this.readAudiencePayload(params.authorDid, params.sourceDid, record);
      if (payload !== undefined) {
        return { message: record, payload };
      }
    }

    return undefined;
  }

  private async readAudiencePayload(
    authorDid: string,
    sourceDid: string,
    record: RecordsWriteMessage,
  ): Promise<EncryptionControlAudiencePayload | undefined> {
    if ('encodedData' in record && typeof record.encodedData === 'string') {
      return Encoder.base64UrlToObject(record.encodedData) as EncryptionControlAudiencePayload;
    }

    const { reply } = await this.processRequestWithRemoteFallback({
      author        : authorDid,
      target        : sourceDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: record.recordId } },
    }, (reply): boolean => reply.status.code === 200 && reply.entry?.data !== undefined);
    if (reply.status.code !== 200 || reply.entry?.data === undefined) {
      return undefined;
    }

    return Encoder.bytesToObject(await DataStream.toBytes(reply.entry.data)) as EncryptionControlAudiencePayload;
  }

  private async processRequestWithRemoteFallback<T extends DwnInterface>(
    request: ProcessDwnRequest<T>,
    hasUsableReply: (reply: DwnMessageReply[T]) => boolean,
  ): Promise<DwnResponse<T>> {
    return processDwnReadThrough({
      process : this.processRequest.bind(this),
      send    : this.sendRequest.bind(this),
    }, request, hasUsableReply);
  }

  private async getRecipientRolePublicKey(params: {
    recipientDid: string;
    protocol: string;
    rolePath: string;
  }): Promise<PublicKeyJwk> {
    let protocolDefinition: ProtocolDefinition | undefined;
    try {
      protocolDefinition = await this.getProtocolDefinition(params.recipientDid, params.protocol);
    } catch {
      protocolDefinition = undefined;
    }

    protocolDefinition ??= await this.fetchRemoteProtocolDefinition(params.recipientDid, params.protocol);

    const roleRuleSet = getRuleSetAtPath(params.rolePath, protocolDefinition.structure);
    const publicKeyJwk = roleRuleSet?.$keyAgreement?.publicKeyJwk;
    if (publicKeyJwk === undefined) {
      throw new Error(
        `AgentDwnApi: Recipient '${params.recipientDid}' has no encryption key for role path ` +
        `'${params.protocol}/${params.rolePath}'.`
      );
    }

    return publicKeyJwk;
  }

  private async buildPendingAudienceRecordDescriptor(params: {
    messageParams: DwnMessageParams[DwnInterface.RecordsWrite];
    dataCid: string;
    dataSize: number;
  }): Promise<RecordsWriteDescriptor> {
    const descriptorOptions = {
      ...params.messageParams,
      dataCid  : params.dataCid,
      dataSize : params.dataSize,
    };
    delete descriptorOptions.data;

    return RecordsWrite.createDescriptor(descriptorOptions);
  }

  private async constructDwnMessage<T extends DwnInterface>({ request }: {
    request: ProcessDwnRequest<T>
  }): Promise<DwnMessageWithData<T>> {
    // if the request has a granteeDid, ensure the messageParams include the proper grant parameters
    if (request.granteeDid && !this.hasGrantParams(request.messageParams)) {
      throw new Error('AgentDwnApi: Requested to sign with a permission but no grant messageParams were provided in the request');
    }

    const rawMessage = request.rawMessage;
    let readableStream: ReadableStream<Uint8Array> | undefined;
    // if the request is a RecordsWrite message, we need to handle the data stream and update the messageParams accordingly
    if (isDwnRequest(request, DwnInterface.RecordsWrite)) {
      const messageParams = request.messageParams;

      if (request.dataStream && !messageParams?.data) {
        const { dataStream } = request;
        let forCid: ReadableStream<Uint8Array>;

        if (dataStream instanceof Blob) {
          const [ cidCopy, processCopy ] = (dataStream.stream() as ReadableStream<Uint8Array>).tee();
          forCid = cidCopy;
          readableStream = processCopy;

        } else if (dataStream instanceof ReadableStream) {
          const [ cidCopy, processCopy ] = dataStream.tee();
          forCid = cidCopy;
          readableStream = processCopy;
        }

        if (!rawMessage && messageParams) {
          messageParams.dataCid = await Cid.computeDagPbCidFromStream(forCid!);
          // Compute data size by consuming forCid (already consumed by computeDagPbCidFromStream)
          // and using the Blob/stream size if available.
          if (messageParams.dataSize === undefined) {
            if (dataStream instanceof Blob) {
              messageParams.dataSize = dataStream.size;
            }
            // For ReadableStream without known size, the SDK will compute it during processMessage.
          }
        }
      }
    }

    // Auto-inject encryption keys into protocol definition (Component 5)
    if (isDwnRequest(request, DwnInterface.ProtocolsConfigure) && request.encryption && !rawMessage) {
      const messageParams = request.messageParams!;
      const keyDeriver = await getEncryptionKeyDeriverFn(this.agent, request.author);

      // SDK walks the protocol structure and calls our callback for each path.
      // The KMS performs HKDF derivation + public key computation internally.
      messageParams.definition = await Protocols.deriveAndInjectPublicEncryptionKeys(
        messageParams.definition,
        keyDeriver,
      );

      // Invalidate cache for this protocol
      this._protocolDefinitionCache.delete(
        `${request.target}~${messageParams.definition.protocol}`
      );
    }

    // Cache locally-imported protocol definitions so delegated encrypted
    // writes can resolve `$keyAgreement` keys without re-querying unpublished
    // owner-tenant protocols.
    if (isDwnRequest(request, DwnInterface.ProtocolsConfigure) && !request.encryption) {
      const protocolConfigureMessage = rawMessage as DwnMessage[DwnInterface.ProtocolsConfigure] | undefined;
      const def = protocolConfigureMessage?.descriptor.definition ?? request.messageParams?.definition;
      if (def?.protocol) {
        this._protocolDefinitionCache.set(`${request.target}~${def.protocol}`, def);
      }
    }

    // Auto-encrypt RecordsWrite data to the exact protocol-path `$keyAgreement`
    // key published by the target's installed protocol definition.

    if (isDwnRequest(request, DwnInterface.RecordsWrite) && request.encryption && !rawMessage) {
      const messageParams = request.messageParams;
      if (messageParams?.protocol && messageParams.protocolPath) {
        const isCrossDwn = request.target !== request.author;

        // 1. Fetch the protocol definition — local for same-DWN, remote for cross-DWN
        let protocolDefinition: ProtocolDefinition | undefined;
        if (isCrossDwn) {
          protocolDefinition = await this.fetchRemoteProtocolDefinition(
            request.target, messageParams.protocol,
          );
        } else {
          protocolDefinition = await this.getProtocolDefinition(
            request.target, messageParams.protocol, request.granteeDid,
          );
        }

        if (!protocolDefinition) {
          throw new Error(
            `AgentDwnApi: Protocol '${messageParams.protocol}' is not installed ` +
            `for '${request.target}'. Install the protocol before writing ` +
            `encrypted records.`
          );
        }

        // 2. Walk the protocol structure to find $keyAgreement for this protocol path
        const protocolPathSegments = messageParams.protocolPath.split('/');
        let ruleSet: any = protocolDefinition.structure;
        for (const segment of protocolPathSegments) {
          ruleSet = ruleSet[segment];
        }

        if (!ruleSet?.$keyAgreement) {
          throw new Error(
            `AgentDwnApi: Protocol '${messageParams.protocol}' at path ` +
            `'${messageParams.protocolPath}' does not have encryption configured. ` +
            `Configure the protocol with encryption: true.`
          );
        }

        // 3. Get plaintext bytes (normalize from all supported input types)
        let plaintextBytes: Uint8Array;
        if (messageParams.data) {
          plaintextBytes = messageParams.data instanceof Uint8Array
            ? messageParams.data
            : new TextEncoder().encode(String(messageParams.data));
        } else if (request.dataStream instanceof Blob) {
          plaintextBytes = new Uint8Array(await request.dataStream.arrayBuffer());
        } else if (request.dataStream instanceof ReadableStream) {
          plaintextBytes = await DataStream.toBytes(request.dataStream);
        } else {
          throw new Error('AgentDwnApi: Data must be provided for encrypted records.');
        }

        // 4. Generate random DEK and IV.
        const contentEncryptionAlgorithm = ContentEncryptionAlgorithm.A256CTR;
        const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
        const dataEncryptionIV = crypto.getRandomValues(new Uint8Array(ivLengthFn(contentEncryptionAlgorithm)));

        // 5. Build ProtocolPath encryption input.
        const protocolPathPublicKey = ruleSet.$keyAgreement.publicKeyJwk as PublicKeyJwk;
        const encryptionInput = buildEncryptionInputFn(
          dataEncryptionKey, dataEncryptionIV,
          await Encryption.getKeyId(protocolPathPublicKey), protocolPathPublicKey,
          KeyDerivationScheme.ProtocolPath,
        );
        const roleAudienceInputs = await this.getRoleAudienceKeyEncryptionInputs({
          authorDid       : request.author,
          delegatedGrant  : messageParams.delegatedGrant,
          granteeDid      : request.granteeDid,
          parentContextId : this.getRoleAudienceSourceContextId({
            parentContextId : messageParams.parentContextId,
            protocolPath    : messageParams.protocolPath,
            recordId        : messageParams.recordId,
          }),
          permissionGrantId  : messageParams.permissionGrantId,
          protocol           : messageParams.protocol,
          protocolRole       : messageParams.protocolRole,
          protocolDefinition,
          sourceDid          : request.target,
          sourceProtocolPath : messageParams.protocolPath,
          sourceRuleSet      : ruleSet,
        });
        encryptionInput.keyEncryptionInputs.push(...roleAudienceInputs.inputs);

        // 6. Encrypt data and compute CID.
        const { encryptedBytes, dataCid, dataSize } =
          await encryptAndComputeCidFn(plaintextBytes, dataEncryptionKey, dataEncryptionIV, contentEncryptionAlgorithm);

        // 7. Write pending role-audience records before finalizing the encrypted source record.
        if (roleAudienceInputs.pendingAudienceRecords.length > 0) {
          messageParams.dateCreated ??= Time.getCurrentTimestamp();
          messageParams.messageTimestamp ??= messageParams.dateCreated;
          if (messageParams.published === true) {
            messageParams.datePublished ??= messageParams.dateCreated;
          }
          if (request.granteeDid && messageParams.permissionGrantId && !messageParams.delegatedGrant) {
            await this.populateDelegatedGrantForWrite(request.author, request.granteeDid, messageParams);
          }
          messageParams.recordId ??= await RecordsWrite.getEntryId(request.author, await this.buildPendingAudienceRecordDescriptor({
            dataCid,
            dataSize,
            messageParams,
          }));

          for (const pending of roleAudienceInputs.pendingAudienceRecords) {
            const sourceContextId = messageParams.parentContextId === undefined
              ? messageParams.recordId
              : `${messageParams.parentContextId}/${messageParams.recordId}`;
            const contextId = getRoleAudienceContextId(pending.rolePath, sourceContextId);
            if (contextId === undefined) {
              throw new Error(`AgentDwnApi: Unable to determine role audience context for '${pending.rolePath}'.`);
            }

            await this.assertAudienceSealCoverage({
              contextId,
              granteeDid : request.granteeDid,
              protocol   : pending.audienceKey.protocol,
              rolePath   : pending.audienceKey.rolePath,
              sourceDid  : request.target,
            });

            const audienceKey: AudienceKeyPayload = {
              ...pending.audienceKey,
              contextId,
            };
            await createAudienceRecordFn({
              agent             : this.agent,
              audienceKey,
              authorDid         : request.author,
              contextId,
              delegatedGrant    : messageParams.delegatedGrant,
              granteeDid        : request.granteeDid,
              permissionGrantId : messageParams.permissionGrantId,
              protocol          : audienceKey.protocol,
              protocolRole      : messageParams.protocolRole,
              rolePath          : audienceKey.rolePath,
              sealingPublicKey  : pending.sealingPublicKey,
              sourceDid         : request.target,
            });
            this._audienceDecryptionKeyCache.set(getAudienceDecryptionKeyCacheKey({
              contextId,
              keyId        : audienceKey.keyId,
              protocol     : audienceKey.protocol,
              recipientDid : request.author,
              rolePath     : audienceKey.rolePath,
              sourceDid    : request.target,
            }), {
              contextId,
              keyMaterial  : audienceKey.keyMaterial,
              protocol     : audienceKey.protocol,
              recipientDid : request.author,
              rolePath     : audienceKey.rolePath,
              sourceDid    : request.target,
            });
          }
        }
        messageParams.dataCid = dataCid;
        messageParams.dataSize = dataSize;
        delete messageParams.data;
        readableStream = DataStream.fromBytes(encryptedBytes);
        request.dataStream = undefined;
        messageParams.encryptionInput = encryptionInput;
      }
    }

    let dwnMessage: DwnMessageInstance[T];
    const dwnMessageConstructor = dwnMessageConstructors[request.messageType];

    // if a raw message is provided, parse it; otherwise create a new dwn message
    if (rawMessage) {
      dwnMessage = await dwnMessageConstructor.parse(rawMessage);
      if (isRecordsWrite(dwnMessage) && request.signAsOwner) {
        // if we are signing as owner, we use the author's signer
        const signer = await this.getSigner(request.author);
        await dwnMessage.signAsOwner(signer);
      } else if (request.granteeDid && isRecordsWrite(dwnMessage) && request.signAsOwnerDelegate) {
        // if we are signing as owner delegate, we use the grantee's signer and the provided delegated grant
        const signer = await this.getSigner(request.granteeDid);

        //if we have reached here, the presence of the grant params has already been checked
        const messageParams = request.messageParams as DwnMessageParams[DwnInterface.RecordsWrite];
        await dwnMessage.signAsOwnerDelegate(signer, messageParams.delegatedGrant!);
      }
    } else {
      if (request.messageParams === undefined) {
        throw new Error('AgentDwnApi: messageParams must be provided when rawMessage is not given.');
      }

      // If we need to sign as an author delegate or with permissions we need to get the grantee's signer.
      // The messageParams should include either a permission grant invocation or a delegatedGrant message.
      const signer = request.granteeDid ?
        await this.getSigner(request.granteeDid) :
        await this.getSigner(request.author);

      // When signing as a delegate with a permissionGrantId, fetch the full
      // grant message and pass it as `delegatedGrant` so the DWN SDK correctly
      // sets `authorization.authorDelegatedGrant` and resolves the logical
      // author to the grantor (owner) rather than the signer (delegate).
      const params = { ...request.messageParams } as any;
      if (request.granteeDid && params.permissionGrantId && !params.delegatedGrant && isDwnRequest(request, DwnInterface.RecordsWrite)) {
        await this.populateDelegatedGrantForWrite(request.author, request.granteeDid, params);
      }

      dwnMessage = await dwnMessageConstructor.create({
        ...params,
        signer
      });

    }

    return {
      message    : dwnMessage.message as DwnMessage[T],
      dataStream : readableStream,
    };
  }

  private async populateDelegatedGrantForWrite(
    authorDid: string,
    granteeDid: string,
    messageParams: DwnMessageParams[DwnInterface.RecordsWrite],
  ): Promise<void> {
    if (messageParams.permissionGrantId === undefined || messageParams.delegatedGrant !== undefined) {
      return;
    }

    const { reply: grantReply } = await this.processRequest({
      author        : granteeDid,
      target        : authorDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: messageParams.permissionGrantId } },
    });
    if (grantReply.status.code === 200 && grantReply.entry?.recordsWrite && grantReply.entry?.data) {
      const grantDataBytes = await DataStream.toBytes(grantReply.entry.data);
      messageParams.delegatedGrant = {
        ...grantReply.entry.recordsWrite,
        encodedData: Convert.uint8Array(grantDataBytes).toBase64Url(),
      };
    }
  }

  private hasGrantParams<T extends DwnInterface>(params?: DwnMessageParams[T]): boolean {
    return params !== undefined &&
      (('permissionGrantId' in params && params.permissionGrantId !== undefined) ||
      ('permissionGrantIds' in params && params.permissionGrantIds !== undefined) ||
      ('delegatedGrant' in params && params.delegatedGrant !== undefined));
  }

  private async getSigner(author: string): Promise<DwnSigner> {
    // If the author is the Agent's DID, use the Agent's signer.
    if (author === this.agent.agentDid.uri) {
      const signer = await this.agent.agentDid.getSigner();

      return {
        algorithm : signer.algorithm,
        keyId     : signer.keyId,
        sign      : async (data: Uint8Array): Promise<Uint8Array> => {
          return await signer.sign({ data });
        }
      };

    } else {
      // Prefer a locally-stored BearerDid when the agent controls this DID.
      // This avoids an unnecessary DID resolution round-trip during signing,
      // which can fail if the resolver path encounters malformed cached data.
      try {
        const localDid = await this.agent.did.get({ didUri: author });
        if (localDid) {
          const signer = await localDid.getSigner();

          return {
            algorithm : signer.algorithm,
            keyId     : signer.keyId,
            sign      : async (data: Uint8Array): Promise<Uint8Array> => {
              return await signer.sign({ data });
            }
          };
        }

        // Otherwise, use the author's DID to determine the signing method.
        const signingMethod = await this.agent.did.getSigningMethod({ didUri: author });

        if (!signingMethod.publicKeyJwk) {
          throw new Error(`Verification method '${signingMethod.id}' does not contain a public key in JWK format`);
        }

        // Compute the key URI of the verification method's public key.
        const keyUri = await this.agent.keyManager.getKeyUri({ key: signingMethod.publicKeyJwk });

        // Verify that the key is present in the key manager. If not, an error is thrown.
        const publicKey = await this.agent.keyManager.getPublicKey({ keyUri });

        // Bind the Agent's Key Manager to the signer.
        const keyManager = this.agent.keyManager;

        return {
          algorithm : CryptoUtils.getJoseSignatureAlgorithmFromPublicKey(publicKey),
          keyId     : signingMethod.id,
          sign      : async (data: Uint8Array): Promise<Uint8Array> => {
            return await keyManager.sign({ data, keyUri: keyUri! });
          }
        };
      } catch (error: any) {
        throw new Error(`AgentDwnApi: Unable to get signer for author '${author}': ${error.message}`);
      }
    }
  }

  /**
   * Constructs an EncryptionKeyDeriver callback for the SDK.
   * Delegates to the standalone function in `dwn-encryption.ts`.
   *
   * @param didUri - The DID URI to create the key deriver for
   * @returns An EncryptionKeyDeriver callback object
   */
  public async getEncryptionKeyDeriver(
    didUri: string
  ): Promise<EncryptionKeyDeriver> {
    return getEncryptionKeyDeriverFn(this.agent, didUri);
  }

  /**
   * Fetches a protocol definition from the local DWN, with caching.
   * Returns undefined if the protocol is not installed.
   *
   * @param tenantDid - The tenant DID to query
   * @param protocolUri - The protocol URI to fetch
   * @returns The protocol definition, or undefined if not found
   */
  private async getProtocolDefinition(
    tenantDid: string,
    protocolUri: string,
    granteeDid?: string,
  ): Promise<ProtocolDefinition | undefined> {
    if (!this._dwn) {
      // Remote mode: query via RPC (same as fetchRemoteProtocolDefinition,
      // but for locally-managed DIDs). The remote protocol definition
      // cache uses a different key prefix, so we use a dedicated call.
      try {
        return await this.fetchRemoteProtocolDefinition(tenantDid, protocolUri);
      } catch (error: unknown) {
        // Only treat "not found" responses as missing protocols.  Transient
        // errors (network timeouts, auth failures) are rethrown so the
        // caller does not silently skip encryption or other protocol-
        // required behaviours.
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('not found') || msg.includes('404') || msg.includes('No protocol')) {
          return undefined;
        }
        throw error;
      }
    }
    // When operating as a delegate, resolve the ProtocolsQuery grant so
    // the local DWN authorises the query for unpublished protocols.
    let permissionGrantId: string | undefined;
    if (granteeDid) {
      try {
        const permissionsApi = new AgentPermissionsApi({ agent: this.agent });
        const { grant } = await permissionsApi.getPermissionForRequest({
          connectedDid : tenantDid,
          delegateDid  : granteeDid,
          protocol     : protocolUri,
          cached       : true,
          messageType  : DwnInterface.ProtocolsQuery,
        });
        permissionGrantId = grant.id;
      } catch {
        // No grant found — try without (works for published protocols).
      }
    }

    return getProtocolDefinitionFn(
      tenantDid, protocolUri, this._dwn,
      this.getSigner.bind(this), this._protocolDefinitionCache,
      granteeDid, permissionGrantId,
    );
  }

  /**
   * Fetches a protocol definition from a remote DWN.
   * Uses an unsigned ProtocolsQuery (public protocols can be queried anonymously).
   */
  private async fetchRemoteProtocolDefinition(
    targetDid: string,
    protocolUri: string,
  ): Promise<ProtocolDefinition> {
    return fetchRemoteProtocolDefinitionFn(
      targetDid, protocolUri, this.getDwnEndpointUrlsForTarget.bind(this),
      this.sendDwnRpcRequest.bind(this), this._protocolDefinitionCache,
    );
  }

  /**
   * Post-processes a DWN reply, auto-decrypting data if encryption is enabled.
   * Delegates to the standalone function in `dwn-encryption.ts`.
   */
  private async maybeDecryptReply<T extends DwnInterface>(
    request: ProcessDwnRequest<T> | SendDwnRequest<T>,
    reply: DwnMessageReply[T],
  ): Promise<void> {
    return maybeDecryptReplyFn(
      request, reply, this.agent,
      this._delegateDecryptionKeyCache,
      this._audienceDecryptionKeyCache,
    );
  }

  private async getDwnMessage<T extends DwnInterface>({ author, messageCid }: {
    author: string;
    messageType: T;
    messageCid: string;
  }): Promise<DwnMessageWithRpcData<T>> {
    const signer = await this.getSigner(author);

    // Construct a MessagesRead message to fetch the message.
    const messagesRead = await dwnMessageConstructors[DwnInterface.MessagesRead].create({
      messageCid: messageCid,
      signer
    });

    let result: any;

    if (this._dwn) {
      // Local mode: process directly with the in-process DWN.
      result = await this._dwn.processMessage(author, messagesRead.message);
    } else {
      // Remote mode: route through RPC to the local DWN server.
      result = await this.sendDwnRpcRequest({
        targetDid       : author,
        dwnEndpointUrls : [this._localDwnEndpoint!],
        message         : messagesRead.message,
      });
    }

    if (result.status.code !== 200) {
      throw new Error(`AgentDwnApi: Failed to read message, response status: ${result.status.code} - ${result.status.detail}`);
    }

    const messageEntry = result.entry!;
    const message = messageEntry.message as DwnMessage[T];

    const dwnMessageWithData: DwnMessageWithRpcData<T> = { message };
    // If the message is a RecordsWrite, data will be present in the form of a stream

    if (isRecordsWrite(messageEntry)) {
      // The processMessage result attaches a `data` ReadableStream to
      // RecordsWrite entries, but the declared type doesn't include it.
      // Narrow structurally to the runtime shape rather than going via
      // `Record<string, unknown>` (which loses the value type entirely).
      const entryData = (messageEntry as { data?: ReadableStream<Uint8Array> }).data;
      if (entryData) {
        dwnMessageWithData.data = entryData;
      }
    }

    return dwnMessageWithData;
  }

  /**
   * Clears delegate decryption keys from the in-memory cache.
   *
   * @param delegateDid - If provided, clears keys for that delegate session only.
   *                      If omitted, clears all delegate keys.
   */
  public clearDelegateDecryptionKeys(delegateDid?: string): void {
    if (delegateDid) {
      this._delegateDecryptionKeyCache.delete(`ddk~${delegateDid}`);
    } else {
      this._delegateDecryptionKeyCache.clear();
    }
  }
}
