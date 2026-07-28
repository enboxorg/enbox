/**
 * A protocol-scoped API returned by {@link Enbox.using}.
 *
 * `TypedEnbox` is the **primary developer interface** for interacting with
 * protocol-backed records. It auto-injects the protocol URI, protocolPath,
 * and schema into every operation, and provides compile-time path
 * autocompletion plus typed application values via runtime codecs.
 *
 * Record-returning methods preserve the protocol payload type on the canonical
 * {@link Record} class so type information flows through reads, queries, and
 * updates without a second runtime wrapper.
 *
 * @example
 * ```ts
 * const threads = enbox.using(ThreadsProtocol);
 *
 * // Install the protocol
 * await threads.configure();
 *
 * // Create — path and data type are checked at compile time
 * const record = await threads.records.create('thread', {
 *   data: { title: 'Hello World', body: '...' },
 * });
 * // record is Record<ThreadData>
 *
 * const data = await record.value(); // ThreadData — no cast needed
 *
 * // Query — protocol and protocolPath are auto-injected
 * const { records } = await threads.records.query('thread');
 * // records is Record<ThreadData>[]
 * ```
 */

import type { Protocol } from './protocol.js';
import type { RecordUpdateParams } from './record-types.js';
import type { RecordView } from './record-view.js';
import type {
  DirectSingletonChildPaths,
  ProtocolPaths,
  ProtocolRolePaths,
  SingletonProtocolPaths,
  TypedProtocol,
  TypeNameAtPath,
} from './protocol-types.js';
import type { DwnApi, ProtocolsConfigureResponse } from './dwn-api.js';
import type { DwnPaginationCursor, DwnPublicKeyJwk, DwnResponseStatus, SyncEngine } from '@enbox/agent';
import type { MaterializedRecord, Record } from './record.js';
import type { ProtocolDefinition, ProtocolType, RecordsFilter } from '@enbox/dwn-sdk-js';
import type { RecordCodec, RecordCodecMap, RecordCodecValue } from './record-codec.js';
import type { RecordFilter, RecordQuery } from './record-query.js';

import { createRecordView } from './record-view.js';
import { removeUndefinedProperties } from '@enbox/common';
import { requireDwnSuccess } from './dwn-response-error.js';
import { assertTypedProtocolStructureSupported, collectProtocolPaths } from './protocol-paths.js';
import { assertValidRecordWithin, compileRecordFilter, compileRecordQuery } from './record-query.js';
import { bindRecordCodec, encodeRecordValue } from './record-codec.js';
import { DwnConstant, getRuleSetAtPath, getTypeName } from '@enbox/dwn-sdk-js';

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/**
 * Resolves the TypeScript data type for a given protocol path.
 *
 * The value is inferred from the runtime codec declared for the type name at
 * the given path.
 */
export type DataForPath<
  C extends RecordCodecMap,
  Path extends string,
> = TypeNameAtPath<Path> extends keyof C ? RecordCodecValue<C[TypeNameAtPath<Path>]> : never;

/** One page returned by a typed records query. */
export type RecordPage<Item = Record> = {
  /** Matching records in the representation selected by the query. */
  records: Item[];

  /** Cursor for the next page, when another page exists. */
  cursor?: DwnPaginationCursor;
};

/** Materialization requested from a typed records query or observed view. */
type RecordMaterialization<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
> = true | {
  /** Exact direct-child paths to materialize beside every parent record. */
  children: readonly DirectSingletonChildPaths<D, Path>[];
};

type SelectedMaterializedChildPaths<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
  Materialization extends RecordMaterialization<D, Path>,
> = Materialization extends { children: readonly (infer ChildPath)[] }
  ? Extract<ChildPath, DirectSingletonChildPaths<D, Path>>
  : never;

/** Materialized singleton children exposed for one protocol path. */
type MaterializedChildren<
  D extends ProtocolDefinition,
  C extends RecordCodecMap,
  Path extends ProtocolPaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> = true,
> = {
  readonly [ChildPath in SelectedMaterializedChildPaths<D, Path, Materialization>
    as TypeNameAtPath<ChildPath>]: MaterializedRecord<DataForPath<C, ChildPath>> | undefined;
};

/** Materialized representation of one typed protocol record. */
type MaterializedRecordForPath<
  D extends ProtocolDefinition,
  C extends RecordCodecMap,
  Path extends ProtocolPaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> = true,
> = Materialization extends true
  ? MaterializedRecord<DataForPath<C, Path>>
  : MaterializedRecord<DataForPath<C, Path>> & Readonly<{
    children: Readonly<MaterializedChildren<D, C, Path, Materialization>>;
  }>;

type SelectedRecordRepresentation<
  D extends ProtocolDefinition,
  C extends RecordCodecMap,
  Path extends ProtocolPaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> | undefined,
> = Materialization extends undefined
  ? Record<DataForPath<C, Path>>
  : MaterializedRecordForPath<D, C, Path, Materialization>;

type MaterializedRecordWithChildren<T> = MaterializedRecord<T> & Readonly<{
  children: Readonly<globalThis.Record<string, MaterializedRecord<unknown> | undefined>>;
}>;

type MaterializationSource = {
  from?: string;
  protocolRole?: string;
  within?: string;
};

type TypedQueryRequest<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> | undefined,
> = [Materialization] extends [undefined]
  ? RecordQuery<D, Path> & { materialize?: undefined }
  : Omit<RecordQuery<D, Path>, 'pagination'> & {
    materialize: Materialization;
    pagination: { limit: number; cursor?: DwnPaginationCursor };
  };

type TypedQueryArguments<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> | undefined,
> = [Materialization] extends [undefined]
  ? [path: Path, request?: TypedQueryRequest<D, Path, Materialization>]
  : [path: Path, request: TypedQueryRequest<D, Path, Materialization>];

type TypedObserveRequest<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
  Materialization extends RecordMaterialization<D, Path> | undefined,
> = Omit<RecordQuery<D, Path>, 'from' | 'pagination'> & {
  from?: never;
  pagination: { limit: number; cursor?: DwnPaginationCursor };
} & ([Materialization] extends [undefined]
  ? { materialize?: undefined }
  : { materialize: Materialization });

/** @internal Runtime resources owned by the Enbox session that created this typed API. */
type TypedEnboxOptions = {
  /** Session-lifetime signal; aborting it closes every view created by this instance. */
  signal?: AbortSignal;

  /** Sync currentness source. Omit for directly constructed, local-only typed APIs. */
  sync?: SyncEngine;
};

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

/**
 * Options for {@link TypedEnbox} `records.create()`.
 *
 * The `data` field is type-checked against the protocol codec for the given
 * path.
 *
 * @typeParam C - The protocol's runtime codec map.
 * @typeParam Path - The protocol path string literal.
 *
 * @example
 * ```ts
 * await proto.records.create('notebook/page', {
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
   * DWN authorizes the write via {@link TypedCreateRequest.protocolRole}
   * (role-invocation, e.g. a `collaborator` `$role` record naming the
   * author as `recipient`) or delegated-grant parameters. Encrypted types
   * are encrypted to the OWNER's published protocol keys — the agent
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
   * protocol structure. Use the parent record's {@link Record.contextId | contextId}
   * as this value.
   *
   * @example
   * ```ts
   * const notebook = await proto.records.create('notebook', {
   *   data: { name: 'My Notebook' },
   * });
   *
   * // Create a page under the notebook
   * await proto.records.create('notebook/page', {
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
   * key delivery is best-effort. Use the low-level DWN API when the delivery
   * outcome is required.
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
   * The protocol role under which to create this record.
   *
   * The DWN will verify that the author is authorized to write under
   * this role per the protocol's `$actions` configuration.
   */
  protocolRole?: string;

  /**
   * Compact the record's `$squash`-enabled path on write.
   *
   * When `true`, the write carries the `$squash` directive so the DWN
   * purges older siblings per the protocol's `$squash` configuration
   * (e.g. compacting a CRDT delta/snapshot history). The protocol path
   * MUST declare `$squash: true` — otherwise the write is **rejected**
   * with `ProtocolAuthorizationSquashNotEnabled` (not silently ignored).
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

  /**
   * Whether to persist the record to the local DWN immediately.
   *
   * Defaults to `true`. Set to `false` to create the record in memory
   * only — you can call {@link Record.store | record.store()} later.
   */
  store?: boolean;
};

/**
 * Typed create options for one exact protocol path.
 *
 * Paths declared with `$role: true` require the role holder's DID as
 * `recipient`; all other paths retain the Records API's optional recipient.
 * Definitions widened to `ProtocolDefinition` cannot expose literal role
 * paths, so the runtime preflight remains authoritative for dynamic callers.
 *
 * @typeParam D - The protocol's literal definition.
 * @typeParam C - The protocol's runtime codec map.
 * @typeParam Path - The exact protocol path being created.
 */
export type TypedCreateRequest<
  D extends ProtocolDefinition,
  C extends RecordCodecMap,
  Path extends ProtocolPaths<D> & string,
> = TypedCreateOptions<C, Path> & ([Extract<Path, ProtocolRolePaths<D>>] extends [never]
  ? unknown
  : {
    /**
     * DID receiving this protocol role.
     *
     * A role assignment is the ordinary `$role` record whose `recipient`
     * names the holder, so typed role-record creates require this field.
     */
    recipient: string;
  });

/**
 * Options for replacing the visible value at a protocol-declared singleton path.
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
 * Options for {@link TypedEnbox} `records.read()`.
 *
 * A `filter` is required to identify which record to read. The most common
 * approach is to filter by `recordId`.
 *
 * @example
 * ```ts
 * // Read a specific record by ID
 * const record = await proto.records.read('notebook', {
 *   filter: { recordId: notebookId },
 * });
 *
 * // Read a nested record from a remote DWN using a protocol role
 * const remote = await proto.records.read('notebook/entry', {
 *   from: 'did:example:alice',
 *   protocolRole: 'notebook/participant',
 *   within: notebook.contextId,
 *   filter: { recordId: entryId },
 * });
 * ```
 */
export type TypedReadRequest<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
> = Pick<RecordQuery<D, Path>, 'from' | 'protocolRole'> & {
  /**
   * Filter to identify the record to read.
   *
   * The `protocol`, `protocolPath`, and `schema` fields are auto-injected.
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
 * await proto.records.delete('notebook', {
 *   recordId: notebook.id,
 * });
 *
 * await proto.records.delete('notebook/entry', {
 *   from: 'did:example:alice',
 *   protocolRole: 'notebook/participant',
 *   recordId: entry.id,
 *   within: notebook.contextId,
 * });
 * ```
 */
export type TypedDeleteRequest = {
  /**
   * Full context ID of the target record, used only to resolve a context-scoped
   * delegated delete grant. It is not included in the RecordsDelete message.
   */
  within?: string;

  /**
   * A remote DWN DID to delete from.
   *
   * When set, the delete is performed on the specified DID's remote DWN.
   */
  from?: string;

  /** Protocol role invoked to authorize the delete. */
  protocolRole?: string;

  /**
   * The unique `recordId` of the record to delete.
   *
   * Use {@link Record.id | record.id} to obtain this value.
   */
  recordId: string;

  /**
   * Whether to also delete (prune) every descendant record beneath this
   * record in the protocol hierarchy.
   *
   * Forwarded to the underlying `RecordsDelete` message. When omitted the
   * delete is a plain tombstone that leaves children in place.
   */
  prune?: boolean;
};

/**
 * Thrown/returned by {@link TypedEnbox.verifyInstalled} when a DELEGATE
 * session's wallet-installed protocol definition is stale (or missing, or
 * lacking required `$keyAgreement` keys).
 *
 * A delegate holds no `Protocols.Configure` authority: it can only import
 * the wallet's already-signed configuration, so a drifted definition cannot
 * be repaired from the app side. The wallet must re-install the protocol and
 * re-approve the session — route the user back through the wallet connect /
 * approval flow.
 *
 * Contrast with the OWNER case, where the same drift is reported as
 * `'owner-can-update'` because a plain `configure()` call repairs it.
 */
export class WalletReapprovalRequiredError extends Error {
  /** The protocol URI whose wallet-installed definition is stale or missing. */
  public readonly protocol: string;

  constructor(protocol: string, detail: string) {
    super(
      `WalletReapprovalRequiredError: protocol '${protocol}' ${detail} ` +
      'A delegate cannot re-configure protocols — the wallet must re-install ' +
      'the protocol and re-approve the session.',
    );
    this.name = 'WalletReapprovalRequiredError';
    this.protocol = protocol;
  }
}

/**
 * Result of {@link TypedEnbox.verifyInstalled} — a strict, read-only
 * verification of the installed protocol definition against the code's
 * definition, including `$keyAgreement` key coverage.
 *
 * `status` semantics:
 * - **`'up-to-date'`** — the installed definition canonically matches the
 *   code definition (runtime encryption blocks stripped before comparison)
 *   and, when the protocol declares encrypted types, every path the
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
   * Whether the installed definition canonically matches the code
   * definition, compared via {@link definitionsEqual} (deterministic JSON
   * with `$encryption`/`$keyAgreement` runtime blocks stripped). `false`
   * when no installation was found.
   */
  definitionsMatch: boolean;

  /**
   * Protocol paths the encryption-key injection should cover whose
   * `$keyAgreement.publicKeyJwk` is missing from the installed definition.
   * The empty string denotes the protocol root. Checked only when the
   * definition declares encrypted types (`encryptionRequired: true`) and an
   * installation was found; empty otherwise. `$ref` composition nodes are
   * exempt — their records are governed by the referenced protocol's keys.
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
 * A protocol-scoped API that auto-injects `protocol`, `protocolPath`, and
 * `schema` into every DWN operation.
 *
 * All record-returning methods preserve the data type `T` on the canonical
 * {@link Record} class so it flows end-to-end — from write through read,
 * query, and update — without manual casts.
 *
 * Obtain an instance via `enbox.using(typedProtocol)`.
 *
 * @example
 * ```ts
 * const notes = enbox.using(NotesProtocol);
 *
 * await notes.configure();
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
  D extends ProtocolDefinition = ProtocolDefinition,
  C extends RecordCodecMap = RecordCodecMap,
> {
  /** @internal */
  private readonly _dwn: DwnApi;
  /** @internal */
  private readonly _definition: D;
  /** @internal */
  private readonly _codecs: C;
  /** @internal */
  private _configured: boolean = false;
  /** @internal */
  private _ensureReadyPromise: Promise<void> | null = null;
  /** @internal */
  private readonly _validPaths: Set<string>;
  /** @internal */
  private _records?: TypedEnbox<D, C>['records'];
  /** @internal — cached result of the `hasEncryptedTypes` scan (definition is immutable). */
  private readonly _hasEncryptedTypes: boolean;
  /** @internal */
  private readonly _options: TypedEnboxOptions;

  /**
   * @internal Create a new `TypedEnbox` instance. Use `enbox.using(protocol)` instead.
   * @param dwn - The underlying DWN API instance.
   * @param protocol - The typed protocol containing the definition and codecs.
   * @param options - Optional session-owned lifecycle and sync resources.
   */
  constructor(dwn: DwnApi, protocol: TypedProtocol<D, C>, options: TypedEnboxOptions = {}) {
    assertTypedProtocolStructureSupported(protocol.definition.structure);
    this._dwn = dwn;
    this._definition = protocol.definition;
    this._codecs = protocol.codecs;
    this._options = options;
    this._validPaths = collectProtocolPaths(this._definition.structure);
    this._hasEncryptedTypes = Object.values(this._definition.types)
      .some((type: ProtocolType) => type.encryptionRequired === true);
  }

  /**
   * The protocol URI string (e.g. `'https://example.com/threads'`).
   *
   * This is the globally unique identifier for the protocol and is
   * auto-injected into every record operation.
   */
  public get protocol(): string {
    return this._definition.protocol;
  }

  /**
   * The raw protocol definition object.
   *
   * Contains the full `protocol`, `types`, and `structure` that define
   * the protocol's schema and permission rules.
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
    return this._dwn;
  }

  /**
   * Configures (installs) this protocol on the local DWN.
   *
   * If the protocol is already installed with an identical definition,
   * this is a no-op and returns the existing protocol with status `200`.
   * If the definition has changed (e.g. new types, modified structure),
   * the protocol is re-configured with the updated definition and returns
   * status `202`.
   *
   * **Must be called before any record operations.** Methods like
   * `records.create()`, `records.query()`, etc. will throw if the protocol
   * has not been configured.
   *
   * @returns The DWN response status and the installed protocol object.
   *
   * @example
   * ```ts
   * const proto = enbox.using(NotebookProtocol);
   *
   * const { status, protocol } = await proto.configure();
   * console.log(status.code); // 202 (first install) or 200 (already installed)
   *
   * // Now you can use records.create(), records.query(), etc.
   * ```
   */
  public async configure(): Promise<DwnResponseStatus & { protocol?: Protocol }> {
    // Query for an existing installation of this protocol.
    const { protocols } = await this._dwn.protocols.query({
      filter: { protocol: this._definition.protocol },
    });

    // If already installed with the same definition, return it as-is.
    if (protocols.length > 0) {
      const existing = protocols[0];
      if (definitionsEqual(existing.definition, this._definition)) {
        this._configured = true;
        return { status: { code: 200, detail: 'OK' }, protocol: existing };
      }
    }

    // Not installed or definition has changed. In delegate mode, the wallet
    // owns protocol configuration; the delegate may only import the wallet's
    // already-signed ProtocolsConfigure message into its local DWN.
    if (this._dwn.isDelegate) {
      const imported = await this._autoConfigureDelegateProtocol();
      if (imported) {
        return imported;
      }

      throw new Error(
        `TypedEnbox: delegate cannot install protocol '${this._definition.protocol}' ` +
        `because the wallet's remote protocol definition could not be found. ` +
        `Ensure the wallet installed the protocol during connect and that the ` +
        `delegate has access to the wallet's DWN endpoints.`,
      );
    }

    const result = await this._dwn.protocols.configure({
      definition: this._definition,
    });

    if (result.status.code === 202) {
      this._configured = true;
    }

    return result;
  }

  /**
   * Whether the protocol has been configured (installed) on the local DWN.
   *
   * Returns `true` after a successful call to {@link TypedEnbox.configure | configure()}.
   * Record operations will throw if this is `false`.
   */
  public get isConfigured(): boolean {
    return this._configured;
  }

  /**
   * Strictly verifies the installed protocol definition without modifying
   * anything — the read-only counterpart to {@link TypedEnbox.configure}.
   *
   * Where `configure()` only compares definitions (and, for delegates,
   * silently imports whatever the wallet installed, warning on drift),
   * `verifyInstalled()`:
   *
   * 1. canonically compares the installed definition against the code
   *    definition via {@link definitionsEqual} (runtime
   *    `$encryption`/`$keyAgreement` blocks stripped);
   * 2. when the definition declares encrypted types, verifies a
   *    `$keyAgreement.publicKeyJwk` is present at every path the
   *    encryption-key injection covers (protocol root and every non-`$ref`
   *    structure path);
   * 3. distinguishes WHO can repair a failure: an owner gets
   *    `'owner-can-update'` (call `configure()`), while a delegate whose
   *    wallet-installed definition is stale gets
   *    `'wallet-reapproval-required'` together with a typed
   *    {@link WalletReapprovalRequiredError} — never a silent import.
   *
   * For owner sessions the LOCAL installation is verified; for delegate
   * sessions the WALLET-installed definition is fetched from the owner
   * tenant's remote DWN (the source auto-configure imports from).
   *
   * Never changes state: no configure, no import, no cache updates.
   *
   * @returns The structured verification result — see {@link VerifyInstalledResult}.
   * @throws `Error` when the delegate's remote protocol query itself fails
   *   (e.g. a revoked or expired session grant surfaces as a 401) — a
   *   transport/authorization failure, not a verification outcome.
   */
  public async verifyInstalled(): Promise<VerifyInstalledResult> {
    const isDelegate = this._dwn.isDelegate;

    // Owners verify their local installation; delegates verify the
    // wallet-installed definition on the owner tenant — the same source
    // `_autoConfigureDelegateProtocol` imports from.
    const { protocols, status } = await this._dwn.protocols.query({
      ...(isDelegate ? { from: this._dwn.connectedDid } : {}),
      filter: { protocol: this._definition.protocol },
    });

    // A failed query is a transport/authorization failure, not a verification
    // outcome — never classify it as "not installed".
    if (status !== undefined && status.code >= 300) {
      const source = isDelegate
        ? `the wallet's protocol definition from the owner's DWN`
        : 'the locally installed protocol definition';
      const delegateHint = isDelegate
        ? ' A revoked or expired session grant fails with 401 — reconnect to obtain fresh grants.'
        : '';
      throw new Error(
        `TypedEnbox: verifyInstalled() could not fetch ${source} ` +
        `for '${this._definition.protocol}': ${status.code} ${status.detail}.${delegateHint}`,
      );
    }

    const installedDefinition = protocols.length > 0 ? protocols[0].definition : undefined;

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

    const definitionsMatch = definitionsEqual(installedDefinition, this._definition);

    // `$keyAgreement` injection only happens for encrypted installs, so key
    // coverage is only expected when the definition declares encrypted types.
    const missingKeyAgreementPaths = this._hasEncryptedTypes
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
      const error = new WalletReapprovalRequiredError(this._definition.protocol, detail);
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
      reason : `TypedEnbox: protocol '${this._definition.protocol}' ${detail} Call configure() to repair it.`,
    };
  }

  /**
   * Validates that the path is recognized.
   * Throws a descriptive error if the path is not a valid protocol path.
   */
  private _assertValidPath(path: string): void {
    if (!this._validPaths.has(path)) {
      throw new Error(
        `TypedEnbox: invalid protocol path '${path}'. ` +
        `Valid paths are: ${[...this._validPaths].join(', ')}.`,
      );
    }
  }

  /** Resolve the codec assigned to one validated protocol path. */
  private resolveCodec(path: string): RecordCodec<unknown> {
    const codec = this._codecs[getTypeName(path)];
    if (codec === undefined) {
      throw new Error(`TypedEnbox: protocol path '${path}' does not have a record codec.`);
    }
    return codec;
  }

  /** Resolve one statically known path's application codec. */
  private getCodec<Path extends ProtocolPaths<D> & string>(path: string): RecordCodec<DataForPath<C, Path>> {
    return this.resolveCodec(path) as RecordCodec<DataForPath<C, Path>>;
  }

  /** Bind a path codec to one canonical record returned by the raw DWN API. */
  private bindCodec<
    Path extends ProtocolPaths<D> & string,
    Existing = unknown,
  >(
    path : string,
    record : Record<Existing>,
  ): Record<DataForPath<C, Path>> {
    const dataFormats = this._definition.types[getTypeName(path)]?.dataFormats;
    return bindRecordCodec(record, this.getCodec<Path>(path), dataFormats);
  }

  /** Validate materialization once, before any protocol or Records request starts. */
  private resolveMaterializedChildPaths<Path extends ProtocolPaths<D> & string>(
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
      throw new TypeError('Record materialization: children must contain unique protocol paths.');
    }

    const directChildPrefix = `${parentPath}/`;
    for (const childPath of childPaths) {
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
    Path extends ProtocolPaths<D> & string,
    Materialization extends RecordMaterialization<D, Path> | undefined,
  >(
    path : string,
    records : Record[],
    materialization : Materialization,
    childPaths : readonly string[],
    source : MaterializationSource,
  ): Promise<readonly SelectedRecordRepresentation<D, C, Path, Materialization>[]> {
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
    return represented as unknown as readonly SelectedRecordRepresentation<D, C, Path, Materialization>[];
  }

  /** Decode one bounded parent page and its explicitly selected singleton children. */
  private async materializeRecords<
    Path extends ProtocolPaths<D> & string,
  >(
    parentPath : string,
    records : readonly Record[],
    childPaths : readonly string[],
    source : MaterializationSource,
  ): Promise<readonly (
    MaterializedRecord<DataForPath<C, Path>> |
    MaterializedRecordWithChildren<DataForPath<C, Path>>
  )[]> {
    const parents = await Promise.all(records.map(async (record): Promise<MaterializedRecord<DataForPath<C, Path>>> => {
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
      children: new Map<string, MaterializedRecord<unknown> | undefined>(
        childPaths.map((childPath) => [getTypeName(childPath), undefined]),
      ),
      parent,
    }]));
    const parentIds = [...parentById.keys()];
    await Promise.all(childPaths.map(async (childPath): Promise<void> => {
      const childName = getTypeName(childPath);

      const childType = this._definition.types[childName];
      const occupiedParentIds = new Set<string>();
      for (let offset = 0; offset < parentIds.length; offset += DwnConstant.maxFilterValues) {
        const parentIdBatch = parentIds.slice(offset, offset + DwnConstant.maxFilterValues);
        const filter = compileRecordFilter(
          this._definition,
          childPath,
          undefined,
          undefined,
          source.within,
        );
        filter.parentId = parentIdBatch;
        const result = await this._dwn.records.query({
          from         : source.from,
          filter,
          pagination   : { limit: parentIdBatch.length },
          protocolRole : source.protocolRole,
        });
        requireDwnSuccess('TypedEnbox.records.query child materialization', result);
        if (result.cursor !== undefined) {
          throw new Error(
            `TypedEnbox.records.query: singleton child '${childPath}' returned more records than its selected parents.`,
          );
        }

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
          );
          parentEntry.children.set(childName, Object.freeze({
            record : childRecord,
            value  : await childRecord.value(),
          }));
        }));
      }
    }));

    return [...parentById.values()].map(({ children, parent }) => Object.freeze({
      ...parent,
      children: Object.freeze(Object.fromEntries(children)),
    }));
  }

  /** Require the protocol fact that gives `set()` one unambiguous target. */
  private assertSingletonScope(path: string, within: string | undefined): void {
    this._assertValidPath(path);
    if (getRuleSetAtPath(path, this._definition.structure)?.$recordLimit?.max !== 1) {
      throw new TypeError(`TypedEnbox.records.set: path '${path}' must declare $recordLimit.max: 1.`);
    }

    if (!path.includes('/')) {
      if (within !== undefined) {
        throw new TypeError('TypedEnbox.records.set: a root singleton does not accept within.');
      }
      return;
    }

    assertValidRecordWithin(path, within, true);
    if (within.split('/').length !== path.split('/').length - 1) {
      throw new TypeError('TypedEnbox.records.set: within must identify the singleton\'s direct parent context.');
    }
  }

  /** Create one typed record through the protocol-bound DWN API. */
  private async createRecord<Path extends ProtocolPaths<D> & string>(
    path: Path,
    request: TypedCreateOptions<C, Path>,
  ): Promise<Record<DataForPath<C, Path>>> {
    const normalizedPath = normalizePath(path);
    if (getRuleSetAtPath(normalizedPath, this._definition.structure)?.$role === true
      && request.recipient === undefined) {
      throw new TypeError(`TypedEnbox.records.create: role path '${normalizedPath}' requires a recipient.`);
    }
    await this._ensureReady(normalizedPath);
    const typeName = getTypeName(normalizedPath);
    const typeEntry = this._definition.types[typeName];

    const codec = this.getCodec<Path>(normalizedPath);
    const encoded = await encodeRecordValue(codec, request.data, typeEntry?.dataFormats);
    const result = await this._dwn.records.write({
      data                   : encoded.data,
      from                   : request.from,
      store                  : request.store,
      parentContextId        : request.parentContextId,
      published              : request.published,
      datePublished          : request.datePublished,
      dateCreated            : request.dateCreated,
      messageTimestamp       : request.messageTimestamp,
      recipient              : request.recipient,
      recipientRolePublicKey : request.recipientRolePublicKey,
      protocolRole           : request.protocolRole,
      squash                 : request.squash,
      tags                   : request.tags,
      protocol               : this._definition.protocol,
      protocolPath           : normalizedPath,
      ...(typeEntry?.schema === undefined ? {} : { schema: typeEntry.schema }),
      dataFormat             : encoded.dataFormat,
    });

    requireDwnSuccess('TypedEnbox.records.create', result);
    if (result.record === undefined) {
      throw new Error('TypedEnbox.records.create: DWN returned success without a record.');
    }

    return this.bindCodec<Path>(normalizedPath, result.record);
  }

  /**
   * Ensures the protocol is configured before performing record operations.
   *
   * On first call, queries for an existing protocol installation:
   * - If found with an identical definition → marks as configured.
   * - If found with a different definition → marks as configured but warns
   *   that the local definition differs from the installed one.
   * - If not found → installs the protocol via `protocols.configure()`.
   *
   * Concurrent calls are deduplicated via a shared Promise so the network
   * call only happens once.
   */
  private async _ensureReady(path: string): Promise<void> {
    if (this._configured) {
      this._assertValidPath(path);
      return;
    }

    this._ensureReadyPromise ??= this._autoConfigureOnce();

    await this._ensureReadyPromise;
    this._assertValidPath(path);
  }

  /**
   * Performs the one-time auto-configuration check. Called at most once;
   * subsequent calls reuse the same Promise via `_ensureReadyPromise`.
   */
  private async _autoConfigureOnce(): Promise<void> {
    const { protocols } = await this._dwn.protocols.query({
      filter: { protocol: this._definition.protocol },
    });

    if (protocols.length > 0) {
      const existing = protocols[0];
      if (definitionsEqual(existing.definition, this._definition)) {
        this._configured = true;
        return;
      }

      // Installed but definitions differ — allow operations but warn.
      console.warn(
        `TypedEnbox: installed protocol '${this._definition.protocol}' differs from the provided definition. ` +
        'Call configure() to update it.',
      );
      this._configured = true;
      return;
    }

    // Not installed locally — configure it now.
    //
    // For delegates: the wallet already installed the protocol with derived
    // `$keyAgreement` keys on the owner's remote DWN. We fetch that remote
    // definition and install it locally so the delegate can encrypt records
    // using the public keys from `$keyAgreement`. This avoids the delegate
    // needing the owner's private X25519 key — only the already-public
    // derived keys are used for ProtocolPath encryption.
    //
    // For owners: derive encryption keys locally via the KMS.
    if (this._dwn.isDelegate) {
      const imported = await this._autoConfigureDelegateProtocol();
      if (imported) {
        return;
      }

      throw new Error(
        `TypedEnbox: delegate cannot install protocol '${this._definition.protocol}' ` +
        `because the wallet's remote protocol definition could not be found. ` +
        `Ensure the wallet installed the protocol during connect and that the ` +
        `delegate has access to the wallet's DWN endpoints.`,
      );
    }

    const result = await this._dwn.protocols.configure({
      definition: this._definition,
    });

    if (result.status.code === 202) {
      this._configured = true;
    }
  }

  /**
   * For delegates: fetch the owner's signed ProtocolsConfigure message from
   * the remote DWN and import that same wallet-owned message locally.
   *
   * Returns the local import response when the remote configuration was found.
   */
  private async _autoConfigureDelegateProtocol(): Promise<ProtocolsConfigureResponse | undefined> {
    const { protocols: remoteProtocols, status: queryStatus } = await this._dwn.protocols.query({
      from   : this._dwn.connectedDid,
      filter : { protocol: this._definition.protocol },
    });

    if (queryStatus !== undefined && queryStatus.code >= 300) {
      throw new Error(
        `TypedEnbox: delegate could not fetch the wallet's protocol definition for ` +
        `'${this._definition.protocol}' from the owner's DWN: ${queryStatus.code} ` +
        `${queryStatus.detail}. A revoked or expired session grant fails with 401 — ` +
        `reconnect to obtain fresh grants.`,
      );
    }

    if (remoteProtocols.length === 0) {
      return undefined;
    }

    // The remote message includes the wallet's signature and, for encrypted
    // protocols, `$keyAgreement` keys injected by the wallet during configure.
    // Import that exact message locally so the delegate can validate/encrypt
    // owner-tenant records without receiving Protocols.Configure permission.
    const result = await this._dwn.importProtocolConfiguration(remoteProtocols[0].toJSON());

    if (result.status.code < 300 || result.status.code === 409) {
      this._configured = true;
      return result;
    }

    throw new Error(
      `TypedEnbox: delegate failed to import wallet-owned protocol ` +
      `'${this._definition.protocol}' locally: ${result.status.code} ` +
      `${result.status.detail}`,
    );
  }

  /**
   * Protocol-scoped record operations.
   *
   * Every method auto-injects the `protocol`, `protocolPath`, and `schema`
   * from the protocol definition — you never need to specify them manually.
   * Path parameters provide **compile-time autocompletion** via
   * `ProtocolPaths<D>`, and data types are resolved from the protocol codecs.
   *
   * Record-returning methods use canonical {@link Record} instances carrying
   * the resolved data type from the codec map.
   *
   * Available methods:
   * - {@link TypedEnbox.records.create | create(path, request)} — Create a new record
   * - {@link TypedEnbox.records.query | query(path, request?)} — Query records with filters
   * - {@link TypedEnbox.records.observe | observe(path, request)} — Observe immutable local query snapshots
   * - {@link TypedEnbox.records.count | count(path, request?)} — Count the same matching population
   * - {@link TypedEnbox.records.read | read(path, request)} — Read a single record
   * - {@link TypedEnbox.records.set | set(path, request)} — Replace one protocol-declared singleton
   * - {@link TypedEnbox.records.delete | delete(path, request)} — Delete a record by ID
   */
  public get records(): {
    create: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request: TypedCreateRequest<D, C, Path>,
    ) => Promise<Record<DataForPath<C, Path>>>;

    query: <
      Path extends ProtocolPaths<D> & string,
      Materialization extends RecordMaterialization<D, Path> | undefined = undefined,
    >(...args: TypedQueryArguments<D, Path, Materialization>) => Promise<
      RecordPage<SelectedRecordRepresentation<D, C, Path, Materialization>>
    >;

    observe: <
      Path extends ProtocolPaths<D> & string,
      Materialization extends RecordMaterialization<D, Path> | undefined = undefined,
    >(
      path: Path,
      request: TypedObserveRequest<D, Path, Materialization>,
    ) => Promise<RecordView<SelectedRecordRepresentation<D, C, Path, Materialization>>>;

    count: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request?: RecordQuery<D, Path>,
    ) => Promise<number>;

    read: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request: TypedReadRequest<D, Path>,
    ) => Promise<Record<DataForPath<C, Path>> | undefined>;

    set: <Path extends SingletonProtocolPaths<D> & string>(
      path: Path,
      request: TypedSetRequest<C, Path>,
    ) => Promise<Record<DataForPath<C, Path>>>;

    delete: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request: TypedDeleteRequest,
    ) => Promise<void>;
    } {
    if (this._records !== undefined) {
      return this._records;
    }

    const cached = {
      /**
       * Create a new record at the given protocol path.
       *
       * The `protocol`, `protocolPath`, and `schema` are auto-injected from
       * the protocol definition. The `data` field is type-checked against
       * the codec for the given path.
       *
       * @param path - The protocol path (e.g. `'notebook'`, `'notebook/page'`).
       *   Provides compile-time autocompletion for valid paths.
       * @param request - Create options including the typed `data` payload
       *   and optional fields like `parentContextId`, `tags`, `recipient`.
       * @returns The created typed {@link Record}.
       *
       * @example
       * ```ts
       * const record = await proto.records.create('notebook', {
       *   data: { name: 'My Notebook' },
       * });
       *
       * // Create a child page under the notebook's context
       * const page = await proto.records.create('notebook/page', {
       *   data: { title: 'First Page', body: '' },
       *   parentContextId: record.contextId,
       * });
       * ```
       */
      create: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedCreateRequest<D, C, Path>,
      ): Promise<Record<DataForPath<C, Path>>> => this.createRecord(path, request),

      /**
       * Query records at the given protocol path.
       *
       * Returns one page of matching typed records, with an optional pagination
       * cursor for fetching additional pages. Set
       * `materialize` to eagerly decode one explicitly bounded page while
       * retaining each canonical record handle. Selected direct children must
       * declare `$recordLimit.max: 1` and are fetched in bounded batches per child path.
       *
       * @param path - The protocol path to query (e.g. `'notebook'`,
       *   `'notebook/page'`).
       * @param request - Optional filter, sort, and pagination options.
       *   Omitted limits use the DWN's finite default page size.
       * @returns A page containing typed {@link Record} instances and an
       *   optional `cursor` for pagination.
       *
       * @example
       * ```ts
       * // Query the first page of notebooks
       * const { records } = await proto.records.query('notebook');
       *
       * // Query pages under a specific notebook
       * const { records: pages } = await proto.records.query('notebook/page', {
       *   within: notebook.contextId,
       * });
       *
       * for (const page of pages) {
       *   const data = await page.value(); // PageData
       * }
       *
       * // Paginated query
       * const { records: batch, cursor } = await proto.records.query('notebook', {
       *   pagination: { limit: 10 },
       *   dateSort: DateSort.CreatedDescending,
       * });
       * ```
       */
      query: async <
        Path extends ProtocolPaths<D> & string,
        Materialization extends RecordMaterialization<D, Path> | undefined = undefined,
      >(...args: TypedQueryArguments<D, Path, Materialization>): Promise<
        RecordPage<SelectedRecordRepresentation<D, C, Path, Materialization>>
      > => {
        const [path, request] = args;
        const normalizedPath = normalizePath(path);
        const materialize = request?.materialize;
        const childPaths = this.resolveMaterializedChildPaths<Path>(
          normalizedPath,
          materialize,
          request?.pagination?.limit,
        );
        await this._ensureReady(normalizedPath);
        const compiled = compileRecordQuery(this._definition, normalizedPath, request);
        const result = await this._dwn.records.query(compiled);
        requireDwnSuccess('TypedEnbox.records.query', result);

        return {
          records: [...await this.representRecords<Path, Materialization>(
            normalizedPath,
            result.records,
            materialize,
            childPaths,
            { from: compiled.from, protocolRole: compiled.protocolRole, within: request?.within },
          )],
          cursor: result.cursor,
        };
      },

      /**
       * Observe one bounded local query as immutable materialized snapshots.
       *
       * A local subscription is installed before the initial query. Its
       * payloads are wake hints only; every published collection comes from
       * re-running this exact canonical query. A pagination limit is required
       * so the view's retained collection has an explicit resource bound.
       * Query and observe share the same record materialization path.
       */
      observe: async <
        Path extends ProtocolPaths<D> & string,
        Materialization extends RecordMaterialization<D, Path> | undefined = undefined,
      >(
        path: Path,
        request: TypedObserveRequest<D, Path, Materialization>,
      ): Promise<RecordView<SelectedRecordRepresentation<D, C, Path, Materialization>>> => {
        this._options.signal?.throwIfAborted();
        const normalizedPath = normalizePath(path);
        if (request?.from !== undefined) {
          throw new TypeError('RecordView: remote queries are not supported; observe the connected tenant local replica.');
        }
        if (request?.pagination?.limit === undefined) {
          throw new TypeError('RecordView: pagination.limit is required to bound retained records.');
        }
        const { materialize, ...query } = request;
        const childPaths = this.resolveMaterializedChildPaths<Path>(
          normalizedPath,
          materialize,
          query.pagination.limit,
        );
        const compiled = structuredClone(compileRecordQuery(this._definition, normalizedPath, query));
        const additionalWakeFilters = childPaths.map((childPath): RecordsFilter => compileRecordFilter(
          this._definition,
          childPath,
          undefined,
          undefined,
          query.within,
        ));
        await this._ensureReady(normalizedPath);

        return createRecordView<SelectedRecordRepresentation<D, C, Path, Materialization>>({
          additionalWakeFilters,
          definition         : this._definition,
          dwn                : this._dwn,
          materializeRecords : async (records): Promise<readonly SelectedRecordRepresentation<
            D,
            C,
            Path,
            Materialization
          >[]> => this.representRecords<Path, Materialization>(
            normalizedPath,
            records,
            materialize as Materialization,
            childPaths,
            { protocolRole: compiled.protocolRole, within: query.within },
          ),
          query  : compiled,
          signal : this._options.signal,
          sync   : this._options.sync,
        });
      },

      /**
       * Count the complete population selected by the same specification as
       * `query()`. Pagination and ordering do not change the count; a
       * published-date sort still selects published records only.
       */
      count: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request?: RecordQuery<D, Path>,
      ): Promise<number> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const compiled = compileRecordQuery(this._definition, normalizedPath, request);

        const result = await this._dwn.records.count({
          from         : compiled.from,
          filter       : compiled.filter,
          protocolRole : compiled.protocolRole,
        });
        requireDwnSuccess('TypedEnbox.records.count', result);
        if (result.count === undefined) {
          throw new Error('TypedEnbox.records.count: DWN returned success without a count.');
        }
        return result.count;
      },

      /**
       * Read a single record at the given protocol path.
       *
       * Unlike `query()`, which returns an array, `read()` returns exactly
       * one record. Use `filter.recordId` to target a specific record.
       *
       * @param path - The protocol path to read from.
       * @param request - Read options including a `filter` to identify the
       *   record. See {@link TypedReadRequest} for details.
       * @returns The matching typed {@link Record}, or `undefined` when no
       *   current record exists.
       *
       * @example
       * ```ts
       * const record = await proto.records.read('notebook', {
       *   filter: { recordId: notebookId },
       * });
       *
       * if (record === undefined) {
       *   throw new Error('Notebook not found');
       * }
       *
       * const data = await record.value(); // NotebookData
       * console.log(data.name);
       * ```
       */
      read: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedReadRequest<D, Path>,
      ): Promise<Record<DataForPath<C, Path>> | undefined> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const readFilter = compileRecordFilter(
          this._definition,
          normalizedPath,
          request.filter,
          undefined,
          request.within,
        );
        const result = await this._dwn.records.read({
          from         : request.from,
          filter       : readFilter,
          protocolRole : request.protocolRole,
        });

        if (result.status.code === 404) {
          return undefined;
        }
        requireDwnSuccess('TypedEnbox.records.read', result);
        return result.record === undefined
          ? undefined
          : this.bindCodec<Path>(normalizedPath, result.record);
      },

      /**
       * Replace the visible value at a protocol-declared singleton path.
       *
       * The path must declare `$recordLimit.max: 1`. The current visible
       * occupant is updated in place; an empty scope creates its first record.
       * This is deliberately not a generic upsert and does not add locking or
       * conflict semantics beyond the DWN's deterministic occupant projection.
       * The caller needs both query and write authorization because selecting
       * the current occupant precedes the create or update. Delegates must
       * have a matching Records.Read grant that covers RecordsQuery.
       */
      set: async <Path extends SingletonProtocolPaths<D> & string>(
        path: Path,
        request: TypedSetRequest<C, Path>,
      ): Promise<Record<DataForPath<C, Path>>> => {
        const normalizedPath = normalizePath(path);
        this.assertSingletonScope(normalizedPath, request.within);
        if ('from' in request && request.from !== undefined) {
          throw new TypeError('TypedEnbox.records.set: remote targets are not supported.');
        }
        if ('protocolRole' in request && request.protocolRole !== undefined) {
          throw new TypeError('TypedEnbox.records.set: protocol roles are not supported.');
        }
        await this._ensureReady(normalizedPath);
        const query = compileRecordQuery(this._definition, normalizedPath, {
          pagination : { limit: 1 },
          within     : request.within,
        });
        const result = await this._dwn.queryRecordsWithRequiredGrant(query);
        requireDwnSuccess('TypedEnbox.records.set query', result);
        const existing = result.records[0];
        if (existing === undefined) {
          return this.createRecord(path, {
            data             : request.data,
            datePublished    : request.datePublished,
            messageTimestamp : request.messageTimestamp,
            parentContextId  : request.within,
            published        : request.published,
            tags             : request.tags,
          });
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
       * Delete a record at the given protocol path.
       *
       * The path is used for protocol validation and permission scoping,
       * while the actual record is identified by `recordId`.
       *
       * @param path - The protocol path (used for permission scoping and
       *   path validation).
       * @param request - Delete options. `recordId` is required; `within`
       *   scopes delegated grant resolution and `from` selects a remote DWN.
       * @returns A promise that resolves when the delete is accepted.
       *
       * @example
       * ```ts
       * await proto.records.delete('notebook', {
       *   recordId: notebook.id,
       * });
       * ```
       */
      delete: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedDeleteRequest,
      ): Promise<void> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        if (Object.hasOwn(request, 'contextId')) {
          throw new TypeError('TypedDeleteRequest: use within instead of contextId.');
        }
        assertValidRecordWithin(normalizedPath, request.within, false);
        const result = await this._dwn.records.delete({
          contextId    : request.within,
          from         : request.from,
          protocol     : this._definition.protocol,
          protocolPath : normalizedPath,
          protocolRole : request.protocolRole,
          recordId     : request.recordId,
          prune        : request.prune,
        });
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

/**
 * Compares two protocol definitions for **logical** equality using
 * deterministic JSON serialization with runtime encryption metadata stripped.
 *
 * When a protocol declares encrypted types, the agent injects public key
 * agreement blocks into the `structure`. These blocks are operational
 * metadata — not part of the developer-authored definition — so they must be
 * ignored during equality checks.
 *
 * Keys are sorted recursively so that semantically identical definitions
 * with different key ordering are treated as equal.
 */
export function definitionsEqual(a: unknown, b: unknown): boolean {
  return stableStringify(stripEncryptionBlocks(a)) === stableStringify(stripEncryptionBlocks(b));
}

/**
 * Recursively removes runtime-injected encryption keys (`$encryption` and
 * `$keyAgreement` blocks) from an object tree — the canonicalization step
 * behind {@link definitionsEqual} and {@link TypedEnbox.verifyInstalled}.
 * Returns a new object — the original is not mutated.
 */
export function stripEncryptionBlocks(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripEncryptionBlocks(item));
  }

  const result: globalThis.Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as globalThis.Record<string, unknown>)) {
    if (key === '$encryption' || key === '$keyAgreement') { continue; }
    result[key] = stripEncryptionBlocks(val);
  }
  return result;
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
 * Collects every protocol path the encryption-key injection should cover
 * whose `$keyAgreement.publicKeyJwk` is MISSING from an installed protocol
 * definition.
 *
 * Mirrors the injection walk performed at encrypted configure time
 * (`Protocols.deriveAndInjectPublicEncryptionKeys`): the protocol root
 * (reported as the empty string) and every structure path are covered,
 * and `$`-prefixed keys are skipped.
 */
function collectMissingKeyAgreementPaths(definition: ProtocolDefinition): string[] {
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

      if (!hasKeyAgreementKey(nodeRecord)) {
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

/**
 * Deterministic JSON serialization with sorted keys.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  }

  const keys = Object.keys(value as globalThis.Record<string, unknown>).sort((a, b) => a.localeCompare(b));
  const pairs = keys.map((key) =>
    JSON.stringify(key) + ':' + stableStringify((value as globalThis.Record<string, unknown>)[key])
  );
  return '{' + pairs.join(',') + '}';
}
