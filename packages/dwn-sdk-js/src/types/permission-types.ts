import type { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

/**
 * Metadata describing the connect approval session that created a permission grant.
 *
 * Wallets use this to group grants into user-facing app sessions and to
 * distinguish active sessions from expired permission bundles. App and client
 * fields are self-reported by the requester, unauthenticated, and intended for
 * display only. Consumers must not treat them as verified app identity.
 */
export type ConnectSessionMetadata = {
  /** Stable session ID shared by all grants created by one connect approval. */
  id: string;

  /** Human-readable app name shown during approval. Self-reported display data. */
  appName?: string;

  /** App icon URL shown during approval. Self-reported display data. */
  appIcon?: string;

  /** Origin of the requesting app, when known. Self-reported display data. */
  origin?: string;

  /** User agent string captured by the connect client, when available. Display data only. */
  userAgent?: string;

  /** Platform/device hint captured by the connect client, when available. */
  platform?: string;

  /** Primary browser language captured by the connect client, when available. */
  language?: string;

  /** Browser language preferences captured by the connect client, when available. */
  languages?: string[];

  /** IANA timezone captured by the connect client, when available. */
  timezone?: string;

  /** Connect transport that created the session. */
  transport?: ConnectSessionTransport;

  /** Timestamp when the wallet approved the connect session. */
  createdAt: string;

  /**
   * Display timestamp for when the connect session expires.
   *
   * The enforcing value is the enclosing permission grant's `dateExpires`.
   * Consumers must use `dateExpires`, not this metadata field, for any
   * authorization or security decision.
   */
  expiresAt: string;
};

/** Connect transport that created a connect session. */
export type ConnectSessionTransport = 'relay' | 'postMessage';

/**
 * Type for the data payload of a permission request message.
 */
export type PermissionRequestData = {

  /**
   * If the grant is a delegated grant or not. If `true`, the `grantedTo` will be able to act as the `grantedBy` within the scope of this grant.
   */
  delegated: boolean;

  /**
   * Optional string that communicates what the grant would be used for.
   */
  description?: string;

  /**
   * The scope of the allowed access.
   */
  scope: PermissionScope;

  conditions?: PermissionConditions
};

/**
 * Type for the data payload of a permission grant message.
 */
export type PermissionGrantData = {
  /**
   * Optional string that communicates what the grant would be used for
   */
  description?: string;

  /**
   * Optional CID of a permission request. This is optional because grants may be given without being officially requested
   * */
  requestId?: string;

  /**
   * Timestamp at which this grant will no longer be active.
   */
  dateExpires: string;

  /**
   * Whether this grant is delegated or not. If `true`, the `grantedTo` will be able to act as the `grantedTo` within the scope of this grant.
   */
  delegated?: boolean;

  /**
   * The scope of the allowed access.
   */
  scope: PermissionScope;

  conditions?: PermissionConditions;

  /** Optional metadata for the connect session that created this grant. */
  connectSession?: ConnectSessionMetadata;
};

/**
 * Type for the data payload of a permission revocation message.
 */
export type PermissionRevocationData = {
  /**
   * Optional string that communicates the details of the revocation.
   */
  description?: string;
};

/**
 * The data model for a permission scope.
 */
export type PermissionScope = ProtocolPermissionScope | MessagesPermissionScope | RecordsPermissionScope;

export type ProtocolPermissionScope = {
  interface: DwnInterfaceName.Protocols;
  method: DwnMethodName.Configure | DwnMethodName.Query;
  protocol?: string;
};

/**
 * Permission scope for the Messages interface.
 *
 * `Read` is the only valid method and acts as a unified scope that authorizes
 * `MessagesRead`, `MessagesQuery`, and `MessagesSubscribe` operations.
 * Context- and path-scoped grants expose matching signed messages and metadata,
 * but not record payload bytes or protocol-support messages.
 */
export type MessagesPermissionScope = {
  interface: DwnInterfaceName.Messages;
  method: DwnMethodName.Read;
  protocol?: string;
  /** May only be present when `protocol` is defined and `protocolPath` is undefined */
  contextId?: string;
  /** May only be present when `protocol` is defined and `contextId` is undefined */
  protocolPath?: string;
};

/**
 * The data model for a permission scope that is specific to the Records interface.
 *
 * `Read` is the only valid read-like Records permission scope and authorizes
 * `RecordsRead`, `RecordsQuery`, `RecordsSubscribe`, and `RecordsCount` operations.
 */
export type RecordsPermissionScope = {
  interface: DwnInterfaceName.Records;
  method: DwnMethodName.Read | DwnMethodName.Write | DwnMethodName.Delete;
  protocol: string;
  /** May only be present when `protocol` is defined and `protocolPath` is undefined */
  contextId?: string;
  /** May only be present when `protocol` is defined and `contextId` is undefined */
  protocolPath?: string;
};

export enum PermissionConditionPublication {
  Required = 'Required',
  Prohibited = 'Prohibited',
}

export type PermissionConditions = {
  /**
   * indicates whether a message written with the invocation of a permission must, may, or must not
   * be marked as public.
   * If `undefined`, it is optional to make the message public.
   */
  publication?: PermissionConditionPublication;
};
