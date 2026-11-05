/**
 * A module-scoped API returned by {@link Enbox.using}.
 *
 * `TypedEnbox` is the **primary developer interface** for interacting with
 * module-backed records. It auto-injects the module URI, modulePath,
 * and schema into every operation, and provides compile-time path
 * autocompletion plus typed application values via runtime codecs.
 *
 * Record-returning methods preserve the module payload type on the canonical
 * {@link Record} class so type information flows through reads, queries, and
 * updates without a second runtime wrapper.
 *
 * @example
 * ```ts
 * const threads = enbox.using(ThreadsModule);
 *
 * // Create — path and data type are checked at compile time
 * const record = await threads.records.create('thread', {
 *   data: { title: 'Hello World', body: '...' },
 * });
 * // record is Record<ThreadData>
 *
 * const data = await record.value(); // ThreadData — no cast needed
 *
 * // Query — module and modulePath are auto-injected
 * const { records } = await threads.records.query('thread');
 * // records is Record<ThreadData>[]
 * ```
 */

import type { ContextFollowRecord } from './context-following.js';
import type { ContextView } from './context-view.js';
import type { MaterializedMemberContext as MaterializedMemberContextRow } from './materialized-member-context-view.js';
import type { Module } from './module.js';
import type {
  AudienceKeyDeliveryOutcome,
  DwnPaginationCursor,
  DwnPublicKeyJwk,
  DwnResponseStatus,
  FollowedSyncSource,
  SyncEngine,
} from '@enbox/agent';
import type { ContextFollowIntent, ContextInvitationPreview } from './shared-context-module.js';
import type {
  ContextRolePath,
  ContextRolesAtPath,
  ContextRootPath,
  DirectSingletonChildPaths,
  ModulePaths,
  ModuleRolePaths,
  SingletonModulePaths,
  SquashModulePaths,
  TypedModule,
  TypeNameAtPath,
} from './module-types.js';
import type { DwnApi, ModulesConfigureResponse } from './dwn-api.js';
import type { ExpandableRecordView, RecordView } from './record-view.js';
import type { MaterializedRecord, Record, RecordPatch } from './record.js';
import type { ModuleDefinition, RecordsFilter, ResolvedModuleGraph, ResolvedModuleNode } from '@enbox/dwn-sdk-js';
import type { ModuleDependencies, ModuleDependency } from './module-types.js';
import type { RecordCodec, RecordCodecMap, RecordCodecValue } from './record-codec.js';
import type { RecordDeleteParams, RecordUpdateParams } from './record-types.js';
import type { RecordFilter, RecordQuery } from './record-query.js';

import { ContextFollowing } from './context-following.js';
import { createContextView } from './context-view.js';
import { createMaterializedMemberContextView } from './materialized-member-context-view.js';
import { Did } from '@enbox/dids';
import { followedContextChangeRetiresSource } from './followed-context-lifecycle.js';
import { installedModuleDefinitionsEqual } from './module-definition-utils.js';
import { mergeRecordPatch } from './record-patch.js';
import { RecordConflictError } from './record-conflict-error.js';
import { removeUndefinedProperties } from '@enbox/common';
import { resolveTypedModuleGraph } from './define-module.js';
import { assertValidRecordWithin, compileRecordFilter, compileRecordQuery, isValidRecordContextId, resolveRecordQueryNode } from './record-query.js';
import {
  authoredModuleDefinitionsEqual,
  DateSort,
  getRuleSetAtPath,
  getTypeName,
  Modules,
  preloadModuleDefinitions,
  resolveModuleContextRoles,
  resolveModuleGraph,
  resolveModuleRoleContextScope,
  Time,
  validateImportedModuleContracts,
} from '@enbox/dwn-sdk-js';
import { bindRecordCodec, encodeRecordValue, RecordValidationError } from './record-codec.js';
import { collectModulePaths, hasManagedSharedContext, isModuleRolePath } from './module-paths.js';
import { combineAbortSignals, whileSignalsActive } from './view-opening.js';
import {
  CONTEXT_FOLLOW_PATH,
  CONTEXT_INVITATION_PATH,
  contextFollowCodec,
  contextInvitationCodec,
  moduleContextKey,
} from './shared-context-module.js';
import { ContextNotReadyError, ContextRetiredError } from './context-errors.js';
import { createExpandableRecordView, createRecordView } from './record-view.js';
import { DwnResponseError, isCanonicalConflictStatus, requireDwnSuccess } from './dwn-response-error.js';
import { FollowedSourceNotReadyError, followedSyncSourceActiveEqual } from '@enbox/agent';

const INITIAL_SUBSCRIPTION_OVERLAP_LIMIT = 1_000;
const INITIAL_SUBSCRIPTION_PAGE_LIMIT = 100;
const CONTEXT_FOLLOW_QUERY = {
  dateSort   : DateSort.CreatedDescending,
  pagination : { limit: 100 },
};

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/**
 * Resolves the TypeScript data type for a given module path.
 *
 * The value is inferred from the runtime codec declared for the type name at
 * the given path.
 */
export type DataForPath<
  C extends RecordCodecMap,
  Path extends string,
> = TypeNameAtPath<Path> extends keyof C ? RecordCodecValue<C[TypeNameAtPath<Path>]> : never;

/** A patch or a side-effect-free producer that derives one from the latest value. */
export type RecordPatchInput<T> = [RecordPatch<T>] extends [never]
  ? never
  : RecordPatch<T> | (
    (current: T) => RecordPatch<T> | undefined | Promise<RecordPatch<T> | undefined>
  );

type TypedRecordReadResult<T> = {
  record: TypedRecord<T> | undefined;
  tombstonePrune?: boolean;
};

/** A module-bound record with coordinates guaranteed by its typed selection. */
export interface TypedRecord<T = unknown> extends Record<T> {
  readonly contextId: string;
  readonly module: string;
  readonly modulePath: string;

  /** Mutate and return this same module-refined handle. */
  update(params: RecordUpdateParams<T>): Promise<this>;
}

/** A typed module record paired with its decoded application value. */
export type TypedMaterializedRecord<T = unknown> = MaterializedRecord<T, TypedRecord<T>>;

/** Update fields available on a record whose context, role, and target are already bound. */
export type ContextRecordUpdateParams<T = unknown> = Pick<
  RecordUpdateParams<T>,
  'data' | 'datePublished' | 'published' | 'tags' | 'timestamp'
>;

/** Delete fields available on a record whose context, role, and target are already bound. */
export type ContextRecordDeleteParams = Pick<RecordDeleteParams, 'prune' | 'timestamp'>;

/**
 * Application-facing record handle for one bound context.
 *
 * The runtime remains the canonical {@link Record}; routing, import, signing,
 * and raw-message controls are hidden because the context owns them.
 */
export type ContextRecord<T = unknown> = Pick<
  Record<T>,
  | 'author'
  | 'creator'
  | 'data'
  | 'dataCid'
  | 'dataFormat'
  | 'dataSize'
  | 'dateCreated'
  | 'datePublished'
  | 'deleted'
  | 'id'
  | 'parentId'
  | 'published'
  | 'recipient'
  | 'tags'
  | 'timestamp'
  | 'value'
> & {
  readonly contextId: string;
  readonly module: string;
  readonly modulePath: string;
  readonly squash: boolean;
  delete(params?: ContextRecordDeleteParams): Promise<void>;
  update(params: ContextRecordUpdateParams<T>): Promise<ContextRecord<T>>;
};

/** A context-bound record handle paired with its decoded application value. */
export type ContextMaterializedRecord<T = unknown> = MaterializedRecord<T, ContextRecord<T>>;

type RecordHandle<T, ContextBound extends boolean> = ContextBound extends true
  ? ContextRecord<T>
  : TypedRecord<T>;

type MaterializedRecordHandle<T, ContextBound extends boolean> = ContextBound extends true
  ? ContextMaterializedRecord<T>
  : TypedMaterializedRecord<T>;

/** One page returned by a typed records query. */
export type RecordPage<Item = Record> = AsyncIterable<Item> & {
  /** Matching records in the representation selected by the query. */
  records: Item[];

  /** Fetch the next page of the same canonical query, or `undefined` at the end. */
  next(): Promise<RecordPage<Item> | undefined>;
};

/** One path-discriminated typed record change or terminal subscription error. */
export type RecordSubscriptionEvent<
  Path extends string = string,
  Item = Record,
> = Readonly<
  | { path: Path; record: Item; type: 'write' | 'delete' }
  | { type: 'error'; error: Error }
>;

/** Callback invoked for one typed record subscription. Rejecting closes the subscription. */
export type RecordSubscriptionListener<
  Path extends string = string,
  Item = Record,
> = (event: RecordSubscriptionEvent<Path, Item>) => void | Promise<void>;

type TypedRecordSubscriptionEvent<
  C extends RecordCodecMap,
  Paths extends string,
  ContextBound extends boolean,
> = {
  [Path in Paths]: RecordSubscriptionEvent<
    Path,
    RecordHandle<DataForPath<C, Path>, ContextBound>
  >;
}[Paths];

type TypedRecordSubscriptionListener<
  C extends RecordCodecMap,
  Paths extends string,
  ContextBound extends boolean,
> = (event: TypedRecordSubscriptionEvent<C, Paths, ContextBound>) => void | Promise<void>;

type TypedRecordChangeEvent<
  C extends RecordCodecMap,
  Paths extends string,
  ContextBound extends boolean,
> = Exclude<TypedRecordSubscriptionEvent<C, Paths, ContextBound>, { type: 'error' }>;

type RecordSubscriptionSelection<Path extends string> = Path | readonly Path[];

type RecordSubscriptionOptions = Readonly<{
  /** Abort this subscription without closing the typed API or bound context. */
  signal?: AbortSignal;
}>;

type InitialRecordSubscriptionOptions = RecordSubscriptionOptions & Readonly<{
  /** Replay each selected context path oldest-first before switching to live delivery. */
  initial: true;
}>;

type SelectedSubscriptionPaths<Selection, Path extends string = string> = Selection extends Path
  ? Selection
  : Selection extends readonly (infer Selected extends Path)[] ? Selected : never;

type TypedRecordsSubscribeArguments<
  C extends RecordCodecMap,
  Paths extends string,
  ContextBound extends boolean,
> = ContextBound extends true
  ? | [listener: TypedRecordSubscriptionListener<C, Paths, ContextBound>]
    | [options: RecordSubscriptionOptions, listener: TypedRecordSubscriptionListener<C, Paths, ContextBound>]
    | [options: InitialRecordSubscriptionOptions, listener: TypedRecordSubscriptionListener<C, Paths, ContextBound>]
  : | [listener: TypedRecordSubscriptionListener<C, Paths, ContextBound>]
    | [options: RecordSubscriptionOptions, listener: TypedRecordSubscriptionListener<C, Paths, ContextBound>];

type ModuleSubscriptionPaths<D extends ModuleDefinition, Selection> = SelectedSubscriptionPaths<
  Selection,
  ModulePaths<D> & string
>;

type TypedRecordsSubscribe<
  C extends RecordCodecMap,
  Path extends string,
  ContextBound extends boolean = false,
> = <const Selection extends RecordSubscriptionSelection<Path>>(
  selection: Selection,
  ...args: TypedRecordsSubscribeArguments<
    C,
    SelectedSubscriptionPaths<Selection, Path>,
    ContextBound
  >
) => Promise<RecordSubscription>;

/** Closeable typed record change subscription. */
export interface RecordSubscription {
  /** Stop future delivery. A rejected listener also closes the subscription. */
  close(): Promise<void>;
}

/** Materialization requested from a typed records query or observed view. */
export type RecordMaterialization<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
> = true | {
  /** Exact direct-child paths to materialize beside every parent record. */
  children: readonly DirectSingletonChildPaths<D, Path>[];
};

type SelectedMaterializedChildPaths<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends RecordMaterialization<D, Path>,
> = Materialization extends { children: readonly (infer ChildPath)[] }
  ? Extract<ChildPath, DirectSingletonChildPaths<D, Path>>
  : never;

/** Materialized singleton children exposed for one module path. */
type MaterializedChildren<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Path extends ModulePaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> = true,
  ContextBound extends boolean = false,
> = {
  readonly [ChildPath in SelectedMaterializedChildPaths<D, Path, Materialization>
    as TypeNameAtPath<ChildPath>]: MaterializedRecordHandle<DataForPath<C, ChildPath>, ContextBound> | undefined;
};

/** Materialized representation of one typed module record. */
type MaterializedRecordForPath<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Path extends ModulePaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> = true,
  ContextBound extends boolean = false,
> = Materialization extends true
  ? MaterializedRecordHandle<DataForPath<C, Path>, ContextBound>
  : MaterializedRecordHandle<DataForPath<C, Path>, ContextBound> & Readonly<{
    children: Readonly<MaterializedChildren<D, C, Path, Materialization, ContextBound>>;
  }>;

/** Record handle or materialized value selected by a typed query or observed view. */
export type RecordRepresentation<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Path extends ModulePaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> | undefined = undefined,
  ContextBound extends boolean = false,
> = Materialization extends undefined
  ? RecordHandle<DataForPath<C, Path>, ContextBound>
  : MaterializedRecordForPath<D, C, Path, Exclude<Materialization, undefined>, ContextBound>;

type MaterializedRecordWithChildren<T> = TypedMaterializedRecord<T> & Readonly<{
  children: Readonly<globalThis.Record<string, TypedMaterializedRecord<unknown> | undefined>>;
}>;

type MaterializationSource = {
  from?: string;
  moduleRole?: string;
  within?: string;
};

type QueryRequest<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> | undefined,
  Query extends RecordQuery<D, Path>,
> = [Materialization] extends [undefined]
  ? Query & { materialize?: undefined }
  : Omit<Query, 'pagination'> & {
    materialize: Materialization;
    pagination: { limit: number };
  };

type TypedQueryRequest<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> | undefined,
> = QueryRequest<D, Path, Materialization, RecordQuery<D, Path>>;

type TypedQueryArguments<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> | undefined,
> = [Materialization] extends [undefined]
  ? [path: Path, request?: TypedQueryRequest<D, Path, Materialization>]
  : [path: Path, request: TypedQueryRequest<D, Path, Materialization>];

type ObserveRequest<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> | undefined,
  Query extends RecordQuery<D, Path>,
> = Omit<Query, 'pagination'> & {
  pagination: { limit: number };
  /** Abort this view without ending the owning typed API or bound context. */
  signal?: AbortSignal;
} & ([Materialization] extends [undefined]
  ? { materialize?: undefined }
  : { materialize: Materialization });

/** Bounded typed records selection accepted by `records.observe()`. */
export type RecordObserveRequest<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> | undefined = undefined,
> = ObserveRequest<D, Path, Materialization, RecordQuery<D, Path>>;

/** @internal Runtime resources owned by the Enbox session that created this typed API. */
type TypedEnboxOptions = {
  /** Shared installation bindings used when a module prepares its explicit providers. */
  dependencyApis?: Map<ModuleDependency, TypedEnbox>;
  /** An internal provider binding verifies imported contracts without overwriting compatible definitions. */
  dependency?: boolean;
  /** Tenant and root scope injected by an owner or member context. */
  context?: {
    contextId: string;
    modulePath: string;
    modulePaths: ReadonlySet<string>;
  };

  /** Session-owned role-delivery projection and retry operations. */
  roleDelivery?: {
    get(roleRecordId: string): Promise<RoleDeliveryState | undefined>;
    retry(roleRecordId: string): Promise<RoleDeliveryState | undefined>;
    subscribe(listener: () => void): () => void;
  };

  /** Session-lifetime signal; aborting it closes every view created by this instance. */
  signal?: AbortSignal;

  /** Sync currentness source. Omit for directly constructed, local-only typed APIs. */
  sync?: SyncEngine;
};

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

/**
 * Local, reconstructable delivery lifecycle state for one active encrypted role record.
 * `delivered` means the delivery write was accepted; it is not a recipient decryption receipt.
 */
export type RoleDeliveryState =
  | Readonly<{ state: 'delivered' }>
  | Readonly<{ state: 'pending'; reason?: string }>
  | Readonly<{ state: 'awaiting-recipient-install' | 'failed'; reason: string }>;

type ParentModulePath<Path extends string> = Path extends `${infer Head}/${infer Tail}`
  ? Tail extends `${string}/${string}` ? `${Head}/${ParentModulePath<Tail>}` : Head
  : never;

/** One pending, signed offer to follow a shared context. */
export type ContextInvitation<
  Context = unknown,
  Path extends string = string,
> = Readonly<{
  /** Opaque invitation identifier. */
  id: string;
  /** Authenticated creator of the invitation and expected context owner. */
  ownerDid: string;
  /** Shared context ID on the owner's tenant. */
  contextId: string;
  /** Module context root whose read rules determine the role preference. */
  path: Path;
  /** Small, non-sensitive application display metadata. */
  preview: ContextInvitationPreview;
  /** Signed record timestamp. */
  timestamp: string;
  /** Verify and follow the context, then attempt inbox cleanup. */
  accept(): Promise<Context>;
  /** Consume the invitation without changing owner-hosted membership. */
  dismiss(): Promise<void>;
}>;

/** Pending invitation discovery for one typed shared-context module. */
export type ContextInvitationsApi<
  Context = unknown,
  Path extends string = string,
> = Readonly<{
  list(options?: Readonly<{ limit?: number }>): Promise<ContextInvitation<Context, Path>[]>;
  observe(options?: Readonly<{ limit?: number; signal?: AbortSignal }>): Promise<
    RecordView<ContextInvitation<Context, Path>>
  >;
}>;

type ModuleContextInvitation<D extends ModuleDefinition, C extends RecordCodecMap> = ContextInvitation<
  MemberContext<D, C>,
  ContextRootPath<D>
>;

/** One application-facing member of an owned context. */
export type ContextMember<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Role extends ModulePaths<D> & string = ModulePaths<D> & string,
> = Role extends string ? Readonly<{
  data: DataForPath<C, Role>;
  delivery: RoleDeliveryState;
  did: string;
  role: Role;
}> : never;

type ContextMemberSetRequest<
  C extends RecordCodecMap,
  Role extends string,
> = Role extends string ? Readonly<{
  data: DataForPath<C, Role>;
  role: Role;
}> : never;

/** Owner operations for the alternative membership roles declared by one context root. */
export type ContextMembersApi<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Role extends ModulePaths<D> & string = ModulePaths<D> & string,
> = Readonly<{
  get(did: string): Promise<ContextMember<D, C, Role> | undefined>;
  list(): Promise<ContextMember<D, C, Role>[]>;
  /**
   * Observe the current preferred assignment for every member of this context.
   * Delivery is sampled whenever membership or delivery state rematerializes the view.
   */
  observe(options?: Readonly<{ signal?: AbortSignal }>): Promise<RecordView<ContextMember<D, C, Role>>>;
  remove(did: string): Promise<void>;
  /** Reconcile module-wide delivery, then return this member's current row. */
  retryDelivery(did: string): Promise<ContextMember<D, C, Role> | undefined>;
  /** Replace this recipient's membership assignment within the context's declared role list. */
  set<SelectedRole extends Role>(
    did: string,
    request: ContextMemberSetRequest<C, SelectedRole>,
  ): Promise<ContextMember<D, C, SelectedRole>>;
}>;

type ContextBase<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Root extends ModulePaths<D> & string = ModulePaths<D> & string,
> = {
  /** Context ID that bounds every record operation. */
  id: string;
  /** Collision-safe identity across owner tenants. */
  key: string;
  /** DID whose DWN owns the authoritative context. */
  ownerDid: string;
  /** Module path of this context's root record. */
  path: Root;
  /** Typed records API with this context's tenant and root scope already bound. */
  records: ContextRecordsApi<D, C, Root>;
  /** Record ID of the context root at `path`. */
  rootRecordId: string;
};

type MemberContextForRoot<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Role extends ContextRolePath<D>,
  Root extends ModulePaths<D> & string,
> = Root extends unknown
  ? Readonly<ContextBase<D, C, Root> & {
    access: 'member';
    /** Role path authorizing access to the context. */
    role: Role extends string ? ParentModulePath<Role> extends Root ? Role : never : never;
    /**
     * Withdraw this exact role record, then save a cross-device forget. Rejects for a retired handle.
     * If saving fails after withdrawal, contexts.forget({ ownerDid, id }) can finish the saved choice.
     */
    leave(): Promise<void>;
    /** Forget through this exact acceptance; stale handles are inert. Use contexts.forget() without a live handle. */
    forget(): Promise<void>;
    /**
     * Ensure the local replica is current, pulling once when needed and
     * throwing {@link ContextNotReadyError} when it cannot catch up.
     */
    refresh(): Promise<void>;
  }>
  : never;

/** A context owned by the connected identity, with membership operations when its root declares read roles. */
export type OwnedContext<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Root extends ModulePaths<D> & string = ModulePaths<D> & string,
> = Root extends unknown ? Readonly<
  ContextBase<D, C, Root> & { access: 'owner' } &
  ([ContextRolesAtPath<D, Root>] extends [never] ? {} : {
    members: ContextMembersApi<D, C, ContextRolesAtPath<D, Root>>;
    /** Send a signed discovery offer after membership has been established. */
    invite(did: string, request?: Readonly<{ preview?: ContextInvitationPreview }>): Promise<void>;
  })
> : never;

/** A member context authorized through one exact role record. */
export type MemberContext<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Role extends ContextRolePath<D> = ContextRolePath<D>,
> = MemberContextForRoot<
  D,
  C,
  Role,
  Extract<ParentModulePath<Role>, ModulePaths<D> & string>
>;

/** One owned or accepted member context in a module's local catalog. */
export type ModuleContext<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
> = OwnedContext<D, C, ContextRootPath<D>> | MemberContext<D, C>;

/** One accepted member context paired with its independently observed root state. */
export type MaterializedMemberContext<
  Context = MemberContext,
  Root = ContextMaterializedRecord,
> = MaterializedMemberContextRow<Context, Root>;

type SelectedMaterializedMemberContext<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Context = Extract<ModuleContext<D, C>, { access: 'member' }>,
> = Context extends { path: infer Path extends string }
  ? MaterializedMemberContext<Context, ContextMaterializedRecord<DataForPath<C, Path>>>
  : never;

type ContextObserve<D extends ModuleDefinition, C extends RecordCodecMap> = {
  (options: Readonly<{ access: 'member'; materializeRoot: true; signal?: AbortSignal }>):
  Promise<ContextView<SelectedMaterializedMemberContext<D, C>>>;
  (options?: Readonly<{ signal?: AbortSignal }>): Promise<ContextView<ModuleContext<D, C>>>;
};

/** Owner and canonical context ID identifying one saved following choice. */
export type ContextFollowTarget = Readonly<{ id: string; ownerDid: string }>;

type ContextFollow<D extends ModuleDefinition, C extends RecordCodecMap> = <Root extends ContextRootPath<D>>(
  path: Root,
  request: ContextFollowTarget,
) => Promise<MemberContext<D, C, ContextRolesAtPath<D, Root>>>;

/** Module-scoped owned-context access and accepted member-context lifecycle. */
export type ContextsApi<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
> = Readonly<{
  open<Root extends Exclude<ModulePaths<D> & string, ModuleRolePaths<D>>>(
    path: Root,
    id: string,
  ): Promise<OwnedContext<D, C, Root>>;
  /** Verify current remote authority and save encrypted recipient-owned following intent. Requires own-module write access. */
  follow: ContextFollow<D, C>;
  /**
   * Forget a saved choice, including unavailable contexts, without withdrawing membership.
   * Requires a shared-context session and own-module write access.
   * Rejects with TypeError when session sync storage or the managed journal is unavailable.
   */
  forget(request: ContextFollowTarget): Promise<void>;
  /** Restore known choices once, then list contexts. May wait for owner lookups; use observe() for nonblocking UI data. */
  list(): Promise<ModuleContext<D, C>[]>;
  /** Observe usable contexts and savedFollows; read the local journal before readiness and restore remote access in the background. */
  observe: ContextObserve<D, C>;
} & ([ContextRootPath<D>] extends [never] ? {} : {
  invitations: ContextInvitationsApi<MemberContext<D, C>, ContextRootPath<D>>;
})>;

/**
 * Options for {@link TypedEnbox} `records.create()`.
 *
 * The `data` field is type-checked against the module codec for the given
 * path.
 *
 * @typeParam C - The module's runtime codec map.
 * @typeParam Path - The module path string literal.
 *
 * @example
 * ```ts
 * await notebooks.records.create('notebook/page', {
 *   data: { title: 'My Page', body: '...' },       // type-checked as PageData
 *   parentContextId: notebook.contextId,             // link to parent
 *   tags: { category: 'draft' },
 * });
 * ```
 */
type TypedCreateOptions<
  C extends RecordCodecMap,
  Path extends string,
> = {
  /** The application value encoded by the codec for the given path. */
  data: DataForPath<C, Path>;

  /**
   * Optional DID of a remote DWN tenant to write the record to.
   *
   * When set, the create is dispatched to the specified tenant's remote DWN
   * (via the agent's `sendDwnRequest`, exactly like remote reads) instead of
   * the connected DID's local DWN — the cross-tenant write path. The author
   * stays the connected (grantee) DID, signing as themselves; the owner's
   * DWN authorizes the write via {@link TypedCreateRequest.moduleRole}
   * (role-invocation, e.g. a `collaborator` `$role` record naming the
   * author as `recipient`) or delegated-grant parameters. Encrypted types
   * are encrypted to the OWNER's published module keys — the agent
   * resolves the owner's remote definition automatically.
   *
   * The returned record captures remote data access so subsequent lazy reads
   * target the owner tenant.
   *
   * Remote-path boundaries:
   * - {@link TypedCreateRequest.recipientRolePublicKey} is NOT supported
   *   with `from` — the agent throws rather than silently ignoring the key.
   * - role-audience key delivery is a local-processing concern and is not
   *   available on remote writes.
   */
  from?: string;

  /**
   * The context ID of the parent record.
   *
   * Required when creating a child record under a parent in a hierarchical
   * module structure. Use the parent record's {@link Record.contextId | contextId}
   * as this value.
   *
   * @example
   * ```ts
   * const notebook = await notebooks.records.create('notebook', {
   *   data: { name: 'My Notebook' },
   * });
   *
   * // Create a page under the notebook
   * await notebooks.records.create('notebook/page', {
   *   data: { title: 'Page 1' },
   *   parentContextId: notebook.contextId,
   * });
   * ```
   */
  parentContextId?: string;

  /**
   * Whether the record should be publicly published.
   *
   * Published records can be read by anyone without authorization.
   */
  published?: boolean;

  /**
   * ISO 8601 timestamp for when the record is considered published.
   * Only meaningful when `published` is `true`.
   */
  datePublished?: string;

  /**
   * ISO 8601 timestamp stamped as the record's immutable creation date.
   *
   * Forwarded verbatim to the write message — the DWN engine owns all
   * timestamp validation rules. Supply it (typically together with
   * {@link TypedCreateRequest.messageTimestamp}) when the logical creation
   * time must differ from wall-clock now, e.g. a CRDT squash backstop
   * forward-stamping a compacted snapshot.
   */
  dateCreated?: string;

  /**
   * ISO 8601 timestamp stamped as the write message's timestamp.
   *
   * Forwarded verbatim to the write message — the DWN engine owns all
   * timestamp validation rules. Message timestamps drive conflict
   * resolution ordering between writes of the same record.
   */
  messageTimestamp?: string;

  /** DID of the intended recipient. Required by the public type on `$role` paths. */
  recipient?: string;

  /**
   * The recipient's role-path public key for this write, forwarded to the
   * agent when creating a `$role` record with a `recipient`.
   *
   * Supply it for recipients whose role-path key cannot be resolved from
   * their DWN (e.g. a bare `did:jwk` publishing no resolvable DWN
   * endpoint); the recipient computes the key locally and carries it out
   * of band for the writer to supply here. When omitted, role-audience
   * key delivery is best-effort. Owned contexts expose its lifecycle through
   * `context.members`.
   *
   * Enbox validates only that the supplied key is a usable X25519 public
   * key — it does NOT verify that the key belongs to the recipient. That
   * authenticity binding rests entirely on the out-of-band channel the
   * caller trusts (e.g. a signed join request). A `delivered: true`
   * outcome means the delivery record was written wrapping THIS supplied
   * key; it does not assert the intended recipient can decrypt it —
   * supplying the wrong key yields `delivered: true` and a delivery the
   * real recipient cannot decrypt.
   *
   * NOT supported together with {@link TypedCreateRequest.from} —
   * role-audience key delivery is provisioned on the owner's local DWN
   * via `processRequest` only, so the agent rejects a supplied key on the
   * remote dispatch path rather than silently ignoring it.
   */
  recipientRolePublicKey?: DwnPublicKeyJwk;

  /**
   * The module role under which to create this record.
   *
   * The DWN will verify that the author is authorized to write under
   * this role per the module's `$actions` configuration.
   */
  moduleRole?: string;

  /**
   * Compact the record's `$squash`-enabled path on write.
   *
   * When `true`, the write carries the `$squash` directive so the DWN
   * purges older siblings per the module's `$squash` configuration
   * (e.g. compacting a CRDT delta/snapshot history). The module path
   * MUST declare `$squash: true` — otherwise the write is **rejected**
   * with `ModuleAuthorizationSquashNotEnabled` (not silently ignored).
   * The low-level `records.write` already supports this; the typed
   * surface forwards it.
   */
  squash?: true;

  /**
   * Key-value metadata tags to attach to the record.
   *
   * Tags are indexed by the DWN and can be used in query filters for
   * efficient lookups. Values can be strings, numbers, booleans, or
   * arrays of strings/numbers.
   */
  tags?: globalThis.Record<string, string | number | boolean | string[] | number[]>;

};

/**
 * Typed create options for one exact module path.
 *
 * Paths declared with `$role: true` require the role holder's DID as
 * `recipient`; all other paths retain the Records API's optional recipient.
 * Definitions widened to `ModuleDefinition` cannot expose literal role
 * paths, so the runtime preflight remains authoritative for dynamic callers.
 *
 * @typeParam D - The module's literal definition.
 * @typeParam C - The module's runtime codec map.
 * @typeParam Path - The exact module path being created.
 */
export type TypedCreateRequest<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Path extends ModulePaths<D> & string,
> = TypedCreateOptions<C, Path> & (
  ModuleDefinition extends D
    ? unknown
    : [Path] extends [SquashModulePaths<D>]
      ? unknown
      : { squash?: never }
) & ([Extract<Path, ModuleRolePaths<D>>] extends [never]
  ? unknown
  : {
    /**
     * DID receiving this module role.
     *
     * A role assignment is the ordinary `$role` record whose `recipient`
     * names the holder, so typed role-record creates require this field.
     */
    recipient: string;
  });

/**
 * Options for replacing the visible value at a module-declared singleton path.
 *
 * `set()` updates the current `$recordLimit.max: 1` occupant or creates it
 * when the scope is empty. Immutable create-only fields are intentionally not
 * exposed because one request must have the same meaning in both cases.
 */
export type TypedSetRequest<
  C extends RecordCodecMap,
  Path extends string,
> = Pick<
  TypedCreateOptions<C, Path>,
  | 'data'
  | 'datePublished'
  | 'messageTimestamp'
  | 'published'
  | 'tags'
> & (Path extends `${string}/${string}`
  ? {
    /** Exact direct-parent context for this nested singleton. */
    within: string;
  }
  : {
    /** Root singleton paths do not have a parent context. */
    within?: never;
  });

/**
 * Advanced options for {@link TypedEnbox} `records.read()`.
 *
 * Pass a record ID directly for a local point read. Use this request shape
 * when additional filters, a remote source, a module role, or a context
 * selector is required.
 *
 * @example
 * ```ts
 * // Read a specific record by ID
 * const record = await notebooks.records.read('notebook', notebookId);
 *
 * // Read a nested record from a remote DWN using a module role
 * const remote = await notebooks.records.read('notebook/entry', {
 *   from: 'did:example:alice',
 *   moduleRole: 'notebook/participant',
 *   within: notebook.contextId,
 *   filter: { recordId: entryId },
 * });
 * ```
 */
export type TypedReadRequest<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
> = Pick<RecordQuery<D, Path>, 'from' | 'moduleRole'> & {
  /**
   * Filter to identify the record to read.
   *
   * The `module`, `modulePath`, and `schema` fields are auto-injected.
   * Typically you filter by `recordId` to read a specific record.
   */
  filter: RecordFilter<D, Path>;

  /** Context used to select the record and resolve context-scoped grants. */
  within?: string;
};

/**
 * Options for {@link TypedEnbox} `records.delete()`.
 *
 * @example
 * ```ts
 * await notebooks.records.delete('notebook', {
 *   recordId: notebook.id,
 * });
 *
 * await notebooks.records.delete('notebook/entry', {
 *   from: 'did:example:alice',
 *   moduleRole: 'notebook/participant',
 *   recordId: entry.id,
 *   within: notebook.contextId,
 * });
 * ```
 */
export type TypedDeleteRequest = {
  /**
   * Full context ID used to select a context-scoped grant and, for a bound
   * context handle, confirm the record belongs to that context before delete.
   * It is not included in the RecordsDelete message.
   */
  within?: string;

  /**
   * A remote DWN DID to delete from.
   *
   * When set, the delete is performed on the specified DID's remote DWN.
   */
  from?: string;

  /** Module role invoked to authorize the delete. */
  moduleRole?: string;

  /**
   * The unique `recordId` of the record to delete.
   *
   * Use {@link Record.id | record.id} to obtain this value.
   */
  recordId: string;

  /**
   * Whether to also delete (prune) every descendant record beneath this
   * record in the module hierarchy.
   *
   * Forwarded to the underlying `RecordsDelete` message. When omitted the
   * delete is a plain tombstone that leaves children in place.
   */
  prune?: boolean;
};

type ContextRecordPaths<
  D extends ModuleDefinition,
  Root extends ModulePaths<D> & string,
> = Exclude<
  Extract<ModulePaths<D> & string, Root | `${Root}/${string}`>,
  ModuleRolePaths<D>
>;

type ContextRecordMaterialization<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
> = true | {
  children: readonly Exclude<DirectSingletonChildPaths<D, Path>, ModuleRolePaths<D>>[];
};

type ContextDescendantPaths<
  D extends ModuleDefinition,
  Root extends ModulePaths<D> & string,
> = Root extends string
  ? Exclude<ContextRecordPaths<D, Root>, Root>
  : never;

type ContextCreateRequest<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Path extends ModulePaths<D> & string,
> = Omit<
  TypedCreateRequest<D, C, Path>,
  'from' | 'moduleRole' | 'recipientRolePublicKey' | 'store'
>;

type ContextRecordQuery<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
> = Omit<RecordQuery<D, Path>, 'from' | 'moduleRole'>;

type ContextQueryRequest<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends ContextRecordMaterialization<D, Path> | undefined,
> = QueryRequest<D, Path, Materialization, ContextRecordQuery<D, Path>>;

type ContextQueryArguments<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends ContextRecordMaterialization<D, Path> | undefined,
> = [Materialization] extends [undefined]
  ? [path: Path, request?: ContextQueryRequest<D, NoInfer<Path>, Materialization>]
  : [path: Path, request: ContextQueryRequest<D, NoInfer<Path>, Materialization>];

type ContextObserveRequest<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
  Materialization extends ContextRecordMaterialization<D, Path> | undefined,
> = ObserveRequest<D, Path, Materialization, ContextRecordQuery<D, Path>>;

type ContextReadRequest<
  D extends ModuleDefinition,
  Path extends ModulePaths<D> & string,
> = Omit<TypedReadRequest<D, Path>, 'from' | 'moduleRole'>;

type ContextSetRequest<
  C extends RecordCodecMap,
  Path extends string,
> = Omit<TypedSetRequest<C, Path>, 'within'> & { within?: string };

type ContextDeleteRequest = Omit<TypedDeleteRequest, 'from' | 'moduleRole'>;

/** One typed records contract, optionally confined to an application context. */
type TypedRecordsApi<
  D extends ModuleDefinition,
  C extends RecordCodecMap,
  Paths extends ModulePaths<D> & string = ModulePaths<D> & string,
  CreatePaths extends ModulePaths<D> & string = Paths,
  SetPaths extends ModulePaths<D> & string = SingletonModulePaths<D> & Paths & string,
  ContextBound extends boolean = false,
> = Readonly<{
  create: <Path extends CreatePaths>(
    path: Path,
    request: ContextBound extends true
      ? ContextCreateRequest<D, C, Path>
      : TypedCreateRequest<D, C, Path>,
  ) => Promise<RecordHandle<DataForPath<C, Path>, ContextBound>>;

  query: <
    Path extends Paths,
    const Materialization extends (
      ContextBound extends true
        ? ContextRecordMaterialization<D, NoInfer<Path>>
        : RecordMaterialization<D, Path>
    ) | undefined = undefined,
  >(...args: ContextBound extends true
      ? ContextQueryArguments<D, Path, Materialization>
      : TypedQueryArguments<D, Path, Materialization>
    ) => Promise<
    RecordPage<RecordRepresentation<D, C, Path, Materialization, ContextBound>>
  >;

  observe: <
    Path extends Paths,
    const Materialization extends (
      ContextBound extends true
        ? ContextRecordMaterialization<D, NoInfer<Path>>
        : RecordMaterialization<D, Path>
    ) | undefined = undefined,
  >(
    path: Path,
    request: ContextBound extends true
      ? ContextObserveRequest<D, NoInfer<Path>, Materialization>
      : RecordObserveRequest<D, Path, Materialization>,
  ) => Promise<ExpandableRecordView<
    RecordRepresentation<D, C, Path, Materialization, ContextBound>
  >>;

  subscribe: TypedRecordsSubscribe<C, Paths, ContextBound>;

  count: <Path extends Paths>(
    path: Path,
    request?: ContextBound extends true ? ContextRecordQuery<D, Path> : RecordQuery<D, Path>,
  ) => Promise<number>;

  read: <Path extends Paths>(
    path: Path,
    recordIdOrRequest: string | (ContextBound extends true
      ? ContextReadRequest<D, Path>
      : TypedReadRequest<D, Path>),
  ) => Promise<RecordHandle<DataForPath<C, Path>, ContextBound> | undefined>;

  patch: <Path extends Paths>(
    path: Path,
    recordId: string,
    patch: RecordPatchInput<DataForPath<C, Path>>,
  ) => Promise<RecordHandle<DataForPath<C, Path>, ContextBound>>;

  set: <Path extends SetPaths>(
    path: Path,
    request: ContextBound extends true ? ContextSetRequest<C, Path> : TypedSetRequest<C, Path>,
  ) => Promise<RecordHandle<DataForPath<C, Path>, ContextBound>>;

  delete: <Path extends Paths>(
    path: Path,
    request: ContextBound extends true ? ContextDeleteRequest : TypedDeleteRequest,
  ) => Promise<void>;
}>;

/**
 * Existing typed records operations confined to one application context.
 * Source routing, authorization roles, key delivery, and root scope are owned
 * by the context rather than supplied by each call.
 */
export type ContextRecordsApi<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
  Root extends ModulePaths<D> & string = ModulePaths<D> & string,
> = TypedRecordsApi<
  D,
  C,
  ContextRecordPaths<D, Root>,
  ContextDescendantPaths<D, Root>,
  SingletonModulePaths<D> & ContextDescendantPaths<D, Root> & string,
  true
>;

/**
 * Thrown/returned by {@link TypedEnbox.verifyInstalled} when a DELEGATE
 * session's wallet-installed module definition is stale (or missing, or
 * lacking required `$keyAgreement` keys).
 *
 * A delegate holds no `Modules.Configure` authority: it can only import
 * the wallet's already-signed configuration, so a drifted definition cannot
 * be repaired from the app side. The wallet must re-install the module and
 * re-approve the session — route the user back through the wallet connect /
 * approval flow.
 *
 * Contrast with the OWNER case, where the same drift is reported as
 * `'owner-can-update'` because a plain `configure()` call repairs it.
 */
export class WalletReapprovalRequiredError extends Error {
  /** The module URI whose wallet-installed definition is stale or missing. */
  public readonly module: string;

  constructor(module: string, detail: string) {
    super(
      `WalletReapprovalRequiredError: module '${module}' ${detail} ` +
      'A delegate cannot re-configure modules — the wallet must re-install ' +
      'the module and re-approve the session.',
    );
    this.name = 'WalletReapprovalRequiredError';
    this.module = module;
  }
}

/**
 * Result of {@link TypedEnbox.verifyInstalled} — a strict, read-only
 * verification of the installed module definition against the code's
 * definition, including `$keyAgreement` key coverage.
 *
 * `status` semantics:
 * - **`'up-to-date'`** — the installed definition canonically matches the
 *   code definition (runtime encryption blocks stripped before comparison)
 *   and, when the module declares encrypted types, every path the
 *   encryption-key injection covers carries a `$keyAgreement.publicKeyJwk`.
 * - **`'owner-can-update'`** — the connected identity owns the tenant and
 *   the installation is missing, drifted, or lacking `$keyAgreement` keys;
 *   calling {@link TypedEnbox.configure | configure()} repairs it.
 * - **`'wallet-reapproval-required'`** — the session is a DELEGATE and the
 *   WALLET-installed definition (fetched from the owner tenant) is missing,
 *   drifted, or lacking `$keyAgreement` keys. The delegate cannot repair
 *   this; `error` carries a throwable {@link WalletReapprovalRequiredError}
 *   instead of the drift being silently imported.
 */
export type VerifyInstalledResult = {
  /** The verification outcome — see the type-level doc for semantics. */
  status: 'up-to-date' | 'owner-can-update' | 'wallet-reapproval-required';

  /**
   * Whether an installed definition was found at all — locally for owner
   * sessions, on the wallet (owner) tenant for delegate sessions.
   */
  installed: boolean;

  /**
   * Whether the installed definition canonically matches the code definition
   * with `$encryption`/`$keyAgreement` runtime blocks stripped. `false` when
   * no installation was found.
   */
  definitionsMatch: boolean;

  /**
   * Module paths the encryption-key injection should cover whose
   * `$keyAgreement.publicKeyJwk` is missing from the installed definition.
   * The empty string denotes the module root. Checked only when the
   * definition declares encrypted types (`encryptionRequired: true`) and an
   * installation was found; empty otherwise. `$ref` composition nodes are
   * exempt — their records are governed by the referenced module's keys.
   */
  missingKeyAgreementPaths: string[];

  /** Human-readable explanation of a non-`'up-to-date'` status. */
  reason?: string;

  /**
   * Present only with `status: 'wallet-reapproval-required'` — a typed,
   * throwable error for callers that want hard-failure semantics
   * (`if (result.error) { throw result.error; }`).
   */
  error?: WalletReapprovalRequiredError;
};

// ---------------------------------------------------------------------------
// TypedEnbox class
// ---------------------------------------------------------------------------

/**
 * A module-scoped API that auto-injects `module`, `modulePath`, and
 * `schema` into every DWN operation.
 *
 * All record-returning methods preserve the data type `T` on the canonical
 * {@link Record} class so it flows end-to-end — from write through read,
 * query, and update — without manual casts.
 *
 * Obtain an instance via `enbox.using(typedModule)`.
 *
 * @example
 * ```ts
 * const notes = enbox.using(NotesModule);
 *
 * const record = await notes.records.create('note', {
 *   data: { title: 'Hello', body: 'Typed data' },
 * });
 * const data = await record.value(); // NoteData — no cast
 *
 * const { records } = await notes.records.query('note', {
 *   filter: { tags: { category: 'work' } },
 * });
 * for (const r of records) {
 *   const d = await r.value(); // NoteData
 * }
 * ```
 */
export class TypedEnbox<
  D extends ModuleDefinition = ModuleDefinition,
  C extends RecordCodecMap = RecordCodecMap,
> {
  /** @internal */
  private readonly _dwn: DwnApi;
  /** @internal */
  private readonly _definition: D;
  /** @internal */
  private readonly _codecs: C;
  /** @internal Authored identities and physical ancestry for this module. */
  private readonly _resolvedGraph: ResolvedModuleGraph;
  /** @internal Explicit providers retained for ordered readiness. */
  private readonly _dependencies: ModuleDependencies;
  /** @internal */
  private readonly _dependencyApis: Map<ModuleDependency, TypedEnbox>;
  /** @internal */
  private _dependenciesReady: Promise<void> | undefined;
  /** @internal */
  private _configured: boolean = false;
  /** @internal */
  private _ensureReadyPromise: Promise<void> | null = null;
  /** @internal */
  private _contexts?: ContextsApi<D, C>;
  /** @internal */
  private readonly _validPaths: Set<string>;
  /** @internal */
  private _records?: TypedRecordsApi<D, C>;
  /** @internal Whether this module owns the managed invitation/follow lifecycle. */
  private readonly _hasManagedSharedContext: boolean;
  /** @internal Plaintext role providers also require public key-agreement metadata. */
  private readonly _requiresKeyAgreement: boolean;
  /** @internal */
  private readonly _options: TypedEnboxOptions;

  /**
   * @internal Create a new `TypedEnbox` instance. Use `enbox.using(module)` instead.
   * @param dwn - The underlying DWN API instance.
   * @param module - The typed module containing the definition and codecs.
   * @param options - Optional session-owned lifecycle and sync resources.
   */
  constructor(dwn: DwnApi, module: TypedModule<D, C>, options: TypedEnboxOptions = {}) {
    this._resolvedGraph = resolveTypedModuleGraph(module);
    this._dwn = dwn;
    this._definition = module.definition;
    this._codecs = module.codecs;
    this._dependencies = module.dependencies;
    this._dependencyApis = options.dependencyApis ?? new Map();
    this._options = options;
    this._configured = options.context !== undefined;
    this._validPaths = collectModulePaths(this._definition.structure);
    this._hasManagedSharedContext = hasManagedSharedContext(this._definition);
    this._requiresKeyAgreement = Modules.requiresKeyAgreement(this._definition);
  }

  /**
   * The module URI string (e.g. `'https://example.com/threads'`).
   *
   * This is the globally unique identifier for the module and is
   * auto-injected into every record operation.
   */
  public get module(): string {
    return this._definition.module;
  }

  /**
   * The effective module definition object, including Enbox-managed paths.
   *
   * Contains the full `module`, `types`, and `structure` that define
   * the module's schema and permission rules.
   */
  public get definition(): D {
    return this._definition;
  }

  /**
   * The underlying untyped {@link DwnApi} this instance operates through.
   *
   * This is the supported escape hatch to the raw DWN layer — use it when
   * an operation is not (yet) surfaced on the typed API, e.g. low-level
   * `records.write` with explicit message params. Prefer the typed
   * methods for everything they cover.
   */
  public get dwn(): DwnApi {
    this._assertActive();
    return this._dwn;
  }

  /**
   * Configures (installs) this module on the local DWN.
   *
   * If the module is already installed with an identical definition,
   * this is a no-op and returns the existing module with status `200`.
   * If the definition has changed (e.g. new types, modified structure),
   * the module is re-configured with the updated definition and returns
   * status `202`.
   *
   * Record operations prepare the module automatically. Call this method
   * directly only when the application needs the installation result first.
   *
   * @returns The DWN response status and the installed module object.
   *
   * @example
   * ```ts
   * const notebooks = enbox.using(NotebookModule);
   *
   * const { status, module } = await notebooks.configure();
   * console.log(status.code); // 202 (first install) or 200 (already installed)
   * ```
   */
  public async configure(): Promise<DwnResponseStatus & { module?: Module }> {
    this._assertActive();
    await this.ensureDependenciesReady();
    if (this._dwn.isDelegate) {
      return this._autoConfigureDelegateModule();
    }

    // Query for an existing installation of this module.
    const query = await this._dwn.modules.query({
      filter: { module: this._definition.module },
    });
    requireDwnSuccess('TypedEnbox.configure module query', query);
    const { modules } = query;

    // If already installed with the same definition, return it as-is.
    if (modules.length > 0) {
      const existing = modules[0];
      const encryptionKeysComplete = !this._requiresKeyAgreement
        || collectMissingKeyAgreementPaths(existing.definition).length === 0;
      if (authoredModuleDefinitionsEqual(existing.definition, this._definition) && encryptionKeysComplete) {
        this._configured = true;
        return { status: { code: 200, detail: 'OK' }, module: existing };
      }
    }

    const result = await this._dwn.modules.configure({
      definition: this._definition,
    });

    if (result.status.code === 202) {
      this._configured = true;
    }

    return result;
  }

  /** @internal Prepare an installation dependency while retaining an already-installed compatible provider. */
  public async ensureInstalled(): Promise<ModulesConfigureResponse> {
    this._assertActive();
    if (this._dwn.isDelegate) {
      return this._autoConfigureDelegateModule(true);
    }
    const query = await this._dwn.modules.query({ filter: { module: this._definition.module } });
    requireDwnSuccess('TypedEnbox dependency installation query', query);
    const module = query.modules[0];
    if (module !== undefined) {
      assertInstalledDependencyKeys(module.definition);
      this._configured = true;
      return { status: query.status, module };
    }
    // Only a missing provider needs its packaged dependencies installed. An
    // existing provider may have intentionally removed unrelated old imports.
    return this.configure();
  }

  /**
   * Whether the module has been configured (installed) on the local DWN.
   *
   * Returns `true` after explicit configuration or the first record operation
   * has prepared the module automatically.
   */
  public get isConfigured(): boolean {
    return this._configured;
  }

  /** Owned and role-authorized member contexts for this module. */
  public get contexts(): ContextsApi<D, C> {
    if (this._contexts !== undefined) {
      return this._contexts;
    }

    const contextRoots = [...this._validPaths]
      .filter(path => this.getContextRoles(path).length > 0)
      .sort(compareCodeUnits) as ContextRootPath<D>[];
    const contextRoles = new Set(contextRoots.flatMap(path => this.getContextRoles(path)));
    const canUseFollowing = this._options.sync !== undefined && Object.hasOwn(this._definition.structure, CONTEXT_FOLLOW_PATH);
    type CatalogContext = { access: 'member' | 'owner'; id: string; key: string; ownerDid: string };
    type CatalogMemberContext = CatalogContext & {
      access: 'member';
      path: string;
      records: {
        observe(
          path: string,
          request: Readonly<{
            materialize: true;
            pagination: { limit: number };
            signal: AbortSignal;
          }>,
        ): Promise<RecordView<ContextMaterializedRecord<unknown>>>;
      };
    };
    const boundMembers = new Map<string, { context: MemberContext<D, C>; source: FollowedSyncSource }>();
    const boundOwners = new Map<string, CatalogContext>();
    let following: ContextFollowing | undefined;
    const getFollowing = (): ContextFollowing => {
      if (this._options.sync === undefined) {
        throw new TypeError('TypedEnbox.contexts requires an Enbox session with shared-context storage.');
      }
      if (!Object.hasOwn(this._definition.structure, CONTEXT_FOLLOW_PATH)) {
        throw new TypeError('TypedEnbox.contexts: this module does not support saved following choices.');
      }
      following ??= new ContextFollowing({
        actorDid      : this._dwn.connectedDid,
        append        : (intent, after): Promise<ContextFollowRecord> => this.appendContextFollow(intent, after),
        openView      : (signal): Promise<ExpandableRecordView<ContextFollowRecord>> => this.observeContextFollows(signal),
        definition    : this._definition,
        resolvedGraph : this._resolvedGraph,
        read          : (): Promise<ContextFollowRecord[]> => this.readContextFollows(),
        signal        : this._options.signal,
        sync          : this._options.sync,
      });
      return following;
    };

    const listSources = async (): Promise<FollowedSyncSource[]> => {
      this._options.signal?.throwIfAborted();
      if (this._options.sync === undefined) {
        return [];
      }
      return (await this._options.sync.listFollowedSources())
        .filter(source =>
          source.actorDid === this._dwn.connectedDid &&
          source.module === this._definition.module &&
          contextRoles.has(source.moduleRole)
        );
    };

    const followContext = async (
      path: string,
      request: ContextFollowTarget,
    ): Promise<MemberContext<D, C>> => {
      this._options.signal?.throwIfAborted();
      const target = normalizeContextFollowTarget(request, 'TypedEnbox.contexts.follow');
      if (this.getContextRoles(path).length === 0) {
        throw new TypeError(`TypedEnbox.contexts.follow: '${path}' has no contextual read roles.`);
      }
      if (target.id.split('/').length !== this.resolveRecordNode(path).physicalDepth) {
        throw new TypeError(`TypedEnbox.contexts.follow: id must identify a '${path}' context.`);
      }
      const coordinator = getFollowing();
      let source: FollowedSyncSource;
      try {
        source = await coordinator.follow({ ...target, path });
      } catch (error) {
        if (error instanceof FollowedSourceNotReadyError) { throw new ContextNotReadyError(error); }
        if (error instanceof ContextRetiredError) { throw error; }
        throw new Error('TypedEnbox.contexts.follow could not establish the requested context.', { cause: error });
      }
      return bindMemberContext(source);
    };

    const bindOwnedContext = <Root extends ModulePaths<D> & string>(
      normalizedPath: Root,
      id: string,
    ): OwnedContext<D, C, Root> => {
      const key = moduleContextKey(this._dwn.connectedDid, id);
      const existing = boundOwners.get(key);
      if (existing !== undefined) {
        return existing as OwnedContext<D, C, Root>;
      }
      const modulePaths = new Set(
        [...this._validPaths]
          .filter((candidate): boolean =>
            (candidate === normalizedPath || candidate.startsWith(`${normalizedPath}/`)) &&
            !isModuleRolePath(this._definition, candidate)
          ),
      );
      const dwn = this._dwn.withRecordExecutionContext({
        assertActive : async (): Promise<void> => this._options.signal?.throwIfAborted(),
        contextId    : id,
        tenantDid    : this._dwn.connectedDid,
      });
      const records = this.bindContextRecords(
        dwn,
        { contextId: id, modulePath: normalizedPath, modulePaths },
      );
      const roles = this.getContextRoles(normalizedPath);
      const members = roles.length === 0 ? undefined : this.bindContextMembers(dwn, id, roles);
      const context = Object.freeze({
        access: 'owner',
        id,
        ...(members === undefined ? {} : {
          members,
          invite: async (
            did: string,
            request: { preview?: ContextInvitationPreview } = {},
          ): Promise<void> => {
            const recipient = normalizeMemberDid(did, 'OwnedContext.invite');
            if (await members.get(recipient) === undefined) {
              throw new TypeError('OwnedContext.invite: establish membership before sending an invitation.');
            }
            await this.sendContextInvitation(recipient, id, normalizedPath, request.preview);
          },
        }),
        key,
        ownerDid     : this._dwn.connectedDid,
        path         : normalizedPath,
        records,
        rootRecordId : contextRootRecordId(id),
      }) as OwnedContext<D, C, Root>;
      boundOwners.set(key, context);
      return context;
    };

    const openContext = async <Root extends Exclude<ModulePaths<D> & string, ModuleRolePaths<D>>>(
      path: Root,
      id: string,
    ): Promise<OwnedContext<D, C, Root>> => {
      const normalizedPath = normalizePath(path) as Root;
      if (isModuleRolePath(this._definition, normalizedPath)) {
        throw new TypeError('TypedEnbox.contexts.open cannot open a role record as a context.');
      }
      if (id.split('/').length !== normalizedPath.split('/').length) {
        throw new TypeError(`TypedEnbox.contexts.open: id must identify a '${normalizedPath}' context.`);
      }
      assertValidRecordWithin(this.resolveRecordNode(normalizedPath), id, true);
      await this._ensureReady(normalizedPath);
      return bindOwnedContext(normalizedPath, id);
    };

    const bindMemberContext = (source: FollowedSyncSource): MemberContext<D, C> => {
      const key = moduleContextKey(source.sourceDid, source.contextId);
      const existing = boundMembers.get(key);
      if (existing !== undefined && followedSyncSourceActiveEqual(existing.source, source)) {
        return existing.context;
      }
      const context = this.bindMemberContext(source, (expected, withdrawRole) => getFollowing().forget(expected, withdrawRole));
      boundMembers.set(key, { context, source });
      return context;
    };

    const bindCatalogMembers = (sources: readonly FollowedSyncSource[]): CatalogMemberContext[] => {
      const members = new Map<string, CatalogMemberContext>();
      for (const source of sources) {
        const key = moduleContextKey(source.sourceDid, source.contextId);
        if (!members.has(key)) {
          members.set(key, bindMemberContext(source) as unknown as CatalogMemberContext);
        }
      }
      for (const key of boundMembers.keys()) {
        if (!members.has(key)) { boundMembers.delete(key); }
      }
      return [...members.values()];
    };

    const listOwnedRootContextIds = async (path: string): Promise<string[]> => {
      await this._ensureReady(path);
      let parentContexts: Array<string | undefined> = [undefined];
      let contextIds: string[] = [];
      const node = this.resolveRecordNode(path);
      const steps = [...node.physicalAncestors, node];
      for (const step of steps) {
        const modulePath = step.owningModulePath;
        const results = await Promise.all(parentContexts.map(async (within) => {
          const result = await this._dwn.records.query({
            filter: {
              module: step.owningModuleUri,
              modulePath,
              ...(within === undefined ? {} : { contextId: within }),
            },
          });
          requireDwnSuccess('TypedEnbox.contexts.list', result);
          return result.records;
        }));
        contextIds = results.flat().map((record) => {
          if (record.contextId === undefined) {
            throw new Error(`TypedEnbox.contexts.list: '${modulePath}' record is missing its context ID.`);
          }
          return record.contextId;
        });
        parentContexts = contextIds;
      }
      return contextIds;
    };

    const listCatalogContexts = async (): Promise<CatalogContext[]> => {
      const [ownedByRoot, sources] = await Promise.all([
        Promise.all(contextRoots.map(async (path): Promise<CatalogContext[]> =>
          (await listOwnedRootContextIds(path)).map(contextId => bindOwnedContext(path, contextId))
        )),
        listSources(),
      ]);
      const contexts = new Map<string, CatalogContext>(ownedByRoot.flat().map(context => [context.key, context]));
      for (const key of boundOwners.keys()) {
        if (!contexts.has(key)) { boundOwners.delete(key); }
      }
      for (const member of bindCatalogMembers(sources)) {
        if (!contexts.has(member.key)) {
          contexts.set(member.key, member);
        }
      }
      return [...contexts.values()].sort(compareModuleContexts);
    };

    const listContexts = async (): Promise<ModuleContext<D, C>[]> => {
      if (canUseFollowing) {
        await getFollowing().restore();
      }
      return await listCatalogContexts() as unknown as ModuleContext<D, C>[];
    };

    const openCatalogWakeSubscription = async (
      wake: () => void,
      fail: (error: Error) => void,
      signal?: AbortSignal,
      includeOwnedRoots = true,
    ): Promise<{ close(): Promise<void> }> => {
      const detachSync = this._options.sync?.on((event): void => {
        if (
          event.type === 'followed-context:change' &&
          event.actorDid === this._dwn.connectedDid &&
          event.module === this._definition.module
        ) {
          wake();
        }
        following?.retryAfterSync(event);
      }) ?? ((): void => {});
      let follows: { close(): Promise<void> } | undefined;
      try {
        if (canUseFollowing) {
          follows = await getFollowing().observe({ onChange: wake, onError: fail, signal });
        }
        const records = !includeOwnedRoots || contextRoots.length === 0
          ? undefined
          : await this.records.subscribe(contextRoots, { signal }, (event): void => {
            if (event.type === 'error') {
              fail(event.error);
            } else {
              wake();
            }
          });
        return {
          close: async (): Promise<void> => {
            detachSync();
            const closed = await Promise.allSettled([records?.close(), follows?.close()]);
            const failed = closed.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failed !== undefined) {
              throw failed.reason;
            }
          },
        };
      } catch (error: unknown) {
        detachSync();
        // Preserve the subscription-opening failure if releasing the follow observer also fails.
        await follows?.close().catch((): void => {});
        throw error;
      }
    };

    const observeMaterializedMemberContexts = async (
      options: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ContextView<MaterializedMemberContext<
      CatalogMemberContext,
      ContextMaterializedRecord<unknown>
    >>> => createMaterializedMemberContextView<CatalogMemberContext, ContextMaterializedRecord<unknown>>({
      callerSignal    : options.signal,
      getSavedFollows : () => following?.getSavedFollows() ?? [],
      listContexts    : async () => bindCatalogMembers(await listSources()).sort(compareModuleContexts),
      openRootView    : (context, signal) => context.records.observe(context.path, {
        materialize : true,
        pagination  : { limit: 1 },
        signal,
      }),
      openWakeSubscription : (wake, fail) => openCatalogWakeSubscription(wake, fail, options.signal, false),
      signal               : this._options.signal,
    });

    this._contexts = {
      open   : openContext,
      follow : followContext as ContextsApi<D, C>['follow'],
      forget : async (request: ContextFollowTarget): Promise<void> => {
        this._options.signal?.throwIfAborted();
        const target = normalizeContextFollowTarget(request, 'TypedEnbox.contexts.forget');
        await getFollowing().forgetContext(target);
      },
      ...(contextRoots.length > 0 ? {
        invitations: {
          list: async (options?: { limit?: number }): Promise<ModuleContextInvitation<D, C>[]> =>
            this.listContextInvitations(options?.limit, followContext),
          observe: async (options?: { limit?: number; signal?: AbortSignal }): Promise<
            RecordView<ModuleContextInvitation<D, C>>
          > => this.observeContextInvitations(options?.limit, followContext, options?.signal),
        },
      } : {}),
      list    : listContexts,
      observe : async (options?: {
        access?: 'member';
        materializeRoot?: true;
        signal?: AbortSignal;
      }): Promise<ContextView<unknown>> => {
        if (options?.access !== undefined || options?.materializeRoot !== undefined) {
          if (options.access !== 'member' || options.materializeRoot !== true) {
            throw new TypeError(
              'TypedEnbox.contexts.observe: root materialization requires access: \'member\' and materializeRoot: true.',
            );
          }
          return observeMaterializedMemberContexts(options);
        }
        return createContextView({
          callerSignal         : options?.signal,
          getSavedFollows      : () => following?.getSavedFollows() ?? [],
          list                 : listCatalogContexts,
          openWakeSubscription : (wake, fail) => openCatalogWakeSubscription(wake, fail, options?.signal),
          signal               : this._options.signal,
        });
      },
    } as ContextsApi<D, C>;
    return this._contexts;
  }

  /**
   * Strictly verifies the installed module definition without modifying
   * anything — the read-only counterpart to {@link TypedEnbox.configure}.
   *
   * `verifyInstalled()`:
   *
   * 1. canonically compares the installed definition against the code
   *    definition with runtime `$encryption`/`$keyAgreement` blocks stripped;
   * 2. when the definition declares encrypted types, verifies a
   *    `$keyAgreement.publicKeyJwk` is present at every path the
   *    encryption-key injection covers (module root and every non-`$ref`
   *    structure path);
   * 3. distinguishes WHO can repair a failure: an owner gets
   *    `'owner-can-update'` (call `configure()`), while a delegate whose
   *    wallet-installed definition is stale gets
   *    `'wallet-reapproval-required'` together with a typed
   *    {@link WalletReapprovalRequiredError} — never a silent import.
   *
   * For owner sessions the LOCAL installation is verified; for delegate
   * sessions the WALLET-installed definition is fetched from the owner tenant
   * through the agent's configured routing (the source auto-configure imports from).
   *
   * Never changes state: no configure, no import, no cache updates.
   *
   * @returns The structured verification result — see {@link VerifyInstalledResult}.
   * @throws {@link DwnResponseError} when the module query itself fails
   *   (e.g. a revoked or expired session grant surfaces as a 401) — a
   *   transport/authorization failure, not a verification outcome.
   */
  public async verifyInstalled(): Promise<VerifyInstalledResult> {
    this._assertActive();
    await this.verifyDependencyContracts();
    const isDelegate = this._dwn.isDelegate;

    // Owners verify their local installation; delegates verify the
    // wallet-installed definition on the owner tenant — the same source
    // `_autoConfigureDelegateModule` imports from.
    const query = await this._dwn.modules.query({
      ...(isDelegate ? { from: this._dwn.connectedDid } : {}),
      filter: { module: this._definition.module },
    });
    requireDwnSuccess(
      isDelegate
        ? 'TypedEnbox.verifyInstalled wallet module query; reconnect to refresh delegated grants'
        : 'TypedEnbox.verifyInstalled local module query',
      query,
    );
    return this._assessInstalledDefinition(query.modules[0]?.definition, isDelegate);
  }

  /** Compares one installed definition with the application definition without changing state. */
  private _assessInstalledDefinition(
    installedDefinition: ModuleDefinition | undefined,
    isDelegate: boolean,
  ): VerifyInstalledResult {
    if (installedDefinition === undefined) {
      return this.buildVerifyInstalledResult({
        isDelegate,
        installed                : false,
        definitionsMatch         : false,
        missingKeyAgreementPaths : [],
        detail                   : isDelegate
          ? 'is not installed on the wallet (owner) tenant.'
          : 'is not installed on the local DWN.',
      });
    }

    const definitionsMatch = authoredModuleDefinitionsEqual(installedDefinition, this._definition);

    // Encrypted records and plaintext role providers both require key coverage.
    const missingKeyAgreementPaths = (this._requiresKeyAgreement || Modules.requiresKeyAgreement(installedDefinition))
      ? collectMissingKeyAgreementPaths(installedDefinition)
      : [];

    if (definitionsMatch && missingKeyAgreementPaths.length === 0) {
      return {
        status                   : 'up-to-date',
        installed                : true,
        definitionsMatch         : true,
        missingKeyAgreementPaths : [],
      };
    }

    const detail = definitionsMatch
      ? `is installed but is missing $keyAgreement keys at: ${missingKeyAgreementPaths.map((p) => p === '' ? '(root)' : p).join(', ')}.`
      : `is installed with a definition that differs from the application's definition.`;

    return this.buildVerifyInstalledResult({
      isDelegate,
      installed: true,
      definitionsMatch,
      missingKeyAgreementPaths,
      detail,
    });
  }

  /**
   * Shapes a non-`'up-to-date'` {@link VerifyInstalledResult}: owner
   * sessions get `'owner-can-update'`; delegate sessions get
   * `'wallet-reapproval-required'` with the typed error attached.
   */
  private buildVerifyInstalledResult(params: {
    isDelegate: boolean;
    installed: boolean;
    definitionsMatch: boolean;
    missingKeyAgreementPaths: string[];
    detail: string;
  }): VerifyInstalledResult {
    const { isDelegate, installed, definitionsMatch, missingKeyAgreementPaths, detail } = params;

    if (isDelegate) {
      const error = new WalletReapprovalRequiredError(this._definition.module, detail);
      return {
        status : 'wallet-reapproval-required',
        installed,
        definitionsMatch,
        missingKeyAgreementPaths,
        reason : error.message,
        error,
      };
    }

    return {
      status : 'owner-can-update',
      installed,
      definitionsMatch,
      missingKeyAgreementPaths,
      reason : `TypedEnbox: module '${this._definition.module}' ${detail} Call configure() to repair it.`,
    };
  }

  /**
   * Validates that the path is recognized.
   * Throws a descriptive error if the path is not a valid module path.
   */
  private _assertValidPath(path: string): void {
    if (!this._validPaths.has(path)) {
      throw new TypeError(
        `TypedEnbox: invalid module path '${path}'. ` +
        `Valid paths are: ${[...this._validPaths].join(', ')}.`,
      );
    }
  }

  private resolveRecordNode(path: string): ResolvedModuleNode {
    this._assertValidPath(path);
    return resolveRecordQueryNode(this._resolvedGraph, path);
  }

  /** Resolve the codec assigned to one validated module path. */
  private resolveCodec(path: string): RecordCodec<unknown> {
    const codec = this._codecs[this.resolveRecordNode(path).typeName];
    if (codec === undefined) {
      throw new Error(`TypedEnbox: module path '${path}' does not have a record codec.`);
    }
    return codec;
  }

  /** Resolve one statically known path's application codec. */
  private getCodec<Path extends ModulePaths<D> & string>(path: string): RecordCodec<DataForPath<C, Path>> {
    return this.resolveCodec(path) as RecordCodec<DataForPath<C, Path>>;
  }

  /** Bind a path codec to one canonical record returned by the raw DWN API. */
  private bindCodec<
    Path extends ModulePaths<D> & string,
    Existing = unknown,
  >(
    path : string,
    record : Record<Existing>,
  ): TypedRecord<DataForPath<C, Path>> {
    const dataFormats = this.resolveRecordNode(path).recordType.dataFormats;
    return bindRecordCodec(
      record,
      this.getCodec<Path>(path),
      dataFormats,
      this._options.signal,
    ) as TypedRecord<DataForPath<C, Path>>;
  }

  /** Validate materialization once, before any module or Records request starts. */
  private resolveMaterializedChildPaths<Path extends ModulePaths<D> & string>(
    parentPath : string,
    materialization : RecordMaterialization<D, Path> | undefined,
    pageLimit : number | undefined,
  ): string[] {
    if (materialization === undefined) {
      return [];
    }
    if (pageLimit === undefined) {
      throw new TypeError('Record materialization: pagination.limit is required to bound decoded values.');
    }
    if (materialization === true) {
      return [];
    }
    if (materialization === null
      || typeof materialization !== 'object'
      || Array.isArray(materialization)
      || Object.keys(materialization).some((key) => key !== 'children')
      || !Array.isArray(materialization.children)
      || materialization.children.length === 0) {
      throw new TypeError('Record materialization: children must be a non-empty array of direct singleton paths.');
    }
    const childPaths = [...materialization.children];
    if (childPaths.some((childPath) => typeof childPath !== 'string')
      || new Set(childPaths).size !== childPaths.length) {
      throw new TypeError('Record materialization: children must contain unique module paths.');
    }

    const directChildPrefix = `${parentPath}/`;
    for (const childPath of childPaths) {
      this.assertContextPath(childPath);
      const childName = childPath.slice(directChildPrefix.length);
      const ruleSet = getRuleSetAtPath(childPath, this._definition.structure);
      if (!childPath.startsWith(directChildPrefix)
        || childName === ''
        || childName.includes('/')
        || ruleSet?.$recordLimit?.max !== 1) {
        throw new TypeError(
          `Record materialization: '${childPath}' must be a direct child of '${parentPath}' ` +
          `with $recordLimit.max: 1.`,
        );
      }
    }

    return childPaths;
  }

  /** Produce the one record representation selected by query and observe. */
  private async representRecords<
    Path extends ModulePaths<D> & string,
    Materialization extends RecordMaterialization<D, Path> | undefined,
  >(
    path : string,
    records : Record[],
    materialization : Materialization,
    childPaths : readonly string[],
    source : MaterializationSource,
  ): Promise<readonly RecordRepresentation<D, C, Path, Materialization>[]> {
    const represented = materialization === undefined
      ? records.map((record) => this.bindCodec<Path>(path, record))
      : await this.materializeRecords<Path>(
        path,
        records,
        childPaths,
        source,
      );

    // The runtime branch above is the sole erasure point for the conditional
    // query result; both paths retain their concrete public representation.
    return represented as unknown as readonly RecordRepresentation<D, C, Path, Materialization>[];
  }

  /** Decode one bounded parent page and its explicitly selected singleton children. */
  private async materializeRecords<
    Path extends ModulePaths<D> & string,
  >(
    parentPath : string,
    records : readonly Record[],
    childPaths : readonly string[],
    source : MaterializationSource,
  ): Promise<readonly (
    TypedMaterializedRecord<DataForPath<C, Path>> |
    MaterializedRecordWithChildren<DataForPath<C, Path>>
  )[]> {
    const parents = await Promise.all(records.map(async (record): Promise<
      TypedMaterializedRecord<DataForPath<C, Path>>
    > => {
      const typedRecord = this.bindCodec<Path>(parentPath, record);
      return Object.freeze({
        record : typedRecord,
        value  : await typedRecord.value(),
      });
    }));

    if (parents.length === 0 || childPaths.length === 0) {
      return parents;
    }

    const parentById = new Map(parents.map((parent) => [parent.record.id, {
      children: new Map<string, TypedMaterializedRecord<unknown> | undefined>(
        childPaths.map((childPath) => [getTypeName(childPath), undefined]),
      ),
      parent,
    }]));
    const parentIds = [...parentById.keys()];
    await Promise.all(childPaths.map(async (childPath): Promise<void> => {
      const childName = getTypeName(childPath);

      const childType = this._definition.types[childName];
      const filter = compileRecordFilter(
        this._resolvedGraph,
        childPath,
        undefined,
        source.within,
      );
      filter.parentId = parentIds;
      const result = await this._dwn.records.query({
        from       : source.from,
        filter,
        moduleRole : source.moduleRole,
      });
      requireDwnSuccess('TypedEnbox.records.query child materialization', result);

      const occupiedParentIds = new Set<string>();
      await Promise.all(result.records.map(async (record): Promise<void> => {
        const parentId = record.parentId;
        const parentEntry = parentId === undefined ? undefined : parentById.get(parentId);
        if (parentEntry === undefined) {
          throw new Error(
            `TypedEnbox.records.query: child '${childPath}' did not reference a selected parent.`,
          );
        }
        if (occupiedParentIds.has(parentId)) {
          throw new Error(
            `TypedEnbox.records.query: singleton child '${childPath}' returned multiple visible records ` +
            `for parent '${parentEntry.parent.record.id}'.`,
          );
        }
        occupiedParentIds.add(parentId);

        const childRecord = bindRecordCodec(
          record,
          this.resolveCodec(childPath),
          childType?.dataFormats,
          this._options.signal,
        );
        parentEntry.children.set(childName, Object.freeze({
          record : childRecord,
          value  : await childRecord.value(),
        }));
      }));
    }));

    return [...parentById.values()].map(({ children, parent }) => Object.freeze({
      ...parent,
      children: Object.freeze(Object.fromEntries(children)),
    }));
  }

  /** Bind one raw frame record to its path-discriminated typed change. */
  private recordSubscriptionChange<
    const Selection extends RecordSubscriptionSelection<ModulePaths<D> & string>,
  >(record: Record): TypedRecordChangeEvent<C, ModuleSubscriptionPaths<D, Selection>, false> {
    const path = record.modulePath as ModuleSubscriptionPaths<D, Selection>;
    return {
      path,
      type   : record.deleted ? 'delete' : 'write',
      record : this.bindCodec<ModuleSubscriptionPaths<D, Selection>>(path, record),
    } as TypedRecordChangeEvent<C, ModuleSubscriptionPaths<D, Selection>, false>;
  }

  /** Open one typed change stream for one path or one non-empty path set. */
  private async subscribeToRecordPaths<
    const Selection extends RecordSubscriptionSelection<ModulePaths<D> & string>,
  >(
    selection: Selection,
    listener: TypedRecordSubscriptionListener<C, ModuleSubscriptionPaths<D, Selection>, false>,
    signal: AbortSignal | undefined = this._options.signal,
  ): Promise<RecordSubscription> {
    signal?.throwIfAborted();
    const requestedPaths = typeof selection === 'string' ? [selection] : [...selection];
    if (requestedPaths.length === 0) {
      throw new TypeError('TypedEnbox.records.subscribe: at least one module path is required.');
    }
    const paths = [...new Set(requestedPaths.map(normalizePath))];
    await whileSignalsActive(
      () => Promise.all(paths.map(path => this._ensureReady(path))),
      [signal],
    );
    signal?.throwIfAborted();

    let closed = false;
    let detachAbort = (): void => {};
    let detachSync = (): void => {};
    let closeSubscription = (): Promise<void> => Promise.resolve();
    let listenerFailure: { error: unknown } | undefined;
    const deliver = async (
      event: TypedRecordSubscriptionEvent<C, ModuleSubscriptionPaths<D, Selection>, false>,
    ): Promise<void> => {
      try {
        await listener(event);
      } catch (error: unknown) {
        listenerFailure ??= { error };
        closed = true;
        detachAbort();
        detachSync();
        await closeSubscription().catch((): void => {});
      }
    };
    const followedSourceAcceptanceId = this._dwn.followedSourceAcceptanceId;
    const followedSourceId = this._dwn.followedSourceId;
    const contextId = this._options.context?.contextId;
    if (followedSourceId !== undefined && contextId !== undefined && this._options.sync !== undefined) {
      detachSync = this._options.sync.on((event): void => {
        if (closed || signal?.aborted === true) {
          return;
        }
        if (
          event.type === 'followed-context:change' &&
          event.actorDid === this._dwn.connectedDid &&
          event.contextId === contextId &&
          event.module === this.module &&
          event.tenantDid === this._dwn.recordTenantDid &&
          followedContextChangeRetiresSource({
            acceptanceId : followedSourceAcceptanceId!,
            id           : followedSourceId,
          }, event)
        ) {
          closed = true;
          detachAbort();
          detachSync();
          void Promise.resolve().then(() => listener({
            type  : 'error',
            error : new ContextRetiredError(contextId),
          })).catch((): void => {});
          void closeSubscription().catch((): void => {});
        }
      });
    }

    const opening = this._dwn.subscribeRecordFrames({
      paths,
      module: this.module,
    }, async (message, record): Promise<void> => {
      if (closed || signal?.aborted === true) {
        return;
      }
      if (message.type === 'event') {
        if (record === undefined) {
          throw new Error('TypedEnbox.records.subscribe: record event is missing its record handle.');
        }
        await deliver(this.recordSubscriptionChange<Selection>(record));
        return;
      }
      if (message.type === 'error') {
        closed = true;
        detachAbort();
        detachSync();
        await deliver({
          type  : 'error',
          error : new Error(`Record subscription failed (${message.error.code}): ${message.error.detail}`),
        });
      }
    });
    const reply = await whileSignalsActive(() => opening, [signal]).catch((error: unknown): never => {
      closed = true;
      detachSync();
      void opening.then(async (lateReply): Promise<void> => {
        await lateReply.subscription?.close();
      }).catch((): void => {});
      throw error;
    });

    try {
      requireDwnSuccess('TypedEnbox.records.subscribe', reply);
    } catch (error: unknown) {
      closed = true;
      detachSync();
      await reply.subscription?.close();
      throw error;
    }
    if (reply.subscription === undefined) {
      closed = true;
      detachSync();
      throw new Error('TypedEnbox.records.subscribe: DWN returned success without a subscription.');
    }
    const subscription = reply.subscription;
    let closePromise: Promise<void> | undefined;
    closeSubscription = (): Promise<void> => {
      closePromise ??= (async (): Promise<void> => {
        closed = true;
        detachAbort();
        detachSync();
        await subscription.close();
      })();
      return closePromise;
    };
    if (closed || signal?.aborted === true) {
      detachSync();
      let closeFailure: unknown;
      try {
        await closeSubscription();
      } catch (error: unknown) {
        closeFailure = error;
      }
      signal?.throwIfAborted();
      if (listenerFailure !== undefined) {
        throw listenerFailure.error;
      }
      if (closeFailure !== undefined) {
        throw closeFailure;
      }
      throw new Error('TypedEnbox.records.subscribe: closed while opening the subscription.');
    }
    const handleAbort = (): void => {
      void closeSubscription().catch((): void => {});
    };
    signal?.addEventListener('abort', handleAbort, { once: true });
    detachAbort = (): void => signal?.removeEventListener('abort', handleAbort);

    return { close: closeSubscription };
  }

  /** Open live delivery first, page current records, then drain buffered overlap. */
  private async subscribeToInitialRecordPaths<
    const Selection extends RecordSubscriptionSelection<ModulePaths<D> & string>,
  >(
    selection: Selection,
    options: InitialRecordSubscriptionOptions,
    listener: TypedRecordSubscriptionListener<C, ModuleSubscriptionPaths<D, Selection>, false>,
  ): Promise<RecordSubscription> {
    if (this._options.context === undefined) {
      throw new TypeError('TypedEnbox.records.subscribe: initial replay requires a context-bound records surface.');
    }
    type Change = TypedRecordChangeEvent<C, ModuleSubscriptionPaths<D, Selection>, false>;
    type Event = TypedRecordSubscriptionEvent<C, ModuleSubscriptionPaths<D, Selection>, false>;
    const overflow = new AbortController();
    const signal = combineAbortSignals(this._options.signal, options.signal, overflow.signal)!;
    signal.throwIfAborted();
    const whileOpening = <T>(operation: () => Promise<T>): Promise<T> =>
      whileSignalsActive(operation, [signal]);
    const bufferedChanges: Change[] = [];
    let subscriptionError: Error | undefined;
    const assertActive = (): void => {
      signal.throwIfAborted();
      if (subscriptionError !== undefined) {
        throw subscriptionError;
      }
    };
    let receive: TypedRecordSubscriptionListener<C, ModuleSubscriptionPaths<D, Selection>, false> = event => {
      if (event.type === 'error') {
        subscriptionError ??= event.error;
        return;
      }
      if (bufferedChanges.length === INITIAL_SUBSCRIPTION_OVERLAP_LIMIT) {
        bufferedChanges.length = 0;
        overflow.abort(new Error(
          `TypedEnbox.records.subscribe: initial replay exceeded the ${INITIAL_SUBSCRIPTION_OVERLAP_LIMIT}-change overlap limit.`,
        ));
        return;
      }
      bufferedChanges.push(event as Change);
    };
    let subscription: RecordSubscription;
    try {
      subscription = await whileOpening(() => this.subscribeToRecordPaths(selection, event => receive(event), signal));
    } catch (error: unknown) {
      assertActive();
      throw error;
    }
    const requestedPaths = typeof selection === 'string' ? [selection] : [...selection];
    const paths = [...new Set(requestedPaths.map(normalizePath))];
    let opening = true;
    const deliver = async (event: Event): Promise<void> => {
      assertActive();
      if (opening) {
        await whileOpening(() => Promise.resolve(listener(event)));
      } else {
        await listener(event);
      }
      assertActive();
    };

    try {
      assertActive();
      for (const path of paths) {
        let page: RecordPage<Record> | undefined = await whileOpening(() => this.records.query(
          path as ModulePaths<D> & string,
          {
            dateSort   : DateSort.CreatedAscending,
            pagination : { limit: INITIAL_SUBSCRIPTION_PAGE_LIMIT },
          },
        ) as Promise<RecordPage<Record>>);
        while (page !== undefined) {
          assertActive();
          for (const record of page.records) {
            await deliver(this.recordSubscriptionChange<Selection>(record));
          }
          const currentPage = page;
          page = await whileOpening(() => currentPage.next());
        }
      }
      let deliveryTail = Promise.resolve();
      for (const change of bufferedChanges) {
        deliveryTail = deliveryTail.then(() => deliver(change));
      }
      bufferedChanges.length = 0;
      const handoff = deliveryTail;
      receive = (event): void | Promise<void> => {
        if (event.type === 'error' && opening) {
          subscriptionError ??= event.error;
          return;
        }
        deliveryTail = deliveryTail.then(() => deliver(event));
        return deliveryTail;
      };
      await handoff;
      assertActive();
      opening = false;
      return subscription;
    } catch (error: unknown) {
      await subscription.close().catch((): void => {});
      assertActive();
      throw error;
    }
  }

  /** Require the module fact that gives `set()` one unambiguous target. */
  private assertSingletonScope(path: string, within: string | undefined): void {
    this._assertValidPath(path);
    if (getRuleSetAtPath(path, this._definition.structure)?.$recordLimit?.max !== 1) {
      throw new TypeError(`TypedEnbox.records.set: path '${path}' must declare $recordLimit.max: 1.`);
    }

    const node = this.resolveRecordNode(path);
    if (node.parentPhysicalDepth === 0) {
      if (within !== undefined) {
        throw new TypeError('TypedEnbox.records.set: a root singleton does not accept within.');
      }
      return;
    }

    assertValidRecordWithin(node, within, true);
    if (within.split('/').length !== node.parentPhysicalDepth) {
      throw new TypeError('TypedEnbox.records.set: within must identify the singleton\'s direct parent context.');
    }
  }

  /** Create one typed record through the module-bound DWN API. */
  private async createRecord<Path extends ModulePaths<D> & string>(
    path: Path,
    request: TypedCreateOptions<C, Path>,
    dwn: DwnApi = this._dwn,
  ): Promise<{
    audienceKeyDelivery?: AudienceKeyDeliveryOutcome;
    record: TypedRecord<DataForPath<C, Path>>;
  }> {
    const normalizedPath = normalizePath(path);
    if (getRuleSetAtPath(normalizedPath, this._definition.structure)?.$role === true
      && request.recipient === undefined) {
      throw new TypeError(`TypedEnbox.records.create: role path '${normalizedPath}' requires a recipient.`);
    }
    await this._ensureReady(normalizedPath);
    const parentContextId = this.resolveCreateParentContext(normalizedPath, request.parentContextId);
    const node = this.resolveRecordNode(normalizedPath);
    if (node.parentPhysicalDepth > 0) {
      assertValidRecordWithin(node, parentContextId, true);
      if (parentContextId!.split('/').length !== node.parentPhysicalDepth) {
        throw new TypeError(`TypedEnbox.records.create: parentContextId must identify the direct parent of '${normalizedPath}'.`);
      }
    } else if (parentContextId !== undefined) {
      throw new TypeError(`TypedEnbox.records.create: root path '${normalizedPath}' does not accept parentContextId.`);
    }
    const typeEntry = node.recordType;

    const codec = this.getCodec<Path>(normalizedPath);
    const encoded = await encodeRecordValue(codec, request.data, typeEntry?.dataFormats, {
      modulePath : normalizedPath,
      schema     : typeEntry?.schema,
    });
    const result = await dwn.records.write({
      data                   : encoded.data,
      from                   : request.from,
      parentContextId,
      published              : request.published,
      datePublished          : request.datePublished,
      dateCreated            : request.dateCreated,
      messageTimestamp       : request.messageTimestamp,
      recipient              : request.recipient,
      recipientRolePublicKey : request.recipientRolePublicKey,
      moduleRole             : request.moduleRole,
      squash                 : request.squash,
      tags                   : request.tags,
      module                 : this._definition.module,
      modulePath             : normalizedPath,
      ...(typeEntry?.schema === undefined ? {} : { schema: typeEntry.schema }),
      dataFormat             : encoded.dataFormat,
    });

    requireDwnSuccess('TypedEnbox.records.create', result);
    if (result.record === undefined) {
      throw new Error('TypedEnbox.records.create: DWN returned success without a record.');
    }

    return {
      ...(result.audienceKeyDelivery === undefined ? {} : { audienceKeyDelivery: result.audienceKeyDelivery }),
      record: this.bindCodec<Path>(normalizedPath, result.record),
    };
  }

  /** Project delivery for a role record whose active membership is already established. */
  private async resolveRoleDeliveryState(
    roleRecordId: string,
    retry: boolean,
    outcome?: AudienceKeyDeliveryOutcome,
  ): Promise<RoleDeliveryState> {
    if (outcome !== undefined) {
      return projectRoleDeliveryOutcome(outcome);
    }
    const roleDelivery = this._options.roleDelivery;
    if (roleDelivery === undefined) {
      throw new Error('OwnedContext.members requires an Enbox session.');
    }
    this._options.signal?.throwIfAborted();
    const state = await (retry ? roleDelivery.retry(roleRecordId) : roleDelivery.get(roleRecordId));
    if (state === undefined) {
      return { state: 'pending' };
    }
    return 'reason' in state ? { reason: state.reason, state: state.state } : { state: state.state };
  }

  /** Resolve the exact feed and operation paths governed by one contextual role. */
  private resolveMemberContextScope(role: string): {
    allowedPaths: ReadonlySet<string>;
    modulePath: ModulePaths<D> & string;
    readablePaths: [string, ...string[]];
    role: ContextRolePath<D>;
  } {
    const normalizedRole = normalizePath(role);
    this._assertValidPath(normalizedRole);
    const scope = resolveModuleRoleContextScope(this._definition, normalizedRole);

    return {
      allowedPaths  : scope.allowedPaths,
      modulePath    : scope.modulePath as ModulePaths<D> & string,
      readablePaths : scope.readablePaths,
      role          : normalizedRole as ContextRolePath<D>,
    };
  }

  /** Read the shared root policy; paths outside the encrypted context surface have no member roles. */
  private getContextRoles(path: string): readonly string[] {
    const root = this._definition.structure[path.split('/')[0]];
    return this._hasManagedSharedContext && this._validPaths.has(path) && typeof root?.$ref !== 'string'
      && !isModuleRolePath(this._definition, path)
      ? resolveModuleContextRoles(this._definition, path) : [];
  }

  /** Read all locally known intent records; absence alone never means a context was forgotten. */
  private async readContextFollows(): Promise<ContextFollowRecord[]> {
    const page = await this.records.query(CONTEXT_FOLLOW_PATH as ModulePaths<D> & string,
      CONTEXT_FOLLOW_QUERY as RecordQuery<D, ModulePaths<D> & string>);
    const rows: ContextFollowRecord[] = [];
    for await (const record of page) {
      const row = await this.readContextFollow(record);
      if (row !== undefined) {
        rows.push(row);
      }
    }
    return rows;
  }

  /** Append an encrypted recipient decision using the existing delegated record-write path. */
  private async appendContextFollow(intent: ContextFollowIntent, after?: string): Promise<ContextFollowRecord> {
    const timestamp = after === undefined ? Time.getCurrentTimestamp() : Time.createTimestampAfter(after);
    const { record } = await this.createRecord(CONTEXT_FOLLOW_PATH as ModulePaths<D> & string, {
      data             : intent,
      dateCreated      : timestamp,
      messageTimestamp : timestamp,
    } as unknown as TypedCreateOptions<C, ModulePaths<D> & string>);
    return { id: record.id, timestamp: record.timestamp, value: intent };
  }

  /** The context observer owns this ordinary paginated record view, including its close. */
  private async observeContextFollows(signal: AbortSignal): Promise<ExpandableRecordView<ContextFollowRecord>> {
    await whileSignalsActive(() => this._ensureReady(CONTEXT_FOLLOW_PATH), [signal, this._options.signal]);
    return createExpandableRecordView<ContextFollowRecord>({
      callerSignal       : signal,
      definition         : this._definition,
      resolvedGraph      : this._resolvedGraph,
      dwn                : this._dwn,
      materializeRecords : async (records): Promise<ContextFollowRecord[]> => {
        const rows = await Promise.all(records.map(record => this.readContextFollow(record)));
        return rows.filter((row): row is ContextFollowRecord => row !== undefined);
      },
      query  : compileRecordQuery(this._resolvedGraph, CONTEXT_FOLLOW_PATH, CONTEXT_FOLLOW_QUERY),
      signal : this._options.signal,
      sync   : this._options.sync,
    });
  }

  /** Skip malformed or foreign rows without treating them as instructions to change authority. */
  private async readContextFollow(record: Record): Promise<ContextFollowRecord | undefined> {
    if (record.creator !== this._dwn.connectedDid
      || record.module !== this._definition.module
      || record.modulePath !== CONTEXT_FOLLOW_PATH) {
      return undefined;
    }
    let value: ContextFollowIntent;
    try {
      value = await bindRecordCodec(record, contextFollowCodec,
        this._definition.types[CONTEXT_FOLLOW_PATH].dataFormats, this._options.signal).value();
    } catch (error: unknown) {
      if (error instanceof SyntaxError || error instanceof RecordValidationError) {
        return undefined;
      }
      throw error;
    }
    // Unsupported paths must not erase a newer saved choice.
    return { id: record.id, timestamp: record.timestamp, value };
  }

  /** Write one bounded discovery offer to the recipient's own module inbox. */
  private async sendContextInvitation(
    recipient : string,
    contextId : string,
    path : string,
    preview : ContextInvitationPreview | undefined,
  ): Promise<void> {
    await this.createRecord(
      CONTEXT_INVITATION_PATH as ModulePaths<D> & string,
      {
        data: {
          contextId,
          path,
          preview: normalizeContextInvitationPreview(preview),
        },
        from: recipient,
        recipient,
      } as unknown as TypedCreateOptions<C, ModulePaths<D> & string>,
    );
  }

  /** Query and project one bounded page of pending invitations. */
  private async listContextInvitations(
    limit : number | undefined,
    follow : (path: string, request: ContextFollowTarget) => Promise<MemberContext<D, C>>,
  ): Promise<ModuleContextInvitation<D, C>[]> {
    await this._ensureReady(CONTEXT_INVITATION_PATH);
    const result = await this._dwn.records.query(this.contextInvitationQuery(limit));
    requireDwnSuccess('TypedEnbox.contexts.invitations.list', result);
    return this.projectContextInvitations(result.records, follow);
  }

  /** Reuse RecordView for subscription, currentness, and serialized materialization. */
  private async observeContextInvitations(
    limit : number | undefined,
    follow : (path: string, request: ContextFollowTarget) => Promise<MemberContext<D, C>>,
    signal?: AbortSignal,
  ): Promise<RecordView<ModuleContextInvitation<D, C>>> {
    await whileSignalsActive(
      () => this._ensureReady(CONTEXT_INVITATION_PATH),
      [signal, this._options.signal],
    );
    return createRecordView<ModuleContextInvitation<D, C>>({
      callerSignal       : signal,
      definition         : this._definition,
      resolvedGraph      : this._resolvedGraph,
      dwn                : this._dwn,
      materializeRecords : records => this.projectContextInvitations(records, follow),
      query              : this.contextInvitationQuery(limit),
      signal             : this._options.signal,
      sync               : this._options.sync,
    });
  }

  /** Compile the canonical own-tenant invitation selection once per operation. */
  private contextInvitationQuery(limit: number | undefined): ReturnType<typeof compileRecordQuery> {
    return compileRecordQuery(this._resolvedGraph, CONTEXT_INVITATION_PATH, {
      dateSort   : DateSort.CreatedDescending,
      filter     : { recipient: this._dwn.connectedDid },
      pagination : { limit: normalizeContextInvitationLimit(limit) },
    });
  }

  /** Skip malformed peer input and collapse duplicate offers for one logical context. */
  private async projectContextInvitations(
    records : Record[],
    follow : (path: string, request: ContextFollowTarget) => Promise<MemberContext<D, C>>,
  ): Promise<ModuleContextInvitation<D, C>[]> {
    type Candidate = {
      contextId: string;
      path: string;
      ownerDid: string;
      preview: ContextInvitationPreview;
      records: Record[];
      selected: Record;
    };
    const candidates = new Map<string, Candidate>();

    for (const record of records) {
      const invitation = await this.readContextInvitation(record);
      if (invitation === undefined) {
        continue;
      }

      const key = JSON.stringify([invitation.ownerDid, invitation.contextId, invitation.path]);
      const existing = candidates.get(key);
      if (existing === undefined) {
        candidates.set(key, {
          ...invitation,
          records  : [record],
          selected : record,
        });
        continue;
      }

      existing.records.push(record);
      if (compareInvitationRecords(record, existing.selected) < 0) {
        existing.preview = invitation.preview;
        existing.selected = record;
      }
    }

    return [...candidates.values()]
      .sort((left, right) => compareInvitationRecords(left.selected, right.selected))
      .map((candidate): ModuleContextInvitation<D, C> => {
        let consumed = false;
        const dismiss = async (): Promise<void> => {
          if (consumed) {
            return;
          }
          await this.dismissContextInvitationRecords(candidate.records);
          consumed = true;
        };
        return Object.freeze({
          accept: async (): Promise<MemberContext<D, C>> => {
            if (consumed) {
              throw new Error('ContextInvitation: invitation is no longer pending.');
            }
            const context = await follow(candidate.path, {
              id       : candidate.contextId,
              ownerDid : candidate.ownerDid,
            });
            try {
              await dismiss();
            } catch {
              // Following is authoritative; inbox cleanup remains independently retryable.
            }
            return context;
          },
          contextId : candidate.contextId,
          dismiss,
          path      : candidate.path,
          id        : candidate.selected.id,
          ownerDid  : candidate.ownerDid,
          preview   : candidate.preview,
          timestamp : candidate.selected.timestamp,
        }) as ModuleContextInvitation<D, C>;
      });
  }

  /** Validate and decode one untrusted invitation inbox record. */
  private async readContextInvitation(record: Record): Promise<{
    contextId: string;
    path: string;
    ownerDid: string;
    preview: ContextInvitationPreview;
  } | undefined> {
    if (record.recipient !== this._dwn.connectedDid
      || record.module !== this._definition.module
      || record.modulePath !== CONTEXT_INVITATION_PATH) {
      return undefined;
    }
    const ownerDid = record.creator.trim();
    if (Did.parse(ownerDid)?.uri !== ownerDid) {
      return undefined;
    }
    const invitation = bindRecordCodec(
      record,
      contextInvitationCodec,
      this._definition.types[CONTEXT_INVITATION_PATH].dataFormats,
      this._options.signal,
    );
    let envelope: RecordCodecValue<typeof contextInvitationCodec>;
    try {
      envelope = await invitation.value();
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof RecordValidationError) {
        return undefined;
      }
      throw error;
    }
    if (this.getContextRoles(envelope.path).length === 0 || !isValidContextId(this.resolveRecordNode(envelope.path), envelope.contextId)) {
      return undefined;
    }
    return {
      contextId : envelope.contextId,
      path      : envelope.path,
      ownerDid,
      preview   : Object.freeze({ ...envelope.preview }),
    };
  }

  /** Delete every duplicate represented by one invitation handle; absence is already dismissed. */
  private async dismissContextInvitationRecords(records: readonly Record[]): Promise<void> {
    await Promise.all(records.map((record): Promise<void> =>
      this.records.delete(CONTEXT_INVITATION_PATH as ModulePaths<D> & string, { recordId: record.id })
    ));
  }

  /** Bind owner membership tasks to the root's declared alternative roles and their selection order. */
  private bindContextMembers(
    dwn: DwnApi,
    contextId: string,
    selectedRoles: readonly string[],
  ): ContextMembersApi<D, C, ContextRolePath<D>> {
    type Role = ContextRolePath<D>;
    type ActiveMemberRecord = { did: string; record: Record<unknown>; role: Role };

    const rolePaths = [...selectedRoles] as Role[];

    const activeRecords = <Value>(role: Role, records: readonly Record<Value>[]): ActiveMemberRecord[] =>
      records.map((record): ActiveMemberRecord => ({
        did    : record.recipient!,
        record : record as unknown as Record<unknown>,
        role,
      }));

    const bindActiveRecords = (role: Role, records: readonly Record[]): ActiveMemberRecord[] =>
      activeRecords(role, records.map(record => this.bindCodec<Role>(role, record)));

    const loadRole = async (role: Role, did?: string): Promise<ActiveMemberRecord[]> => {
      const page = await this.records.query(
        role,
        { within: contextId, ...(did === undefined ? {} : { filter: { recipient: did } }) },
      );
      return activeRecords(role, page.records);
    };

    const load = async (did?: string): Promise<ActiveMemberRecord[]> => {
      const perRole = await Promise.all(rolePaths.map(role => loadRole(role, did)));
      return perRole.flat();
    };

    const prefer = (
      current: ActiveMemberRecord | undefined,
      candidate: ActiveMemberRecord,
    ): ActiveMemberRecord => {
      if (current === undefined) {
        return candidate;
      }
      const precedence = rolePaths.indexOf(candidate.role) - rolePaths.indexOf(current.role);
      if (precedence !== 0) {
        return precedence < 0 ? candidate : current;
      }
      if (candidate.record.timestamp !== current.record.timestamp) {
        return candidate.record.timestamp > current.record.timestamp ? candidate : current;
      }
      return candidate.record.id > current.record.id ? candidate : current;
    };
    const preferred = (candidates: readonly ActiveMemberRecord[]): ActiveMemberRecord | undefined =>
      candidates.reduce<ActiveMemberRecord | undefined>(
        (current, candidate) => prefer(current, candidate),
        undefined,
      );

    const project = async (
      member: ActiveMemberRecord,
      retry: boolean = false,
      outcome?: AudienceKeyDeliveryOutcome,
    ): Promise<ContextMember<D, C, Role>> => {
      const [data, delivery] = await Promise.all([
        member.record.value(),
        this.resolveRoleDeliveryState(member.record.id, retry, outcome),
      ]);
      return Object.freeze({ data, delivery, did: member.did, role: member.role }) as ContextMember<D, C, Role>;
    };

    const get = async (did: string): Promise<ContextMember<D, C, Role> | undefined> => {
      const member = preferred(await load(normalizeMemberDid(did)));
      return member === undefined ? undefined : project(member);
    };

    const projectList = async (
      members: readonly ActiveMemberRecord[],
    ): Promise<ContextMember<D, C, Role>[]> => {
      const byDid = new Map<string, ActiveMemberRecord>();
      for (const member of members) {
        byDid.set(member.did, prefer(byDid.get(member.did), member));
      }
      return Promise.all([...byDid.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([, member]) => project(member)));
    };

    const deleteAssignments = async (
      assignments: readonly ActiveMemberRecord[],
    ): Promise<PromiseRejectedResult | undefined> => {
      const results = await Promise.allSettled(assignments.map(member => member.record.delete()));
      return results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    };
    const preferredAfterFailure = async (did: string): Promise<ActiveMemberRecord | undefined> => {
      try {
        return preferred(await load(did));
      } catch (cause: unknown) {
        throw new ContextNotReadyError(cause);
      }
    };

    return Object.freeze({
      get,
      list    : async (): Promise<ContextMember<D, C, Role>[]> => projectList(await load()),
      observe : async (options?: { signal?: AbortSignal }): Promise<RecordView<ContextMember<D, C, Role>>> => {
        const [primaryRole, ...additionalRoles] = rolePaths;
        await whileSignalsActive(
          () => this._ensureReady(primaryRole),
          [options?.signal, this._options.signal],
        );
        return createRecordView<ContextMember<D, C, Role>>({
          additionalWakeFilters: additionalRoles.map(role => compileRecordFilter(
            this._resolvedGraph,
            role,
            undefined,
            contextId,
          )),
          callerSignal       : options?.signal,
          definition         : this._definition,
          resolvedGraph      : this._resolvedGraph,
          dwn                : this._dwn,
          materializeRecords : async (records): Promise<ContextMember<D, C, Role>[]> => {
            const additional = await Promise.all(additionalRoles.map(role => loadRole(role)));
            return projectList([
              ...bindActiveRecords(primaryRole, records),
              ...additional.flat(),
            ]);
          },
          query            : compileRecordQuery(this._resolvedGraph, primaryRole, { within: contextId }),
          signal           : this._options.signal,
          subscribeToWakes : this._options.roleDelivery?.subscribe,
          sync             : this._options.sync,
        });
      },
      remove: async (did: string): Promise<void> => {
        const recipient = normalizeMemberDid(did);
        const failure = await deleteAssignments(await load(recipient));
        if (failure !== undefined && await preferredAfterFailure(recipient) !== undefined) {
          throw new ContextNotReadyError(failure.reason);
        }
      },
      retryDelivery: async (did: string): Promise<ContextMember<D, C, Role> | undefined> => {
        const member = preferred(await load(normalizeMemberDid(did)));
        return member === undefined ? undefined : project(member, true);
      },
      set: async (
        did: string,
        request: { data: unknown; role: string },
      ): Promise<ContextMember<D, C, Role>> => {
        const recipient = normalizeMemberDid(did);
        const role = normalizePath(request.role) as Role;
        if (!rolePaths.includes(role)) {
          throw new TypeError(`OwnedContext.members.set: role '${role}' is not a membership role for this context.`);
        }

        const existing = await load(recipient);
        const current = preferred(existing.filter(member => member.role === role));
        let accepted: ActiveMemberRecord;
        let outcome: AudienceKeyDeliveryOutcome | undefined;
        if (current === undefined) {
          const created = await this.createRecord(role as ModulePaths<D> & string, {
            data            : request.data,
            parentContextId : contextId,
            recipient,
          } as unknown as TypedCreateOptions<C, ModulePaths<D> & string>, dwn);
          accepted = { did: recipient, record: created.record as unknown as Record<unknown>, role };
          outcome = created.audienceKeyDelivery;
        } else {
          accepted = { did: recipient, record: await current.record.update({ data: request.data }), role };
        }

        const failure = await deleteAssignments(existing.filter(member => member.record.id !== accepted.record.id));
        if (failure !== undefined) {
          const effective = await preferredAfterFailure(recipient);
          if (effective?.role !== role) {
            throw new ContextNotReadyError(failure.reason);
          }
          if (effective.record.id !== accepted.record.id) {
            outcome = undefined;
          }
          accepted = effective;
        }
        return project(accepted, false, outcome);
      },
    }) as unknown as ContextMembersApi<D, C, Role>;
  }

  /** Bind the existing typed records surface to one exact durable source. */
  private bindMemberContext(
    source: FollowedSyncSource,
    forget: (expected: FollowedSyncSource, withdrawRole?: () => Promise<void>) => Promise<void>,
  ): MemberContext<D, C> {
    const scope = this.resolveMemberContextScope(source.moduleRole);
    const replicatedPaths = new Set(source.modulePaths);
    const readablePaths = new Set(scope.readablePaths);
    const modulePaths = new Set([...scope.allowedPaths].filter(path =>
      !readablePaths.has(path) || replicatedPaths.has(path)
    ));

    const sync = this._options.sync;
    if (sync === undefined) {
      throw new Error('TypedEnbox.contexts requires an Enbox session with shared-context storage.');
    }
    const controller = new AbortController();
    const signal = this._options.signal === undefined
      ? controller.signal
      : AbortSignal.any([this._options.signal, controller.signal]);
    const assertActive = async (): Promise<void> => {
      signal.throwIfAborted();
      const current = await sync.getFollowedSource(source.id);
      signal.throwIfAborted();
      if (current === undefined || !followedSyncSourceActiveEqual(current, source)) {
        throw new ContextRetiredError(source.contextId);
      }
    };
    const dwn = this._dwn.withRecordExecutionContext({
      assertActive,
      contextId                  : source.contextId,
      followedSourceAcceptanceId : source.acceptanceId,
      followedSourceId           : source.id,
      invalidateReplica          : async (): Promise<void> => {
        await sync.markFollowedSourcePullPending(source);
      },
      moduleRole     : source.moduleRole,
      remoteEndpoint : source.remoteEndpoint,
      tenantDid      : source.sourceDid,
    });
    const membershipDwn = this._dwn.withRecordExecutionContext({
      assertActive,
      contextId      : source.contextId,
      remoteEndpoint : source.remoteEndpoint,
      tenantDid      : source.sourceDid,
    });
    const withdrawRole = async (): Promise<void> => {
      const result = await membershipDwn.records.delete({
        contextId  : source.contextId,
        module     : source.module,
        modulePath : source.moduleRole,
        recordId   : source.id,
      });
      if (result.status.code !== 404 && !isCanonicalConflictStatus(result.status)) {
        requireDwnSuccess('MemberContext.leave', result);
      }
    };
    const retire = async (withdraw?: () => Promise<void>): Promise<void> => {
      this._options.signal?.throwIfAborted();
      await forget(source, withdraw);
      const current = await sync.getFollowedSource(source.id);
      if (current === undefined || !followedSyncSourceActiveEqual(current, source)) {
        controller.abort(new ContextRetiredError(source.contextId));
      }
    };
    const refresh = async (): Promise<void> => {
      await assertActive();
      try {
        if (!await sync.pullFollowedSource(source)) {
          throw new Error(
            `MemberContext.refresh: replication did not reach the feed head for context ` +
            `'${source.contextId}' owned by '${source.sourceDid}'.`,
          );
        }
      } catch (error: unknown) {
        await assertActive();
        if (error instanceof ContextNotReadyError) {
          throw error;
        }
        throw new ContextNotReadyError(error);
      }
      await assertActive();
    };

    return Object.freeze({
      access   : 'member',
      forget   : (): Promise<void> => retire(),
      id       : source.contextId,
      key      : moduleContextKey(source.sourceDid, source.contextId),
      leave    : (): Promise<void> => retire(withdrawRole),
      ownerDid : source.sourceDid,
      path     : scope.modulePath,
      records  : this.bindContextRecords(dwn, {
        contextId  : source.contextId,
        modulePath : scope.modulePath,
        modulePaths,
      }, signal),
      role         : scope.role,
      rootRecordId : contextRootRecordId(source.contextId),
      refresh,
    }) as unknown as MemberContext<D, C>;
  }

  /** Reuse one typed records implementation with tenant and root routing already bound. */
  private bindContextRecords<Root extends ModulePaths<D> & string>(
    dwn: DwnApi,
    context: NonNullable<TypedEnboxOptions['context']> & { modulePath: Root },
    signal: AbortSignal | undefined = this._options.signal,
  ): ContextRecordsApi<D, C, Root> {
    return new TypedEnbox<D, C>(
      dwn,
      {
        codecs        : this._codecs,
        definition    : this._definition,
        dependencies  : this._dependencies,
        resolvedGraph : this._resolvedGraph,
      },
      {
        context,
        signal,
        sync: this._options.sync,
      },
    ).records as unknown as ContextRecordsApi<D, C, Root>;
  }

  /**
   * Ensures the module is configured before performing record operations.
   *
   * On first call, queries for an existing module installation:
   * - If found with an identical definition → marks as configured.
   * - If found with a different definition → marks as configured but warns
   *   that the local definition differs from the installed one.
   * - If not found → installs the module via `modules.configure()`.
   *
   * Concurrent calls are deduplicated via a shared Promise so the network
   * call only happens once.
   */
  private async _ensureReady(path: string): Promise<void> {
    this._assertActive();
    this.assertContextPath(path);
    if (this._configured) {
      this._assertValidPath(path);
      return;
    }

    this._ensureReadyPromise ??= this._autoConfigureOnce().catch((cause: unknown): never => {
      this._ensureReadyPromise = null;
      throw cause;
    });

    await this._ensureReadyPromise;
    this._assertActive();
    this._assertValidPath(path);
  }

  /** Reject operations after the owning Enbox facade ends. */
  private _assertActive(): void {
    this._options.signal?.throwIfAborted();
  }

  /** Require bound-root coverage and apply the context's default selector. */
  private resolveContextWithin(path: string, within: string | undefined): string | undefined {
    const context = this._options.context;
    if (context === undefined) {
      return within;
    }
    this.assertContextPath(path);
    const resolved = within ?? context.contextId;
    if (resolved !== context.contextId && !resolved.startsWith(`${context.contextId}/`)) {
      throw new TypeError('Context-bound selectors cannot escape their context.');
    }
    return resolved;
  }

  /** Default direct-child writes to the bound root and reject ambiguous deeper writes. */
  private resolveCreateParentContext(path: string, parentContextId: string | undefined): string | undefined {
    const context = this._options.context;
    if (context === undefined) {
      return parentContextId;
    }
    if (parentContextId !== undefined) {
      return this.resolveContextWithin(path, parentContextId);
    }
    if (path === context.modulePath) {
      throw new TypeError('Context-bound records cannot create another context root.');
    }
    const parentPath = path.split('/').slice(0, -1).join('/');
    if (parentPath !== context.modulePath) {
      throw new TypeError(`Context-bound create at '${path}' requires its direct parent context.`);
    }
    return context.contextId;
  }

  private assertContextPath(path: string): void {
    const context = this._options.context;
    if (context !== undefined && !context.modulePaths.has(path)) {
      throw new TypeError(`Context-bound records do not expose path '${path}'.`);
    }
  }

  /**
   * Performs the one-time auto-configuration check. Called at most once;
   * subsequent calls reuse the same Promise via `_ensureReadyPromise`.
   */
  private async _autoConfigureOnce(): Promise<void> {
    await this.ensureDependenciesReady();
    const query = await this._dwn.modules.query({
      filter: { module: this._definition.module },
    });
    requireDwnSuccess('TypedEnbox automatic module query', query);
    const { modules } = query;

    if (modules.length > 0) {
      const existing = modules[0];
      const definitionsMatch = authoredModuleDefinitionsEqual(existing.definition, this._definition);
      const encryptionKeysComplete = !(this._requiresKeyAgreement || Modules.requiresKeyAgreement(existing.definition))
        || collectMissingKeyAgreementPaths(existing.definition).length === 0;
      if (definitionsMatch && encryptionKeysComplete) {
        this._configured = true;
        return;
      }

      if (!this._dwn.isDelegate && !definitionsMatch) {
        await this.assertComposedLocalRepresentations(existing.definition);
        if (!encryptionKeysComplete) {
          throw new Error(
            `TypedEnbox: installed module '${this._definition.module}' has incomplete $keyAgreement metadata; ` +
            'the owner must repair its installed definition.',
          );
        }
        // Installed but definitions differ — allow operations but warn.
        console.warn(
          `TypedEnbox: installed module '${this._definition.module}' differs from the provided definition. ` +
          'Call configure() to update it.',
        );
        this._configured = true;
        return;
      }
    }

    if (this._dwn.isDelegate) {
      await this._autoConfigureDelegateModule();
      return;
    }

    // Not installed locally — configure it now.
    const result = await this._dwn.modules.configure({
      definition: this._definition,
    });
    requireDwnSuccess('TypedEnbox automatic module configure', result);
    this._configured = true;
  }

  private dependencyApi(module: ModuleDependency): TypedEnbox {
    let api = this._dependencyApis.get(module);
    if (api === undefined) {
      api = new TypedEnbox(this._dwn, module, {
        dependency     : true,
        dependencyApis : this._dependencyApis,
        signal         : this._options.signal,
        sync           : this._options.sync,
      });
      this._dependencyApis.set(module, api);
    }
    return api;
  }

  private async ensureDependenciesReady(): Promise<void> {
    this._dependenciesReady ??= this.prepareDependencies().catch((cause: unknown): never => {
      this._dependenciesReady = undefined;
      throw cause;
    });
    await this._dependenciesReady;
  }

  private async prepareDependencies(): Promise<void> {
    for (const dependency of Object.values(this._dependencies)) {
      const api = this.dependencyApi(dependency);
      if (!api.isConfigured) {
        await api.ensureInstalled();
      }
    }
    await this.verifyDependencyContracts();
  }

  private async verifyDependencyContracts(): Promise<void> {
    if (Object.keys(this._dependencies).length === 0) {
      return;
    }
    const installedGraph = await this.resolveInstalledGraph(this._definition);
    // Only this binding's explicit imports are consumed contracts. Providers'
    // unrelated records and actions can evolve without changing those imports.
    validateImportedModuleContracts(this._resolvedGraph, installedGraph);
  }

  private async resolveInstalledGraph(definition: ModuleDefinition): Promise<ResolvedModuleGraph> {
    const definitions = await preloadModuleDefinitions(definition, async uri => {
      const query = await this._dwn.modules.query({
        ...(this._dwn.isDelegate ? { from: this._dwn.connectedDid } : {}),
        filter: { module: uri },
      });
      requireDwnSuccess(`TypedEnbox dependency query '${uri}'`, query);
      const installed = query.modules[0]?.definition;
      if (installed !== undefined) {
        assertInstalledDependencyKeys(installed);
      }
      return installed;
    });
    return resolveModuleGraph(definition, uri => definitions.get(uri), { requireKeyAgreement: false });
  }

  /** A composing binding must not apply its local codecs to a different installed representation. */
  private async assertComposedLocalRepresentations(installed: ModuleDefinition): Promise<void> {
    if (Object.keys(this._dependencies).length === 0) {
      return;
    }
    const graph = await this.resolveInstalledGraph(installed);
    for (const [path, expected] of this._resolvedGraph.nodesByDeclaredPath) {
      if (expected.kind !== 'record') {
        continue;
      }
      const actual = graph.nodesByDeclaredPath.get(path);
      if (actual?.kind !== 'record' || !installedModuleDefinitionsEqual(
        consumedRecordRepresentation(expected), consumedRecordRepresentation(actual),
      )) {
        throw new Error(
          `TypedEnbox: installed module '${installed.module}' changed the consumed representation at '${path}'; ` +
          'update the application binding before using its record APIs.',
        );
      }
    }
  }

  /**
   * For delegates: fetch the owner's signed ModulesConfigure message through
   * normal routing and import that same wallet-owned message locally.
   *
   * The wallet definition is validated before import, and the active local
   * definition is checked afterward before this instance is marked configured.
   */
  private async _autoConfigureDelegateModule(asDependency = false): Promise<ModulesConfigureResponse> {
    const remote = await this._dwn.modules.query({
      filter : { module: this._definition.module },
      from   : this._dwn.connectedDid,
    });
    requireDwnSuccess(
      `TypedEnbox delegate wallet module query for '${this._definition.module}'; reconnect to refresh delegated grants`,
      remote,
    );

    const remoteModules = remote.modules;
    const remoteModule = remoteModules[0];
    if (!asDependency && this._options.dependency !== true) {
      const verification = this._assessInstalledDefinition(remoteModule?.definition, true);
      if (verification.error !== undefined) {
        throw verification.error;
      }
    }
    if (remoteModule === undefined) {
      throw new Error(`TypedEnbox: verified wallet module '${this._definition.module}' is unavailable.`);
    }
    if (remoteModule.definition.module !== this._definition.module) {
      throw new Error(`TypedEnbox: wallet returned a different module for '${this._definition.module}'.`);
    }

    assertInstalledDependencyKeys(remoteModule.definition);
    const remoteModulesByUri = new Map<string, Module>([[remoteModule.definition.module, remoteModule]]);
    const definitions = await preloadModuleDefinitions(remoteModule.definition, async uri => {
      const query = await this._dwn.modules.query({ filter: { module: uri }, from: this._dwn.connectedDid });
      requireDwnSuccess(`TypedEnbox delegate dependency query '${uri}'`, query);
      const dependency = query.modules[0];
      if (dependency !== undefined) {
        assertInstalledDependencyKeys(dependency.definition);
        remoteModulesByUri.set(uri, dependency);
      }
      return dependency?.definition;
    });
    resolveModuleGraph(remoteModule.definition, uri => definitions.get(uri), { requireKeyAgreement: false });

    // Import current wallet-signed metadata in its actual dependency order.
    // No packaged codec or extra grant is needed for an unrelated new import.
    const imported = new Map<string, ModulesConfigureResponse>();
    const importModule = async (module: Module): Promise<ModulesConfigureResponse> => {
      const uri = module.definition.module;
      const previous = imported.get(uri);
      if (previous !== undefined) {
        return previous;
      }
      for (const target of Object.values(module.definition.uses ?? {})) {
        await importModule(remoteModulesByUri.get(target)!);
      }
      const result = await this._dwn.importModuleConfiguration(module.toJSON());
      if ((result.status.code < 200 || result.status.code > 299) && result.status.code !== 409) {
        throw new DwnResponseError(`TypedEnbox delegate module import for '${uri}'`, result.status);
      }
      const local = await this._dwn.modules.query({ filter: { module: uri } });
      requireDwnSuccess(`TypedEnbox delegate local module query for '${uri}'`, local);
      if (!installedModuleDefinitionsEqual(local.modules[0]?.definition, module.definition)) {
        throw new Error(`TypedEnbox: wallet module '${uri}' was imported but is not the active local definition.`);
      }
      imported.set(uri, result);
      return result;
    };
    const result = await importModule(remoteModule);
    this._configured = true;
    return result;
  }

  /** Read and bind one typed record, optionally from a bound context's authority. */
  private async readTypedRecord<Path extends ModulePaths<D> & string>(
    path: Path,
    request: TypedReadRequest<D, Path>,
    authoritativeContext: boolean,
  ): Promise<TypedRecordReadResult<DataForPath<C, Path>>> {
    const normalizedPath = normalizePath(path);
    await this._ensureReady(normalizedPath);
    const within = this.resolveContextWithin(normalizedPath, request.within);
    const readRequest = {
      from   : request.from,
      filter : compileRecordFilter(
        this._resolvedGraph,
        normalizedPath,
        request.filter,
        within,
      ),
      moduleRole: request.moduleRole,
    };
    const authoritativeResult = authoritativeContext
      ? await this._dwn.readRecordForMutation(readRequest)
      : undefined;
    const result = authoritativeResult ?? await this._dwn.records.read(readRequest);

    if (result.status.code === 404) {
      return {
        record: undefined,
        ...(authoritativeResult?.tombstonePrune === undefined
          ? {}
          : { tombstonePrune: authoritativeResult.tombstonePrune }),
      };
    }
    requireDwnSuccess('TypedEnbox.records.read', result);
    const record = result.record === undefined
      ? undefined
      : this.bindCodec<Path>(normalizedPath, result.record);
    return { record };
  }

  /**
   * Module-scoped record operations.
   *
   * Every method auto-injects the `module`, `modulePath`, and `schema`
   * from the module definition — you never need to specify them manually.
   * Path parameters provide **compile-time autocompletion** via
   * `ModulePaths<D>`, and data types are resolved from the module codecs.
   *
   * Record-returning methods use canonical {@link Record} instances carrying
   * the resolved data type from the codec map.
   *
   * Available methods:
   * - `create(path, request)` — Create a new record
   * - `query(path, request?)` — Query records with filters
   * - `observe(path, request)` — Observe immutable query state
   * - `subscribe(pathOrPaths, listener)` — Consume path-discriminated committed changes
   * - `count(path, request?)` — Count the same matching population
   * - `read(path, recordId or request)` — Read a single record
   * - `patch(path, recordId, patch)` — Apply a partial update with one conflict retry
   * - `set(path, request)` — Replace one module-declared singleton
   * - `delete(path, request)` — Delete a record by ID
   */
  public get records(): TypedRecordsApi<D, C> {
    if (this._records !== undefined) {
      return this._records;
    }

    const cached = {
      /**
       * Create a new record at the given module path.
       *
       * The `module`, `modulePath`, and `schema` are auto-injected from
       * the module definition. The `data` field is type-checked against
       * the codec for the given path.
       *
       * @param path - The module path (e.g. `'notebook'`, `'notebook/page'`).
       *   Provides compile-time autocompletion for valid paths.
       * @param request - Create options including the typed `data` payload
       *   and optional fields like `parentContextId`, `tags`, `recipient`.
       * @returns The created typed {@link Record}.
       *
       * @example
       * ```ts
       * const record = await notebooks.records.create('notebook', {
       *   data: { name: 'My Notebook' },
       * });
       *
       * // Create a child page under the notebook's context
       * const page = await notebooks.records.create('notebook/page', {
       *   data: { title: 'First Page', body: '' },
       *   parentContextId: record.contextId,
       * });
       * ```
       */
      create: async <Path extends ModulePaths<D> & string>(
        path: Path,
        request: TypedCreateRequest<D, C, Path>,
      ): Promise<TypedRecord<DataForPath<C, Path>>> => (await this.createRecord(path, request)).record,

      /**
       * Query records at the given module path.
       *
       * Returns matching records as one page of typed records. Call `next()`
       * to continue the same captured query when another page exists. Set
       * `materialize` to eagerly decode one explicitly bounded page while
       * retaining each canonical record handle. Selected direct children must
       * declare `$recordLimit.max: 1` and are fetched once per child path.
       * Materialization is fail-closed: any decode or validation failure
       * rejects the page. Omit it to handle `record.value()` per record.
       *
       * @param path - The module path to query (e.g. `'notebook'`,
       *   `'notebook/page'`).
       * @param request - Optional filter, sort, and pagination options.
       *   Omit entirely to return all records at the path.
       * @returns A page containing typed {@link Record} instances and an
       *   optional continuation available through `next()`.
       *
       * @example
       * ```ts
       * // Query all notebooks
       * const { records } = await notebooks.records.query('notebook');
       *
       * // Query pages under a specific notebook
       * const { records: pages } = await notebooks.records.query('notebook/page', {
       *   within: notebook.contextId,
       * });
       *
       * for (const page of pages) {
       *   const data = await page.value(); // PageData
       * }
       *
       * // Paginated query
       * const firstPage = await notebooks.records.query('notebook', {
       *   pagination: { limit: 10 },
       *   dateSort: DateSort.CreatedDescending,
       * });
       * const secondPage = await firstPage.next();
       * ```
       */
      query: async <
        Path extends ModulePaths<D> & string,
        Materialization extends RecordMaterialization<D, Path> | undefined = undefined,
      >(...args: TypedQueryArguments<D, Path, Materialization>): Promise<
        RecordPage<RecordRepresentation<D, C, Path, Materialization>>
      > => {
        const [path, request] = args;
        const capturedRequest = request === undefined ? undefined : structuredClone(request);
        const normalizedPath = normalizePath(path);
        const within = this.resolveContextWithin(normalizedPath, capturedRequest?.within);
        const materialize = capturedRequest?.materialize;
        const childPaths = this.resolveMaterializedChildPaths<Path>(
          normalizedPath,
          materialize,
          capturedRequest?.pagination?.limit,
        );
        await this._ensureReady(normalizedPath);
        const canonicalQuery = compileRecordQuery(this._resolvedGraph, normalizedPath, {
          ...capturedRequest,
          within,
        });
        const queryPage = async (
          compiledQuery : typeof canonicalQuery,
          priorCursor : PaginationCursorLineage | undefined,
        ): Promise<RecordPage<RecordRepresentation<D, C, Path, Materialization>>> => {
          this._assertActive();
          const result = await this._dwn.records.query(compiledQuery);
          requireDwnSuccess('TypedEnbox.records.query', result);

          const continuation = result.cursor === undefined ? undefined : { ...result.cursor };
          let pageCursor = priorCursor;
          if (continuation !== undefined) {
            const key = paginationCursorKey(continuation);
            if (paginationCursorSeen(priorCursor, key)) {
              throw new Error('RecordPage: query returned a repeated pagination cursor.');
            }
            pageCursor = { key, previous: priorCursor };
          }

          const page: RecordPage<RecordRepresentation<D, C, Path, Materialization>> = {
            records: [...await this.representRecords<Path, Materialization>(
              normalizedPath,
              result.records,
              materialize,
              childPaths,
              { from: canonicalQuery.from, moduleRole: canonicalQuery.moduleRole, within },
            )],
            next: async (): Promise<RecordPage<
              RecordRepresentation<D, C, Path, Materialization>
            > | undefined> => continuation === undefined
              ? undefined
              : queryPage({
                ...canonicalQuery,
                pagination: { ...canonicalQuery.pagination, cursor: continuation },
              }, pageCursor),
            async *[Symbol.asyncIterator](): AsyncIterator<
              RecordRepresentation<D, C, Path, Materialization>
              > {
              let current: RecordPage<
                RecordRepresentation<D, C, Path, Materialization>
              > | undefined = page;
              while (current !== undefined) {
                yield* current.records;
                current = await current.next();
              }
            },
          };
          return page;
        };

        return queryPage(canonicalQuery, undefined);
      },

      /**
       * Observe one bounded query as immutable materialized state.
       *
       * A subscription is installed before the initial query. Its
       * payloads are wake hints only; every published collection comes from
       * re-running this exact canonical query. A pagination limit is required
       * so the view's retained collection has an explicit resource bound.
       * When requested, query and observe share the same fail-closed
       * materialization path, so any decode or validation failure publishes
       * an error state.
       */
      observe: async <
        Path extends ModulePaths<D> & string,
        Materialization extends RecordMaterialization<D, Path> | undefined = undefined,
      >(
        path: Path,
        request: RecordObserveRequest<D, Path, Materialization>,
      ): Promise<ExpandableRecordView<RecordRepresentation<D, C, Path, Materialization>>> => {
        request?.signal?.throwIfAborted();
        this._options.signal?.throwIfAborted();
        const normalizedPath = normalizePath(path);
        if (request?.pagination?.limit === undefined) {
          throw new TypeError('RecordView: pagination.limit is required to bound retained records.');
        }
        const { materialize, signal, ...query } = request;
        const within = this.resolveContextWithin(normalizedPath, query.within);
        const childPaths = this.resolveMaterializedChildPaths<Path>(
          normalizedPath,
          materialize,
          query.pagination.limit,
        );
        const compiled = structuredClone(compileRecordQuery(this._resolvedGraph, normalizedPath, { ...query, within }));
        const additionalWakeFilters = childPaths.map((childPath): RecordsFilter => compileRecordFilter(
          this._resolvedGraph,
          childPath,
          undefined,
          within,
        ));
        await whileSignalsActive(
          () => this._ensureReady(normalizedPath),
          [signal, this._options.signal],
        );

        return createExpandableRecordView<RecordRepresentation<D, C, Path, Materialization>>({
          additionalWakeFilters,
          callerSignal       : signal,
          definition         : this._definition,
          resolvedGraph      : this._resolvedGraph,
          dwn                : this._dwn,
          materializeRecords : async (records): Promise<readonly RecordRepresentation<
            D,
            C,
            Path,
            Materialization
          >[]> => this.representRecords<Path, Materialization>(
            normalizedPath,
            records,
            materialize as Materialization,
            childPaths,
            { from: compiled.from, moduleRole: compiled.moduleRole, within },
          ),
          query  : compiled,
          signal : this._options.signal,
          sync   : this._options.sync,
        });
      },

      subscribe: async <const Selection extends RecordSubscriptionSelection<ModulePaths<D> & string>>(
        selection: Selection,
        ...args:
          | [listener: TypedRecordSubscriptionListener<C, ModuleSubscriptionPaths<D, Selection>, false>]
          | [
            options: RecordSubscriptionOptions,
            listener: TypedRecordSubscriptionListener<C, ModuleSubscriptionPaths<D, Selection>, false>,
          ]
          | [
            options: InitialRecordSubscriptionOptions,
            listener: TypedRecordSubscriptionListener<C, ModuleSubscriptionPaths<D, Selection>, false>,
          ]
      ): Promise<RecordSubscription> => {
        if (args.length === 1) {
          return this.subscribeToRecordPaths(selection, args[0]);
        }
        if ('initial' in args[0] && args[0].initial === true) {
          return this.subscribeToInitialRecordPaths(selection, args[0], args[1]);
        }
        return this.subscribeToRecordPaths(
          selection,
          args[1],
          combineAbortSignals(this._options.signal, args[0].signal),
        );
      },

      /**
       * Count the complete population selected by the same specification as
       * `query()`. Pagination and ordering do not change the count; a
       * published-date sort still selects published records only.
       */
      count: async <Path extends ModulePaths<D> & string>(
        path: Path,
        request?: RecordQuery<D, Path>,
      ): Promise<number> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const compiled = compileRecordQuery(this._resolvedGraph, normalizedPath, {
          ...request,
          within: this.resolveContextWithin(normalizedPath, request?.within),
        });

        const result = await this._dwn.records.count({
          from       : compiled.from,
          filter     : compiled.filter,
          moduleRole : compiled.moduleRole,
        });
        requireDwnSuccess('TypedEnbox.records.count', result);
        if (result.count === undefined) {
          throw new Error('TypedEnbox.records.count: DWN returned success without a count.');
        }
        return result.count;
      },

      /**
       * Read a single record at the given module path.
       *
       * Unlike `query()`, which returns an array, `read()` returns exactly
       * one record. Pass its record ID directly for a local point read, or use
       * a request object for advanced filters and routing.
       *
       * @param path - The module path to read from.
       * @param recordIdOrRequest - A record ID, or advanced read options. See
       *   {@link TypedReadRequest} for details.
       * @returns The matching typed {@link Record}, or `undefined` when no
       *   current record exists.
       *
       * @example
       * ```ts
       * const record = await notebooks.records.read('notebook', notebookId);
       *
       * if (record === undefined) {
       *   throw new Error('Notebook not found');
       * }
       *
       * const data = await record.value(); // NotebookData
       * console.log(data.name);
       * ```
       */
      read: async <Path extends ModulePaths<D> & string>(
        path: Path,
        recordIdOrRequest: string | TypedReadRequest<D, Path>,
      ): Promise<TypedRecord<DataForPath<C, Path>> | undefined> => {
        const request: TypedReadRequest<D, Path> = typeof recordIdOrRequest === 'string'
          ? { filter: { recordId: recordIdOrRequest } }
          : recordIdOrRequest;
        return (await this.readTypedRecord(path, request, false)).record;
      },

      /**
       * Apply a shallow partial update, re-reading and retrying once when the
       * DWN rejects an out-of-order write with its canonical 409 response.
       * A producer receives the freshly decoded value and may return
       * `undefined` to skip the write. Because it may run twice, it must be
       * side-effect-free.
       *
       * This is bounded conflict recovery, not a transaction or compare-and-
       * swap. A concurrent write accepted after the read can still be replaced
       * by the DWN's normal last-writer-wins ordering.
       */
      patch: async <Path extends ModulePaths<D> & string>(
        path: Path,
        recordId: string,
        patch: RecordPatchInput<DataForPath<C, Path>>,
      ): Promise<TypedRecord<DataForPath<C, Path>>> => {
        let retried = false;
        while (true) {
          const { record } = await this.readTypedRecord(path, { filter: { recordId } }, true);
          if (record === undefined) {
            throw new DwnResponseError('TypedEnbox.records.patch', { code: 404, detail: 'Not Found' });
          }

          const current = await record.value();
          const resolvedPatch = typeof patch === 'function'
            ? await patch(current)
            : patch;
          if (resolvedPatch === undefined) {
            return record;
          }

          try {
            return await record.update({ data: mergeRecordPatch(current, resolvedPatch) });
          } catch (error: unknown) {
            if (!isCanonicalRecordConflict(error)) {
              throw error;
            }
            if (retried) {
              throw new RecordConflictError(path, recordId, error);
            }
            retried = true;
          }
        }
      },

      /**
       * Replace the visible value at a module-declared singleton path.
       *
       * The path must declare `$recordLimit.max: 1`. The current visible
       * occupant is updated in place; an empty scope creates its first record.
       * This is deliberately not a generic upsert and does not add locking or
       * conflict semantics beyond the DWN's deterministic occupant projection.
       * The caller needs both query and write authorization because selecting
       * the current occupant precedes the create or update. Delegates must
       * have a matching Records.Read grant that covers RecordsQuery.
       */
      set: async <Path extends SingletonModulePaths<D> & string>(
        path: Path,
        request: TypedSetRequest<C, Path>,
      ): Promise<TypedRecord<DataForPath<C, Path>>> => {
        const normalizedPath = normalizePath(path);
        const within = this.resolveContextWithin(normalizedPath, request.within);
        this.assertSingletonScope(normalizedPath, within);
        if ('from' in request && request.from !== undefined) {
          throw new TypeError('TypedEnbox.records.set: remote targets are not supported.');
        }
        if ('moduleRole' in request && request.moduleRole !== undefined) {
          throw new TypeError('TypedEnbox.records.set: module roles are not supported.');
        }
        await this._ensureReady(normalizedPath);
        const query = compileRecordQuery(this._resolvedGraph, normalizedPath, {
          pagination: { limit: 1 },
          within,
        });
        const result = await this._dwn.queryRecordsWithRequiredGrant(query);
        requireDwnSuccess('TypedEnbox.records.set query', result);
        const existing = result.records[0];
        if (existing === undefined) {
          return (await this.createRecord(path, {
            data             : request.data,
            datePublished    : request.datePublished,
            messageTimestamp : request.messageTimestamp,
            parentContextId  : within,
            published        : request.published,
            tags             : request.tags,
          })).record;
        }

        const record = this.bindCodec<Path>(normalizedPath, existing);
        const update: RecordUpdateParams<DataForPath<C, Path>> = {
          data          : request.data,
          datePublished : request.datePublished,
          published     : request.published,
          tags          : request.tags,
          timestamp     : request.messageTimestamp,
        };
        removeUndefinedProperties(update);
        await record.update(update);
        return record;
      },

      /**
       * Delete a record at the given module path.
       *
       * The path is used for module validation and permission scoping,
       * while the actual record is identified by `recordId`.
       *
       * @param path - The module path (used for permission scoping and
       *   path validation).
       * @param request - Delete options. `recordId` is required; `within`
       *   scopes delegated grant resolution and `from` selects a remote DWN.
       * @returns A promise that resolves when the delete is accepted. A
       *   context-bound miss resolves only when the authority returns an
       *   authorized tombstone proving the record was deleted in this context.
       *
       * @example
       * ```ts
       * await notebooks.records.delete('notebook', {
       *   recordId: notebook.id,
       * });
       * ```
       */
      delete: async <Path extends ModulePaths<D> & string>(
        path: Path,
        request: TypedDeleteRequest,
      ): Promise<void> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        if (Object.hasOwn(request, 'contextId')) {
          throw new TypeError('TypedDeleteRequest: use within instead of contextId.');
        }
        const within = this.resolveContextWithin(normalizedPath, request.within);
        assertValidRecordWithin(this.resolveRecordNode(normalizedPath), within, false);
        if (this._options.context !== undefined) {
          const { record, tombstonePrune } = await this.readTypedRecord(path, {
            filter     : { recordId: request.recordId },
            from       : request.from,
            moduleRole : request.moduleRole,
            within,
          }, true);
          if (record === undefined) {
            if (tombstonePrune === undefined) {
              throw new DwnResponseError('TypedEnbox.records.delete authority', {
                code   : 404,
                detail : 'Not Found',
              });
            }
            if (request.prune !== true || tombstonePrune) {
              await this._dwn.invalidateRecordReplica();
              return;
            }
          }
        }
        const result = await this._dwn.records.delete({
          contextId  : within,
          from       : request.from,
          module     : this._definition.module,
          modulePath : normalizedPath,
          moduleRole : request.moduleRole,
          recordId   : request.recordId,
          prune      : request.prune,
        });
        if (result.status.code === 404 && this._options.context === undefined) {
          return;
        }
        if (isCanonicalConflictStatus(result.status)) {
          if (this._options.context !== undefined) {
            await this._dwn.invalidateRecordReplica();
          }
          return;
        }
        requireDwnSuccess('TypedEnbox.records.delete', result);
      },

    };

    this._records = cached;
    return cached;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeContextInvitationLimit(limit: number = 50): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Context invitations: limit must be an integer from 1 through 100.');
  }
  return limit;
}

/** Only a plain DWN ordering conflict is safe to recover by re-reading. */
function isCanonicalRecordConflict(error: unknown): error is DwnResponseError {
  return error instanceof DwnResponseError
    && isCanonicalConflictStatus(error.status);
}

function normalizeContextInvitationPreview(
  preview: ContextInvitationPreview | undefined,
): ContextInvitationPreview {
  if (preview === undefined) {
    return Object.freeze({});
  }
  if (preview === null || typeof preview !== 'object' || Array.isArray(preview)
    || Object.values(preview).some(value => typeof value !== 'string')) {
    throw new TypeError('OwnedContext.invite: preview must contain only string values.');
  }
  return Object.freeze({ ...preview });
}

function isValidContextId(node: ResolvedModuleNode, contextId: string): boolean {
  if (contextId.split('/').length !== node.physicalDepth) { return false; }
  try {
    assertValidRecordWithin(node, contextId, true);
    return true;
  } catch {
    return false;
  }
}

/** Newest invitation first, with record ID as a stable tie-breaker. */
function compareInvitationRecords(left: Record, right: Record): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp > right.timestamp ? -1 : 1;
  }
  return compareCodeUnits(right.id, left.id);
}

/** Representation and physical placement are codec contracts; mutable access policies are not. */
function consumedRecordRepresentation(node: ResolvedModuleNode): unknown {
  return {
    owner     : [node.owningModuleUri, node.owningModulePath],
    ancestors : node.physicalAncestors.map(parent => [parent.owningModuleUri, parent.owningModulePath]),
    schema    : node.recordType.schema,
    formats   : node.recordType.dataFormats === undefined ? undefined : [...new Set(node.recordType.dataFormats)].sort(),
    encrypted : node.recordType.encryptionRequired === true,
    role      : node.ruleSet.$role === true,
    squash    : node.ruleSet.$squash === true,
  };
}

/** Existing providers must retain usable keys without replacing their current policy. */
function assertInstalledDependencyKeys(definition: ModuleDefinition): void {
  if (!Modules.requiresKeyAgreement(definition)) {
    return;
  }
  const missing = collectMissingKeyAgreementPaths(definition);
  if (missing.length > 0) {
    throw new Error(
      `TypedEnbox: installed dependency '${definition.module}' is missing $keyAgreement at ` +
      `${missing.map(path => path === '' ? '(root)' : path).join(', ')}; the owner must repair its installed definition.`,
    );
  }
}

/**
 * Returns `true` when the given structure node carries an injected
 * `$keyAgreement.publicKeyJwk`.
 */
function hasKeyAgreementKey(node: globalThis.Record<string, unknown>): boolean {
  const keyAgreement = node.$keyAgreement as { publicKeyJwk?: unknown } | undefined;
  return keyAgreement?.publicKeyJwk !== undefined;
}

/**
 * Collects every module path the encryption-key injection should cover
 * whose `$keyAgreement.publicKeyJwk` is MISSING from an installed module
 * definition.
 *
 * Mirrors the injection walk performed at encrypted configure time
 * (`Modules.deriveAndInjectPublicEncryptionKeys`): the module root
 * (reported as the empty string) and every structure path are covered,
 * and `$`-prefixed keys are skipped.
 */
function collectMissingKeyAgreementPaths(definition: ModuleDefinition): string[] {
  const missing: string[] = [];

  if (!hasKeyAgreementKey(definition as unknown as globalThis.Record<string, unknown>)) {
    missing.push('');
  }

  const walk = (structure: globalThis.Record<string, unknown>, prefix: string): void => {
    for (const key of Object.keys(structure)) {
      if (key.startsWith('$')) { continue; }

      const node = structure[key];
      if (node === null || typeof node !== 'object') { continue; }

      const nodeRecord = node as globalThis.Record<string, unknown>;
      const path = prefix ? `${prefix}/${key}` : key;

      if (typeof nodeRecord.$ref !== 'string' && !hasKeyAgreementKey(nodeRecord)) {
        missing.push(path);
      }

      walk(nodeRecord, path);
    }
  };

  walk(definition.structure as globalThis.Record<string, unknown>, '');
  return missing;
}

/**
 * Strips leading and trailing slashes from a path.
 *
 * `'thread/'` → `'thread'`, `'/thread/message/'` → `'thread/message'`.
 */
function normalizePath(path: string): string {
  // Strip leading and trailing '/' without regex quantifiers (avoids ReDoS scanners).
  let start = 0;
  while (start < path.length && path.codePointAt(start) === 47) { start++; } // 47 === '/'
  let end = path.length;
  while (end > start && path.codePointAt(end - 1) === 47) { end--; }
  return path.slice(start, end);
}

function normalizeContextFollowTarget(target: ContextFollowTarget, operation: string): ContextFollowTarget {
  const ownerDid = normalizeMemberDid(target.ownerDid, operation);
  if (!isValidRecordContextId(target.id)) {
    throw new TypeError(`${operation}: id must identify a canonical module context.`);
  }
  return { id: target.id, ownerDid };
}

function normalizeMemberDid(did: string, operation: string = 'OwnedContext.members'): string {
  const normalized = did.trim();
  if (Did.parse(normalized)?.uri !== normalized) {
    throw new TypeError(`${operation}: '${did}' is not a DID.`);
  }
  return normalized;
}

function projectRoleDeliveryOutcome(outcome: AudienceKeyDeliveryOutcome): RoleDeliveryState {
  if (outcome.delivered === true) {
    return { state: 'delivered' };
  }
  switch (outcome.failure) {
    case 'awaiting-recipient-install':
      return { reason: outcome.reason, state: 'awaiting-recipient-install' };
    case 'retryable':
      return { reason: outcome.reason, state: 'pending' };
    case 'terminal':
      return { reason: outcome.reason, state: 'failed' };
  }
}

/** Stable identity for one validated DWN keyset cursor. */
function paginationCursorKey(cursor: DwnPaginationCursor): string {
  return JSON.stringify([cursor.messageCid, cursor.value]);
}

type PaginationCursorLineage = Readonly<{
  key: string;
  previous?: PaginationCursorLineage;
}>;

function paginationCursorSeen(lineage: PaginationCursorLineage | undefined, key: string): boolean {
  for (let cursor = lineage; cursor !== undefined; cursor = cursor.previous) {
    if (cursor.key === key) {
      return true;
    }
  }
  return false;
}

function contextRootRecordId(contextId: string): string {
  return contextId.slice(contextId.lastIndexOf('/') + 1);
}

function compareModuleContexts(
  a: { id: string; ownerDid: string },
  b: { id: string; ownerDid: string },
): number {
  if (a.ownerDid !== b.ownerDid) {
    return a.ownerDid < b.ownerDid ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}
