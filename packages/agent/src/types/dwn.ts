import type { DidService } from '@enbox/dids';
import type { PublicKeyJwk } from '@enbox/crypto';
import type { RequireOnly } from '@enbox/common';

import type {
  DataEncodedRecordsWriteMessage,
  GenericMessageReply,
  MessagesQueryMessage,
  MessagesQueryOptions,
  MessagesQueryReply,
  MessagesReadMessage,
  MessagesReadOptions,
  MessagesReadReply,
  MessagesSubscribeMessage,
  MessagesSubscribeOptions,
  MessagesSubscribeReply,
  ProtocolsConfigureMessage,
  ProtocolsConfigureOptions,
  ProtocolsQueryMessage,
  ProtocolsQueryOptions,
  ProtocolsQueryReply,
  RecordsCountMessage,
  RecordsCountOptions,
  RecordsCountReply,
  RecordsDeleteMessage,
  RecordsDeleteOptions,
  RecordsQueryMessage,
  RecordsQueryOptions,
  RecordsQueryReply,
  RecordsReadMessage,
  RecordsReadOptions,
  RecordsReadReply,
  RecordsSubscribeMessage,
  RecordsSubscribeOptions,
  RecordsSubscribeReply,
  RecordsWriteMessage,
  RecordsWriteOptions,
  SubscriptionListener,
} from '@enbox/dwn-sdk-js';

import {
  MessagesQuery,
  MessagesRead,
  MessagesSubscribe,
  ProtocolsConfigure,
  ProtocolsQuery,
  RecordsCount,
  RecordsDelete,
  RecordsQuery,
  RecordsRead,
  RecordsSubscribe,
  RecordsWrite,
} from '@enbox/dwn-sdk-js';

/**
 * Represents a Decentralized Web Node (DWN) service in a DID Document.
 *
 * A DWN DID service is a specialized type of DID service with the `type` set to
 * `DecentralizedWebNode`. Encryption and signing keys are resolved from the DID document's
 * verification methods, not from the service entry.
 *
 * The `enc` and `sig` properties are optional legacy fields that may be present on existing
 * DID documents. New implementations should resolve keys from the
 * DID document's verification methods by purpose (`keyAgreement` for encryption,
 * `authentication`/`assertionMethod` for signing).
 *
 * @example
 * ```ts
 * const service: DwnDidService = {
 *   id: 'did:example:123#dwn',
 *   type: 'DecentralizedWebNode',
 *   serviceEndpoint: 'https://enbox-dwn.fly.dev'
 * }
 * ```
 *
 * @see {@link https://github.com/enboxorg/dwn-spec | Enbox DWN Specification}
 */
export interface DwnDidService extends DidService {}

export enum DwnInterface {
  MessagesQuery = 'MessagesQuery',
  MessagesRead = 'MessagesRead',
  MessagesSubscribe = 'MessagesSubscribe',
  ProtocolsConfigure = 'ProtocolsConfigure',
  ProtocolsQuery = 'ProtocolsQuery',
  RecordsCount = 'RecordsCount',
  RecordsDelete = 'RecordsDelete',
  RecordsQuery = 'RecordsQuery',
  RecordsRead = 'RecordsRead',
  RecordsSubscribe = 'RecordsSubscribe',
  RecordsWrite = 'RecordsWrite'
}

export type DwnRecordsInterfaces =
  | DwnInterface.RecordsCount | DwnInterface.RecordsDelete | DwnInterface.RecordsQuery | DwnInterface.RecordsRead
  | DwnInterface.RecordsSubscribe | DwnInterface.RecordsWrite;

export interface DwnMessage {
  [DwnInterface.MessagesQuery] : MessagesQueryMessage;
  [DwnInterface.MessagesRead] : MessagesReadMessage;
  [DwnInterface.MessagesSubscribe] : MessagesSubscribeMessage;
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigureMessage;
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryMessage;
  [DwnInterface.RecordsCount] : RecordsCountMessage;
  [DwnInterface.RecordsDelete] : RecordsDeleteMessage;
  [DwnInterface.RecordsQuery] : RecordsQueryMessage;
  [DwnInterface.RecordsRead] : RecordsReadMessage;
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeMessage;
  [DwnInterface.RecordsWrite] : RecordsWriteMessage;
}

export interface DwnMessageDescriptor {
  [DwnInterface.MessagesQuery] : MessagesQueryMessage['descriptor'];
  [DwnInterface.MessagesRead] : MessagesReadMessage['descriptor'];
  [DwnInterface.MessagesSubscribe] : MessagesSubscribeMessage['descriptor'];
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigureMessage['descriptor'];
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryMessage['descriptor'];
  [DwnInterface.RecordsCount] : RecordsCountMessage['descriptor'];
  [DwnInterface.RecordsDelete] : RecordsDeleteMessage['descriptor'];
  [DwnInterface.RecordsQuery] : RecordsQueryMessage['descriptor'];
  [DwnInterface.RecordsRead] : RecordsReadMessage['descriptor'];
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeMessage['descriptor'];
  [DwnInterface.RecordsWrite] : RecordsWriteMessage['descriptor'];
}

export interface DwnMessageParams {
  [DwnInterface.MessagesQuery] : Omit<MessagesQueryOptions, 'signer'>;
  [DwnInterface.MessagesRead] : RequireOnly<MessagesReadOptions, 'messageCid'>;
  [DwnInterface.MessagesSubscribe] : Partial<MessagesSubscribeOptions>;
  [DwnInterface.ProtocolsConfigure] : RequireOnly<ProtocolsConfigureOptions, 'definition'>;
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryOptions;
  [DwnInterface.RecordsCount] : RecordsCountOptions;
  [DwnInterface.RecordsDelete] : RequireOnly<RecordsDeleteOptions, 'recordId'>;
  [DwnInterface.RecordsQuery] : RecordsQueryOptions;
  [DwnInterface.RecordsRead] : RecordsReadOptions;
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeOptions;
  [DwnInterface.RecordsWrite] : RecordsWriteOptions;
}

export interface DwnMessageReply {
  [DwnInterface.MessagesQuery] : MessagesQueryReply;
  [DwnInterface.MessagesRead] : MessagesReadReply;
  [DwnInterface.MessagesSubscribe] : MessagesSubscribeReply;
  [DwnInterface.ProtocolsConfigure] : GenericMessageReply;
  [DwnInterface.ProtocolsQuery] : ProtocolsQueryReply;
  [DwnInterface.RecordsCount] : RecordsCountReply;
  [DwnInterface.RecordsDelete] : GenericMessageReply;
  [DwnInterface.RecordsQuery] : RecordsQueryReply;
  [DwnInterface.RecordsRead] : RecordsReadReply;
  [DwnInterface.RecordsSubscribe] : RecordsSubscribeReply;
  [DwnInterface.RecordsWrite] : GenericMessageReply;
}

export interface MessageHandler {
  [DwnInterface.MessagesSubscribe] : SubscriptionListener;
  [DwnInterface.RecordsSubscribe] : SubscriptionListener;

  // define all of them individually as undefined
  [DwnInterface.MessagesQuery] : undefined;
  [DwnInterface.MessagesRead] : undefined;
  [DwnInterface.ProtocolsConfigure] : undefined;
  [DwnInterface.ProtocolsQuery] : undefined;
  [DwnInterface.RecordsCount] : undefined;
  [DwnInterface.RecordsDelete] : undefined;
  [DwnInterface.RecordsQuery] : undefined;
  [DwnInterface.RecordsRead] : undefined;
  [DwnInterface.RecordsWrite] : undefined;
}

export type DwnRequest<T extends DwnInterface> = {
  author: string;
  target: string;
  messageType: T;
};

/**
 * Defines the structure for response status, including a status code and detail message.
 */
export type DwnResponseStatus = {
  /** Encapsulates the outcome of an operation, providing both a numeric status code and a descriptive message. */
  status: {
    /** Numeric status code representing the outcome of the operation. */
    code: number;

    /** Descriptive detail about the status or error. */
    detail: string;
  };
};

export type ProcessDwnRequest<T extends DwnInterface> = DwnRequest<T> & {
  dataStream?: Blob | ReadableStream;
  rawMessage?: DwnMessage[T];
  messageParams?: DwnMessageParams[T];
  store?: boolean;
  signAsOwner?: boolean;
  signAsOwnerDelegate?: boolean;
  granteeDid?: string;
  subscriptionHandler?: MessageHandler[T];
  /**
   * If true, automatically encrypt protocol records and inject $keyAgreement keys.
   * Requires the identity to have an X25519 keyAgreement key.
   */
  encryption?: boolean;
  /**
   * The recipient's role-path public key for this write, at the record's own
   * `protocolPath`. When writing a `$role` record with a `recipient`, the agent
   * provisions a `$encryption/delivery` record wrapping the role-audience key to
   * this key.
   *
   * Supply it for recipients that publish no resolvable DWN endpoint (e.g. a bare
   * `did:jwk` running in "remote-only" mode): the recipient's role-path key is a
   * hardened derivation of its own encryption root, so only the recipient can
   * produce it and the agent cannot discover it by resolving the recipient's DID.
   * The recipient computes this public key locally and carries it out of band —
   * e.g. in a signed join request — for the owner to supply here.
   *
   * Delivery provisioning is always BEST-EFFORT. A supplied key is validated
   * BEFORE the write (shape, usability, and that the write targets a deliverable
   * role audience — caller misuse throws with nothing written), but once the
   * `$role` write is accepted, a delivery that cannot be provisioned is reported
   * via {@link DwnResponse.audienceKeyDelivery} with `delivered: false` — the
   * accepted write is never unwound. A supplied key only chooses which key the
   * delivery is wrapped to (skipping recipient DID resolution) and guarantees an
   * outcome is always reported, so the caller can enforce its own delivery
   * policy. When omitted, the agent resolves the recipient's key from its
   * installed protocol definition (local, then via the recipient's DWN), and a
   * recipient whose key cannot be resolved is likewise reported with
   * `delivered: false` rather than failing the write.
   *
   * The agent validates the key's shape and usability, but NOT that it truly belongs
   * to the recipient — that binding rests entirely on the out-of-band channel the
   * caller trusts (e.g. the signed join request). The caller owns key authenticity.
   * Supported on grant-authorized writes (`permissionGrantId`/`delegatedGrant`):
   * a delivery failure is reported on the response, never thrown, so no delete
   * authorization is ever needed to unwind the write.
   */
  recipientRolePublicKey?: PublicKeyJwk;
};

export type SendDwnRequest<T extends DwnInterface> = DwnRequest<T> & (ProcessDwnRequest<T> | { messageCid: string });

/**
 * Outcome of role-audience key delivery provisioning for an accepted `$role`
 * record write. Surfaced on {@link DwnResponse.audienceKeyDelivery} so a skipped
 * best-effort delivery is visible and inspectable instead of silently swallowed.
 * Also returned by `AgentDwnApi.reprovisionAudienceKeyDelivery` — see
 * {@link ReprovisionAudienceKeyDeliveryParams} for that call's policy.
 */
export type AudienceKeyDeliveryOutcome =
  | {
      /** A `$encryption/delivery` record wrapping the current audience key exists for the recipient. */
      delivered: true;

      /** The recipient the role-audience key was delivered to. */
      recipientDid: string;

      /**
       * Set when a delivery wrapping the CURRENT audience key to the CURRENT
       * resolved recipient wrap target (the supplied or resolved role-path key)
       * already existed, so no new record was written. A delivery wrapping a
       * different recipient key — e.g. a mistaken earlier supplied key — does
       * NOT count and is repaired by a fresh write. Only reported by
       * `AgentDwnApi.reprovisionAudienceKeyDelivery` (delivery provisioning on a
       * fresh `$role` write always writes).
       */
      alreadyDelivered?: true;
    }
  | {
      /** No `$encryption/delivery` record was written for the recipient. */
      delivered: false;

      /** The recipient the role-audience key was NOT delivered to. */
      recipientDid: string;

      /**
       * Why best-effort delivery was skipped or failed — e.g. the recipient
       * publishes no resolvable DWN endpoint and no `recipientRolePublicKey` was
       * supplied, or the delivery write itself was rejected. Required on the
       * failure branch. Supplied-key failures surface here too; only pre-write
       * validation of a supplied key throws.
       */
      reason: string;
    };

/**
 * Result of `AgentDwnApi.getAudienceKeyDeliveryStatus` — whether a
 * `$encryption/delivery` record wraps the CURRENT role-audience key of one
 * audience tuple to one recipient.
 *
 * This is the supported alternative to hand-rolling `$encryption/delivery`
 * queries, which get two things wrong:
 *
 *   - A delivery of a SUPERSEDED audience key still matches a query that omits
 *     the audience `keyId`, reporting delivered for a key the recipient can no
 *     longer use. The primitive resolves the current audience record for the
 *     tuple first and matches deliveries on its `keyId` only.
 *   - A DELEGATE querying its grantor's tenant is visibility-filtered: the DWN
 *     lets a delivery record be read only by the tenant, its author, its
 *     recipient, or a delegate whose invoked Read grant names the delivery's
 *     recipient as the grant's grantor or grantee. A third-party collaborator's
 *     delivery is therefore NEVER visible to a wallet-session delegate, under
 *     any grant — empty results are structural, not evidence of non-delivery.
 *     A delegate caller gets `'unverifiable'` WITHOUT the query being issued,
 *     rather than that blindness being laundered into `'not-delivered'`.
 */
export type AudienceKeyDeliveryStatus =
  | {
      /**
       * A delivery record wrapping the CURRENT audience key exists for the
       * recipient. This asserts the record's existence only — not that the
       * recipient can decrypt it (e.g. a delivery wrapped to a mistaken
       * caller-supplied key still counts as delivered).
       */
      status: 'delivered';

      /** The recipient the delivery status was resolved for. */
      recipientDid: string;

      /** The current audience key id the delivery record wraps. */
      keyId: string;
    }
  | {
      /** No delivery record wraps the CURRENT audience key to the recipient. */
      status: 'not-delivered';

      /** The recipient the delivery status was resolved for. */
      recipientDid: string;

      /**
       * The current audience key id deliveries were matched against. Absent when
       * no audience record exists for the tuple at all (nothing was ever
       * provisioned, so nothing could have been delivered).
       */
      keyId?: string;

      /** Why the status is not-delivered. */
      reason: string;
    }
  | {
      /**
       * The status cannot be determined, for one of two reasons (told apart by
       * `reason`): the caller operates as a delegate, whose view of third-party
       * delivery records is visibility-filtered by the DWN (no query is issued);
       * or the remote DWN was unreachable (or replied with an error) while the
       * local projection had no matching record, so an empty result cannot be
       * asserted as authoritative absence.
       */
      status: 'unverifiable';

      /** The recipient the delivery status was requested for. */
      recipientDid: string;

      /** Why the status cannot be determined from this caller's context. */
      reason: string;
    };

/**
 * Parameters of `AgentDwnApi.getAudienceKeyDeliveryStatus`, addressing one
 * audience tuple (`protocol`, `rolePath`, context) and one recipient on the
 * `target` tenant. See {@link AudienceKeyDeliveryStatus} for result semantics.
 */
export type GetAudienceKeyDeliveryStatusParams = {
  /** The owner tenant DID whose DWN holds the audience and delivery records. */
  target: string;

  /** The protocol URI of the audience tuple. */
  protocol: string;

  /** The `$role` protocol path of the audience tuple. */
  rolePath: string;

  /**
   * Context anchoring the audience tuple: the role RECORD's `contextId` (or the
   * role-audience context id itself) — both normalize internally to the same
   * role-audience context id. Omit for root-level role paths. A nested
   * `rolePath` with no context deep enough to reach its parent context is
   * caller misuse and throws.
   */
  contextId?: string;

  /** The recipient whose delivery status is resolved. */
  recipientDid: string;

  /**
   * The delegate the caller operates as, when not the tenant itself. Delegates
   * are structurally blind to third-party deliveries (see
   * {@link AudienceKeyDeliveryStatus}), so a delegate caller gets
   * `'unverifiable'` without any query being issued.
   */
  granteeDid?: string;
};

/**
 * Parameters of `AgentDwnApi.reprovisionAudienceKeyDelivery` — provisions (or
 * re-provisions) the `$encryption/delivery` record wrapping the CURRENT
 * role-audience key of one audience tuple to `recipientDid`, WITHOUT touching
 * the `$role` record. This is the supported alternative to "touch-updating"
 * the role record to force re-delivery, which piles up record states and
 * duplicate delivery records (delivery records are immutable and undeletable).
 *
 * The recipient's role-path public key is resolved FIRST (the supplied
 * `recipientRolePublicKey`, else remote resolution from the recipient's
 * installed protocol definition) — it is both the wrap target of a new delivery
 * and the dedupe discriminant.
 *
 * Skip-if-exists: when a delivery wrapping the CURRENT audience key to that
 * resolved recipient key already exists, the outcome is
 * `{ delivered: true, alreadyDelivered: true }` and no duplicate record is
 * written. A delivery wrapping a DIFFERENT recipient key (a mistaken earlier
 * supplied key, or a superseded recipient key) does not suppress the write —
 * that is exactly the state this primitive repairs. Delegate contexts are
 * structurally blind to third-party deliveries (see
 * {@link AudienceKeyDeliveryStatus}), so the existence check is skipped for
 * them and a duplicate may be written. An existence check the remote cannot
 * confirm never blocks the write either — re-provisioning stays best-effort
 * and may duplicate. Concurrent OWNER-authorized calls in one agent for the same
 * tuple and recipient key are coalesced onto one execution. Calls carrying an
 * explicit authorization context (`granteeDid`, grant material, or
 * `protocolRole`) are deliberately NOT coalesced, so each call independently
 * exercises its authorization against current grant/revocation state.
 * Cross-device idempotency (deterministic delivery identity) is tracked by the
 * delivery-dedupe design (#1092). Duplicates are a storage/scan cost, not a
 * correctness break — recipients try candidate deliveries until one decrypts.
 *
 * Otherwise the audience key is resolved — or minted, which requires seal
 * coverage (the owner identity, or a delegate holding covering grantKey
 * material) — and the delivery record is written. Like delivery provisioning on
 * a `$role` write, this is BEST-EFFORT: failures — missing seal coverage, an
 * unresolvable recipient key, or the DWN rejecting the write because the
 * recipient holds no active role record at `rolePath` — are reported as
 * `{ delivered: false, reason }` on {@link AudienceKeyDeliveryOutcome}, never
 * thrown. Only pre-write validation (a malformed/unusable supplied key, or a
 * nested `rolePath` without a deep-enough `contextId`) throws.
 */
export type ReprovisionAudienceKeyDeliveryParams = {
  /** The owner tenant DID whose DWN holds the audience and delivery records. */
  target: string;

  /** The protocol URI of the audience tuple. */
  protocol: string;

  /** The `$role` protocol path of the audience tuple. */
  rolePath: string;

  /**
   * Context anchoring the audience tuple: the role RECORD's `contextId` (or the
   * role-audience context id itself), normalized internally. Omit for
   * root-level role paths; required deep enough to reach the parent context of
   * a nested `rolePath`.
   */
  contextId?: string;

  /** The recipient the current audience key is delivered to. */
  recipientDid: string;

  /**
   * The recipient's role-path public key, supplied out of band when the
   * recipient publishes no resolvable DWN endpoint — bypasses remote
   * resolution. Validated for shape and usability BEFORE anything is written
   * (caller misuse throws), but NOT for authenticity: the caller owns the
   * binding to the recipient, exactly as on
   * {@link ProcessDwnRequest.recipientRolePublicKey}.
   */
  recipientRolePublicKey?: PublicKeyJwk;

  /** The delegate the caller operates as, when not the tenant itself. */
  granteeDid?: string;

  /** Grant id authorizing a delegated call's writes (alternative to `delegatedGrant`). */
  permissionGrantId?: string;

  /** Delegated grant message authorizing a delegated call's writes. */
  delegatedGrant?: DataEncodedRecordsWriteMessage;

  /** Protocol role invoked for role-authorized writes. */
  protocolRole?: string;
};

export type DwnResponse<T extends DwnInterface> = {
  message?: DwnMessage[T];
  messageCid: string;
  reply: DwnMessageReply[T];

  /**
   * Present only for accepted `$role` record writes that triggered role-audience
   * key delivery provisioning. Reports whether the recipient's
   * `$encryption/delivery` record was written — always best-effort: a delivery
   * that cannot be provisioned (a recipient key that cannot be resolved with no
   * key supplied, or a supplied-key delivery that fails to wrap or write) is
   * reported here with `delivered: false` instead of failing or unwinding the
   * accepted write. Only pre-write validation of a supplied
   * `recipientRolePublicKey` throws; a supplied key always yields an outcome
   * here (delivered, or a reported failure).
   */
  audienceKeyDelivery?: AudienceKeyDeliveryOutcome;
};

/**
 * Per-DWN-interface message factory. Only the static `create` and `parse`
 * methods are part of the contract — the underlying classes have private
 * or protected constructors (factory pattern), so the interface
 * intentionally does not declare `new ()`. Omitting `new ()` lets the
 * mapped-type table below assign class values directly without casts:
 * a class with a private constructor still satisfies a structural type
 * that doesn't require constructability, as long as the static side
 * (`create` / `parse`) lines up.
 */
export interface DwnMessageConstructor<T extends DwnInterface> {
  create(params: DwnMessageParams[T]): Promise<DwnMessageInstance[T]>;
  parse(rawMessage: DwnMessage[T]): Promise<DwnMessageInstance[T]>;
}

export const dwnMessageConstructors: { [T in DwnInterface]: DwnMessageConstructor<T> } = {
  [DwnInterface.MessagesQuery]      : MessagesQuery,
  [DwnInterface.MessagesRead]       : MessagesRead,
  [DwnInterface.MessagesSubscribe]  : MessagesSubscribe,
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigure,
  [DwnInterface.ProtocolsQuery]     : ProtocolsQuery,
  [DwnInterface.RecordsCount]       : RecordsCount,
  [DwnInterface.RecordsDelete]      : RecordsDelete,
  [DwnInterface.RecordsQuery]       : RecordsQuery,
  [DwnInterface.RecordsRead]        : RecordsRead,
  [DwnInterface.RecordsSubscribe]   : RecordsSubscribe,
  [DwnInterface.RecordsWrite]       : RecordsWrite,
};

export interface DwnMessageInstance {
  [DwnInterface.MessagesQuery] : MessagesQuery;
  [DwnInterface.MessagesRead] : MessagesRead;
  [DwnInterface.MessagesSubscribe] : MessagesSubscribe;
  [DwnInterface.ProtocolsConfigure] : ProtocolsConfigure;
  [DwnInterface.ProtocolsQuery] : ProtocolsQuery;
  [DwnInterface.RecordsCount] : RecordsCount;
  [DwnInterface.RecordsDelete] : RecordsDelete;
  [DwnInterface.RecordsQuery] : RecordsQuery;
  [DwnInterface.RecordsRead] : RecordsRead;
  [DwnInterface.RecordsSubscribe] : RecordsSubscribe;
  [DwnInterface.RecordsWrite] : RecordsWrite;
}

export type DwnMessageWithData<T extends DwnInterface> = {
  message: DwnMessage[T];
  dataStream?: ReadableStream<Uint8Array>;
};

// The following types are exported by the DWN SDK and are re-exported here so that dependent
// packages do not need to import the DWN SDK directly. This ensures that downstream packages are
// always using the same version of the DWN SDK as the agent package.

// Runtime value re-exports (classes, enums, objects)
export {
  DateSort as DwnDateSort,
  DwnConstant,
  ContentEncryptionAlgorithm as DwnContentEncryptionAlgorithm,
  KeyAgreementAlgorithm as DwnKeyAgreementAlgorithm,
  KeyDerivationScheme as DwnKeyDerivationScheme,
  PermissionGrant as DwnPermissionGrant,
  PermissionRequest as DwnPermissionRequest,
  PermissionsProtocol as DwnPermissionsProtocol,
} from '@enbox/dwn-sdk-js';

// Type-only re-exports (interfaces, type aliases)
export type {
  ConnectSessionMetadata,
  ConnectSessionTransport,
  DataEncodedRecordsWriteMessage as DwnDataEncodedRecordsWriteMessage,
  MessageSigner as DwnSigner,
  MessageSubscription as DwnMessageSubscription,
  MessagesPermissionScope as DwnMessagesPermissionScope,
  PaginationCursor as DwnPaginationCursor,
  PermissionConditions as DwnPermissionConditions,
  PermissionGrantData as DwnPermissionGrantData,
  PermissionRequestData as DwnPermissionRequestData,
  PermissionScope as DwnPermissionScope,
  ProtocolDefinition as DwnProtocolDefinition,
  ProtocolPermissionScope as DwnProtocolPermissionScope,
  PublicKeyJwk as DwnPublicKeyJwk,
  RecordsPermissionScope as DwnRecordsPermissionScope,
  SubscriptionListener as DwnSubscriptionListener,
  SubscriptionMessage as DwnSubscriptionMessage,
} from '@enbox/dwn-sdk-js';
