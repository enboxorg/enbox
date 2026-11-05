import type { PublicKeyJwk } from './jose-types.js';
import type { AuthorizationModel, GenericMessage, GenericMessageReply } from './message-types.js';
import type { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export type ModulesConfigureDescriptor = {
  interface : DwnInterfaceName.Modules;
  method: DwnMethodName.Configure;
  messageTimestamp: string;
  definition: ModuleDefinition;
  permissionGrantId?: string;
};

export type ModuleDefinition = {
  module: string;
  $keyAgreement?: ModuleKeyAgreement;
  /**
   * Denotes if this Module Definition can be returned by unauthenticated or unauthorized `ModulesQuery`.
   */
  published: boolean;

  /**
   * Maps alias names to external module URIs that this module composes with.
   * Each alias can be used in `$ref` values and cross-module `role`/`of` references
   * using the `alias:path` syntax.
   *
   * Example:
   * ```
   * "uses": { "threads": "https://threads.example.com" }
   * ```
   */
  uses?: ModuleUses;

  types: ModuleTypes;
  structure: {
    [key: string]: ModuleRuleSet;
  }
};

/**
 * Maps alias names to external module URIs for composition.
 */
export type ModuleUses = {
  [alias: string]: string;
};

export type ModuleType = {
  schema?: string,
  dataFormats?: string[],

  /**
   * When `true`, records of this type **must** be encrypted at the DWN record
   * level using the tenant's ModulePath-derived encryption key. The tenant
   * DID must have an X25519 keyAgreement key; module installation will
   * fail if it does not.
   *
   * When `false` or omitted, records of this type **must** be plaintext at the
   * DWN record level. Applications cannot override this module policy per write.
   */
  encryptionRequired?: boolean,
};

export type ModuleTypes = {
  [key: string]: ModuleType;
};

export enum ModuleActor {
  Anyone = 'anyone',
  Author = 'author',
  Recipient = 'recipient'
}

export enum ModuleAction {
  CoDelete = 'co-delete',
  CoPrune = 'co-prune',
  CoUpdate = 'co-update',
  Create = 'create',
  Delete = 'delete',
  Prune = 'prune',
  Read = 'read',
  Squash = 'squash',
  Update = 'update'
}

/**
 * Rules defining which actors may access a record at the given module path.
 * Rules take three forms, e.g.:
 * 1. Anyone can create.
 *   {
 *     who: 'anyone',
 *     can: ['create']
 *   }
 *
 * 2. Author of modulePath can create; OR
 *    Recipient of modulePath can write.
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
export type ModuleActionRule = {
  /**
   * May be 'anyone' | 'author' | 'recipient'.
   * If `who` === 'anyone', then `of` must be omitted. Otherwise `of` must be present.
   * Mutually exclusive with `role`.
   *
   * Accepts both enum values (`ModuleActor.Anyone`) and string literals (`'anyone'`).
   */
  who?: ModuleActor | `${ModuleActor}` | (string & {});

  /**
   * The module path of a role record type marked with $role: true.
   * Mutually exclusive with `who`
   */
  role?: string;

  /**
   * Module path.
   * Must be present if `who` === 'author' or 'recipient'
   */
  of?: string;

  /**
   * Array of actions that the actor/role can perform.
   * See {ModuleAction} for possible values.
   * 'read' authorizes read, query, and subscribe access.
   */
  can: (ModuleAction | `${ModuleAction}` | (string & {}))[];
};
/**
 * Public key used for module-path content encryption.
 */
export type ModuleKeyAgreement = {
  publicKeyJwk: PublicKeyJwk;
};

/**
 * Size constraints for records at a given module path.
 */
export type ModuleSizeDefinition = {
  min?: number;
  max?: number;
};

/**
 * Limits the visible records at a given module path within the same parent context.
 *
 * Root-level records form one group for the module path. Nested records are grouped by
 * direct parent context. Occupants are selected deterministically at read time; valid writes
 * outside the visible population remain stored and may become visible later.
 */
export type ModuleRecordLimitDefinition = {
  /** Maximum number of visible records at this path within the same parent context. Must be >= 1. */
  max: number;
};

/**
 * Delivery strategy for records at a given module path.
 * Controls how a DWN server proactively distributes records to participants' DWN endpoints.
 *
 * - `'direct'`    — The origin DWN pushes new records to all participants' DWN endpoints.
 *                    Best for small participant sets (2–50).
 * - `'subscribe'` — Participant providers establish `RecordsSubscribe` connections to the
 *                    origin DWN. Best for asymmetric fan-out or unbounded audiences.
 */
export type ModuleDeliveryStrategy = 'direct' | 'subscribe';

/**
 * Tag rules for records at a given module path. Each non-`$`-prefixed property
 * is a JSON Schema object constraining that tag's value.
 */
export type ModuleTagsDefinition = {
  /** Array of tag names that must be present on every record. */
  $requiredTags?: string[];
  /** When `false` (default), only tags explicitly listed are allowed. */
  $allowUndefinedTags?: boolean;
  /** JSON Schema definitions for individual tags. */
  [tag: string]: ModuleTagSchema | string[] | boolean | undefined;
};

/**
 * A JSON Schema object constraining a single tag value.
 * Supports the subset of JSON Schema used by DWN tag validation.
 */
export type ModuleTagSchema = {
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
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minContains?: number;
  maxContains?: number;
};

/**
 * Union of all value types that can appear as properties of a `ModuleRuleSet`.
 * This includes:
 * - `$`-prefixed directive values (`$keyAgreement`, `$actions`, `$role`, `$ref`, `$size`, `$tags`, `$delivery`)
 * - Child `ModuleRuleSet` entries (non-`$` keys)
 */
type ModuleRuleSetValue =
  | ModuleRuleSet
  | ModuleActionRule[]
  | ModuleKeyAgreement
  | ModuleTagsDefinition
  | ModuleSizeDefinition
  | ModuleRecordLimitDefinition
  // `ModuleDeliveryStrategy` ('direct' | 'subscribe') is intentionally omitted here: its
  // values are already covered by the `string` member below (see the `$delivery` field typing).
  | boolean
  | string
  | undefined;

export type ModuleRuleSet = {
  /**
   * Key agreement setting for records at this module path.
   */
  $keyAgreement?: ModuleKeyAgreement;
  /**
   * Authorization rules for this path. Direct-child role rules granting `read`
   * also declare context-following preference in array order, as returned by
   * `resolveModuleContextRoles`. This does not change authorization evaluation
   * or imply role inheritance; object property order has no meaning.
   */
  $actions?: ModuleActionRule[];

  /**
   * If true, this marks a record as a `role`. Root roles apply within their tenant;
   * nested roles apply within their resolved physical parent context.
   * Recipients invoke a role using its local path or an explicit `alias:path` in `moduleRole`.
   * Role assignments must be issued by an authorized actor; their action rules cannot grant `create` or `squash` to `anyone`.
   * A role path cannot use `$recordLimit`, because hidden records must never remain authorization capabilities.
   */
  $role?: boolean;

  /**
   * Attaches local child records to a record path in a module declared in `uses`.
   * Format: `"alias:typePath"` where `alias` is a key in the module definition's `uses` map
   * and `typePath` is the module path of the type in the external module's structure.
   *
   * The attachment must be a root structure node with at least one local child.
   * Its target may be deep or resolve through another attachment. No record can be
   * written at the attachment itself. Explicit `$actions` do not grant authority over
   * the provider record or flow into children; each local child declares its own rules.
   * Record policy overrides such as `$role`, `$size`, `$tags`, and `$keyAgreement` are forbidden.
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
  $size?: ModuleSizeDefinition;

  /**
   * If $tags is set, the record must conform to the tag rules.
   */
  $tags?: ModuleTagsDefinition;

  /**
   * If `$recordLimit` is set, reads expose at most `max` records at this module path
   * within each direct parent context. `$recordLimit` cannot be used on a `$role` path.
   */
  $recordLimit?: ModuleRecordLimitDefinition;

  /**
   * If `$immutable` is `true`, records at this module path are write-once: they can be
   * created but never updated after the initial write. `RecordsDelete` is still governed
   * by `$actions` — immutability means the record's data cannot change, not that it
   * cannot be removed.
   */
  $immutable?: boolean;

  /**
   * Delivery strategy hint for records at this module path.
   * When set, the DWN server SHOULD proactively deliver records to participants' DWN endpoints.
   *
   * - `'direct'`    — Origin DWN pushes to all participant DWN endpoints upon receipt.
   * - `'subscribe'` — Participant providers subscribe to the origin DWN via `RecordsSubscribe`.
   */
  $delivery?: ModuleDeliveryStrategy;

  /**
   * If `$squash` is `true`, enables squash writes at this module path.
   * A squash write is a `RecordsWrite` with `squash: true` in the descriptor that
   * atomically creates a new record (the snapshot) and deletes all sibling records
   * at the same module path within the same parent context that have a
   * `messageTimestamp` strictly older than the squash record's `messageTimestamp`.
   * When the path has an explicit `squash` action, only a matching `squash` rule
   * authorizes the write. Without one, `create` authorization is the fallback.
   */
  $squash?: boolean;

  /**
   * Non-`$`-prefixed keys are nested child `ModuleRuleSet` entries.
   * At runtime, JSON Schema validation ensures only valid child rule sets appear here.
   */
  [key: string]: ModuleRuleSetValue;
};

export type ModulesConfigureMessage = GenericMessage & {
  authorization: AuthorizationModel; // overriding `GenericMessage` with `authorization` being required
  descriptor: ModulesConfigureDescriptor;
};

export type ModulesQueryFilter = {
  module: string,
};

export type ModulesQueryDescriptor = {
  interface : DwnInterfaceName.Modules,
  method: DwnMethodName.Query;
  messageTimestamp: string;
  filter?: ModulesQueryFilter;
  permissionGrantId?: string;
};

export type ModulesQueryMessage = GenericMessage & {
  descriptor: ModulesQueryDescriptor;
};

export type ModulesQueryReply = GenericMessageReply & {
  entries?: ModulesConfigureMessage[];
};
