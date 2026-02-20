import type { PublicKeyJwk } from './jose-types.js';
import type { AuthorizationModel, GenericMessage, GenericMessageReply } from './message-types.js';
import type { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export type ProtocolsConfigureDescriptor = {
  interface : DwnInterfaceName.Protocols;
  method: DwnMethodName.Configure;
  messageTimestamp: string;
  definition: ProtocolDefinition;
  permissionGrantId?: string;
};

export type ProtocolDefinition = {
  protocol: string;
  /**
   * Denotes if this Protocol Definition can be returned by unauthenticated or unauthorized `ProtocolsQuery`.
   */
  published: boolean;

  /**
   * Maps alias names to external protocol URIs that this protocol composes with.
   * Each alias can be used in `$ref` values and cross-protocol `role`/`of` references
   * using the `alias:path` syntax.
   *
   * Example:
   * ```
   * "uses": { "threads": "https://threads.example.com" }
   * ```
   */
  uses?: ProtocolUses;

  types: ProtocolTypes;
  structure: {
    [key: string]: ProtocolRuleSet;
  }
};

/**
 * Maps alias names to external protocol URIs for composition.
 */
export type ProtocolUses = {
  [alias: string]: string;
};

export type ProtocolType = {
  schema?: string,
  dataFormats?: string[],

  /**
   * When `true`, records of this type **must** be encrypted at the DWN record
   * level using the tenant's ProtocolPath-derived encryption key. The tenant
   * DID must have a secp256k1 keyAgreement key; protocol installation will
   * fail if it does not.
   *
   * When `false` or omitted, encryption is not required for this type.
   */
  encryptionRequired?: boolean,
};

export type ProtocolTypes = {
  [key: string]: ProtocolType;
};

export enum ProtocolActor {
  Anyone = 'anyone',
  Author = 'author',
  Recipient = 'recipient'
}

export enum ProtocolAction {
  CoDelete = 'co-delete',
  CoPrune = 'co-prune',
  CoUpdate = 'co-update',
  Create = 'create',
  Delete = 'delete',
  Prune = 'prune',
  Read = 'read',
  Update = 'update'
}

/**
 * Rules defining which actors may access a record at the given protocol path.
 * Rules take three forms, e.g.:
 * 1. Anyone can create.
 *   {
 *     who: 'anyone',
 *     can: ['create']
 *   }
 *
 * 2. Author of protocolPath can create; OR
 *    Recipient of protocolPath can write.
 *   {
 *     who: 'recipient'
 *     of: 'requestForQuote',
 *     can: ['create']
 *   }
 *
 * 3. Role can create.
 *   {
 *     role: 'friend',
 *     can: ['create']
 *   }
 */
export type ProtocolActionRule = {
  /**
   * May be 'anyone' | 'author' | 'recipient'.
   * If `who` === 'anyone', then `of` must be omitted. Otherwise `of` must be present.
   * Mutually exclusive with `role`.
   *
   * Accepts both enum values (`ProtocolActor.Anyone`) and string literals (`'anyone'`).
   */
  who?: ProtocolActor | `${ProtocolActor}` | (string & {});

  /**
   * The protocol path of a role record type marked with $role: true.
   * Mutually exclusive with `who`
   */
  role?: string;

  /**
   * Protocol path.
   * Must be present if `who` === 'author' or 'recipient'
   */
  of?: string;

  /**
   * Array of actions that the actor/role can perform.
   * See {ProtocolAction} for possible values.
   * 'read' authorizes read, query, and subscribe access.
   */
  can: (ProtocolAction | `${ProtocolAction}` | (string & {}))[];
};
/**
 * Config for protocol-path encryption scheme.
 */
export type ProtocolPathEncryption = {

  /**
   * The ID of the root key that derives the public key at this protocol path for encrypting the symmetric key used for data encryption.
   */
  rootKeyId: string;

  /**
   * Public key for encrypting the symmetric key used for data encryption.
   */
  publicKeyJwk: PublicKeyJwk;
};

/**
 * Size constraints for records at a given protocol path.
 */
export type ProtocolSizeDefinition = {
  min?: number;
  max?: number;
};

/**
 * Tag rules for records at a given protocol path. Each non-`$`-prefixed property
 * is a JSON Schema object constraining that tag's value.
 */
export type ProtocolTagsDefinition = {
  /** Array of tag names that must be present on every record. */
  $requiredTags?: string[];
  /** When `false` (default), only tags explicitly listed are allowed. */
  $allowUndefinedTags?: boolean;
  /** JSON Schema definitions for individual tags. */
  [tag: string]: ProtocolTagSchema | string[] | boolean | undefined;
};

/**
 * A JSON Schema object constraining a single tag value.
 * Supports the subset of JSON Schema used by DWN tag validation.
 */
export type ProtocolTagSchema = {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  items?: { type: 'string' | 'number' | 'integer' };
  contains?: { type: 'string' | 'number' | 'integer' };
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minContains?: number;
  maxContains?: number;
};

/**
 * Union of all value types that can appear as properties of a `ProtocolRuleSet`.
 * This includes:
 * - `$`-prefixed directive values (`$encryption`, `$actions`, `$role`, `$ref`, `$size`, `$tags`)
 * - Child `ProtocolRuleSet` entries (non-`$` keys)
 */
type ProtocolRuleSetValue =
  | ProtocolRuleSet
  | ProtocolActionRule[]
  | ProtocolPathEncryption
  | ProtocolTagsDefinition
  | ProtocolSizeDefinition
  | boolean
  | string
  | undefined;

export type ProtocolRuleSet = {
  /**
   * Encryption setting for objects that are in this protocol path.
   */
  $encryption?: ProtocolPathEncryption;
  $actions?: ProtocolActionRule[];

  /**
   * If true, this marks a record as a `role` that may used within a context.
   * The recipient of a $role record may invoke their role by setting `protocolRole` property to the protocol path of the $role record.
   */
  $role?: boolean;

  /**
   * References a type from an external protocol declared in `uses`.
   * Format: `"alias:typePath"` where `alias` is a key in the protocol definition's `uses` map
   * and `typePath` is the protocol path of the type in the external protocol's structure.
   *
   * A `$ref` node is a pure attachment point — it must NOT have `$actions`, `$role`, `$size`,
   * `$tags`, or `$encryption`. Authorization for the referenced type is governed by its own
   * protocol. Only children defined under the `$ref` node get `$actions` from the composing protocol.
   *
   * Example:
   * ```
   * "thread": {
   *   "$ref": "threads:thread",
   *   "comment": { "$actions": [{ "who": "anyone", "can": ["create", "read"] }] }
   * }
   * ```
   */
  $ref?: string;

  /**
   * If $size is set, the record size in bytes must be within the limits.
   */
  $size?: ProtocolSizeDefinition;

  /**
   * If $tags is set, the record must conform to the tag rules.
   */
  $tags?: ProtocolTagsDefinition;

  /**
   * Non-`$`-prefixed keys are nested child `ProtocolRuleSet` entries.
   * At runtime, JSON Schema validation ensures only valid child rule sets appear here.
   */
  [key: string]: ProtocolRuleSetValue;
};

export type ProtocolsConfigureMessage = GenericMessage & {
  authorization: AuthorizationModel; // overriding `GenericMessage` with `authorization` being required
  descriptor: ProtocolsConfigureDescriptor;
};

export type ProtocolsQueryFilter = {
  protocol: string,
};

export type ProtocolsQueryDescriptor = {
  interface : DwnInterfaceName.Protocols,
  method: DwnMethodName.Query;
  messageTimestamp: string;
  filter?: ProtocolsQueryFilter;
  permissionGrantId?: string;
};

export type ProtocolsQueryMessage = GenericMessage & {
  descriptor: ProtocolsQueryDescriptor;
};

export type ProtocolsQueryReply = GenericMessageReply & {
  entries?: ProtocolsConfigureMessage[];
};
