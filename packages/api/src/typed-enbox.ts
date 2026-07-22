/**
 * A protocol-scoped API returned by {@link Enbox.using}.
 *
 * `TypedEnbox` is the **primary developer interface** for interacting with
 * protocol-backed records. It auto-injects the protocol URI, protocolPath,
 * and schema into every operation, and provides compile-time path
 * autocompletion plus typed data payloads via the schema map.
 *
 * All record-returning methods wrap the underlying `Record` instances in
 * {@link TypedRecord} so that type information flows through reads, queries,
 * and updates without manual casts.
 *
 * @example
 * ```ts
 * const social = enbox.using(SocialProtocol);
 *
 * // Install the protocol
 * await social.configure();
 *
 * // Create — path and data type are checked at compile time
 * const { record } = await social.records.create('thread', {
 *   data: { title: 'Hello World', body: '...' },
 * });
 * // record is TypedRecord<ThreadData>
 *
 * const data = await record.data.json(); // ThreadData — no cast needed
 *
 * // Query — protocol and protocolPath are auto-injected
 * const { records } = await social.records.query('thread');
 * // records is TypedRecord<ThreadData>[]
 * ```
 */

import type { Protocol } from './protocol.js';

import type { RecordView } from './record-view.js';

import type { AudienceKeyDeliveryOutcome, DwnPaginationCursor, DwnPublicKeyJwk, DwnResponseStatus, SyncEngine } from '@enbox/agent';
import type { DataFormatAtPath, ProtocolPaths, SchemaMap, TypedProtocol, TypeNameAtPath } from './protocol-types.js';
import type { DwnApi, ProtocolsConfigureResponse, RecordsCountResponse } from './dwn-api.js';
import type { ProtocolDefinition, ProtocolType } from '@enbox/dwn-sdk-js';
import type { RecordFilter, RecordQuery } from './record-query.js';

import { createRecordView } from './record-view.js';
import { getTypeName } from '@enbox/dwn-sdk-js';
import { TypedRecord } from './typed-record.js';
import { compileRecordFilter, compileRecordQuery } from './record-query.js';

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/**
 * Resolves the TypeScript data type for a given protocol path.
 *
 * If the schema map contains a mapping for the type name at the given path,
 * that type is returned. Otherwise falls back to `unknown`.
 */
export type DataForPath<
  _D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = TypeNameAtPath<Path> extends keyof M ? M[TypeNameAtPath<Path>] : unknown;

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
 * The `data` field is type-checked against the protocol's schema map for
 * the given path, providing compile-time safety for record payloads.
 *
 * @typeParam D - The protocol definition type.
 * @typeParam M - The schema map mapping type names to TypeScript types.
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
export type TypedCreateRequest<
  D extends ProtocolDefinition,
  M extends SchemaMap,
  Path extends string,
> = {
  /** The data payload. Type-checked against the schema map for the given path. */
  data: DataForPath<D, M, Path>;

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
   * The returned record is stamped with its remote origin so subsequent
   * data reads target the owner tenant.
   *
   * Remote-path boundaries:
   * - {@link TypedCreateRequest.recipientRolePublicKey} is NOT supported
   *   with `from` — the agent throws rather than silently ignoring the key.
   * - {@link TypedCreateResponse.audienceKeyDelivery} is never present on
   *   remote writes — delivery provisioning is a local-processing concept.
   */
  from?: string;

  /**
   * The context ID of the parent record.
   *
   * Required when creating a child record under a parent in a hierarchical
   * protocol structure. Use the parent record's {@link TypedRecord.contextId | contextId}
   * as this value.
   *
   * @example
   * ```ts
   * const { record: notebook } = await proto.records.create('notebook', {
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

  /**
   * The DID of the intended recipient.
   *
   * Sets the recipient for permission-scoped records. The recipient may
   * have special read/write permissions as defined by the protocol's
   * `$actions` rules.
   */
  recipient?: string;

  /**
   * The recipient's role-path public key for this write, forwarded to the
   * agent when creating a `$role` record with a `recipient`.
   *
   * Supply it for recipients whose role-path key cannot be resolved from
   * their DWN (e.g. a bare `did:jwk` publishing no resolvable DWN
   * endpoint); the recipient computes the key locally and carries it out
   * of band for the writer to supply here. When omitted, role-audience
   * key delivery is best-effort and its outcome is reported on
   * {@link TypedCreateResponse.audienceKeyDelivery} instead of failing
   * the write.
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
   * The MIME type / data format for the record.
   *
   * If omitted, defaults to the first entry in the protocol type's
   * `dataFormats` array (typically `'application/json'`).
   */
  dataFormat?: DataFormatAtPath<D, Path>;

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
   * only — you can call {@link TypedRecord.store | record.store()} later.
   */
  store?: boolean;

};

/**
 * Response from {@link TypedEnbox} `records.create()`.
 *
 * Uses a discriminated union so that TypeScript narrows `record` to
 * `TypedRecord<T>` after a `status.code` check:
 *
 * ```ts
 * const result = await proto.records.create('notebook', { data });
 * if (result.record) {
 *   // TypeScript knows `record` is TypedRecord<NotebookData> here
 *   console.log(result.record.id);
 * }
 * ```
 *
 * When the accepted create wrote a `$role` record with a `recipient`, the
 * role-audience key-delivery outcome is forwarded on `audienceKeyDelivery`
 * (see {@link AudienceKeyDeliveryOutcome}) — a skipped best-effort delivery
 * is reported there with `delivered: false` instead of failing the write.
 *
 * @typeParam T - The data type of the created record.
 */
export type TypedCreateResponse<T = unknown> =
  | (DwnResponseStatus & { record: TypedRecord<T>; audienceKeyDelivery?: AudienceKeyDeliveryOutcome })
  | (DwnResponseStatus & { record: undefined; audienceKeyDelivery?: AudienceKeyDeliveryOutcome });

/**
 * Response from {@link TypedEnbox} `records.query()`.
 *
 * @typeParam T - The data type of the queried records.
 */
export type TypedQueryResponse<T = unknown> = DwnResponseStatus & {
  /**
   * The matching records, each wrapped as {@link TypedRecord | TypedRecord<T>}.
   *
   * The array is empty if no records match the filter criteria.
   */
  records: TypedRecord<T>[];

  /**
   * A pagination cursor for fetching the next page of results.
   *
   * Pass this to a subsequent `query()` call's `pagination.cursor` to
   * continue from where this page ended. `undefined` when there are no
   * more results.
   */
  cursor?: DwnPaginationCursor;
};

/**
 * Options for {@link TypedEnbox} `records.read()`.
 *
 * A `filter` is required to identify which record to read. The most common
 * approach is to filter by `recordId`.
 *
 * @example
 * ```ts
 * // Read a specific record by ID
 * const { record } = await proto.records.read('notebook', {
 *   filter: { recordId: notebookId },
 * });
 *
 * // Read from a remote DWN
 * const { record: remote } = await proto.records.read('notebook', {
 *   from: 'did:example:alice',
 *   filter: { recordId: notebookId },
 * });
 * ```
 */
export type TypedReadRequest<
  D extends ProtocolDefinition,
  Path extends ProtocolPaths<D> & string,
> = Pick<RecordQuery<D, Path>, 'from'> & {
  /**
   * Filter to identify the record to read.
   *
   * The `protocol`, `protocolPath`, and `schema` fields are auto-injected.
   * Typically you filter by `recordId` to read a specific record. Other
   * fields from `RecordsFilter` (like `contextId` and `recipient`) are also
   * available.
   */
  filter: RecordFilter<D, Path>;
};

/**
 * Response from {@link TypedEnbox} `records.read()`.
 *
 * Uses a discriminated union so that TypeScript narrows `record` to
 * `TypedRecord<T>` after a truthiness check:
 *
 * ```ts
 * const result = await proto.records.read('notebook', { filter: { recordId } });
 * if (result.record) {
 *   const data = await result.record.data.json(); // NotebookData
 * }
 * ```
 *
 * @typeParam T - The data type of the read record.
 */
export type TypedReadResponse<T = unknown> =
  | (DwnResponseStatus & { record: TypedRecord<T> })
  | (DwnResponseStatus & { record: undefined });

/**
 * Options for {@link TypedEnbox} `records.delete()`.
 *
 * @example
 * ```ts
 * const { status } = await proto.records.delete('notebook', {
 *   recordId: notebook.id,
 * });
 * ```
 */
export type TypedDeleteRequest = {
  /**
   * Full context ID of the target record, used only to resolve a context-scoped
   * delegated delete grant. It is not included in the RecordsDelete message.
   */
  contextId?: string;

  /**
   * A remote DWN DID to delete from.
   *
   * When set, the delete is performed on the specified DID's remote DWN.
   */
  from?: string;

  /**
   * The unique `recordId` of the record to delete.
   *
   * Use {@link TypedRecord.id | record.id} to obtain this value.
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
 * All record-returning methods wrap results in {@link TypedRecord} so that
 * the data type `T` (resolved from the schema map) flows end-to-end — from
 * write through read, query, and update — without manual casts.
 *
 * Obtain an instance via `enbox.using(typedProtocol)`.
 *
 * @example
 * ```ts
 * const social = enbox.using(SocialProtocol);
 *
 * await social.configure();
 *
 * const { record } = await social.records.create('friend', {
 *   data: { did: 'did:example:alice', alias: 'Alice' },
 * });
 * const data = await record.data.json(); // FriendData — no cast
 *
 * const { records } = await social.records.query('friend', {
 *   filter: { tags: { did: 'did:example:alice' } },
 * });
 * for (const r of records) {
 *   const d = await r.data.json(); // FriendData
 * }
 * ```
 */
export class TypedEnbox<
  D extends ProtocolDefinition = ProtocolDefinition,
  M extends SchemaMap = SchemaMap,
> {
  /** @internal */
  private readonly _dwn: DwnApi;
  /** @internal */
  private readonly _definition: D;
  /** @internal */
  private _configured: boolean = false;
  /** @internal */
  private _ensureReadyPromise: Promise<void> | null = null;
  /** @internal */
  private readonly _validPaths: Set<string>;
  /** @internal */
  private _records?: TypedEnbox<D, M>['records'];
  /** @internal — cached result of the `hasEncryptedTypes` scan (definition is immutable). */
  private readonly _hasEncryptedTypes: boolean;
  /** @internal */
  private readonly _options: TypedEnboxOptions;

  /**
   * @internal Create a new `TypedEnbox` instance. Use `enbox.using(protocol)` instead.
   * @param dwn - The underlying DWN API instance.
   * @param protocol - The typed protocol containing the definition and schema map.
   * @param options - Optional session-owned lifecycle and sync resources.
   */
  constructor(dwn: DwnApi, protocol: TypedProtocol<D, M>, options: TypedEnboxOptions = {}) {
    this._dwn = dwn;
    this._definition = protocol.definition;
    this._options = options;
    this._validPaths = collectPaths(this._definition.structure);
    this._hasEncryptedTypes = Object.values(this._definition.types)
      .some((type: ProtocolType) => type.encryptionRequired === true);
  }

  /**
   * The protocol URI string (e.g. `'https://example.com/social'`).
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
   * `ProtocolPaths<D>`, and data types are resolved from the schema map.
   *
   * Record-returning methods use {@link TypedRecord} instances that carry the
   * resolved data type from the schema map, providing end-to-end type safety.
   *
   * Available methods:
   * - {@link TypedEnbox.records.create | create(path, request)} — Create a new record
   * - {@link TypedEnbox.records.query | query(path, request?)} — Query records with filters
   * - {@link TypedEnbox.records.observe | observe(path, request)} — Observe immutable local query snapshots
   * - {@link TypedEnbox.records.count | count(path, request?)} — Count the same matching population
   * - {@link TypedEnbox.records.read | read(path, request)} — Read a single record
   * - {@link TypedEnbox.records.delete | delete(path, request)} — Delete a record by ID
   */
  public get records(): {
    create: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request: TypedCreateRequest<D, M, Path>,
    ) => Promise<TypedCreateResponse<DataForPath<D, M, Path>>>;

    query: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request?: RecordQuery<D, Path>,
    ) => Promise<TypedQueryResponse<DataForPath<D, M, Path>>>;

    observe: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request: Omit<RecordQuery<D, Path>, 'from' | 'pagination'> & {
        from?: never;
        pagination: { limit: number; cursor?: DwnPaginationCursor };
      },
    ) => Promise<RecordView<DataForPath<D, M, Path>>>;

    count: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request?: RecordQuery<D, Path>,
    ) => Promise<RecordsCountResponse>;

    read: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request: TypedReadRequest<D, Path>,
    ) => Promise<TypedReadResponse<DataForPath<D, M, Path>>>;

    delete: <Path extends ProtocolPaths<D> & string>(
      path: Path,
      request: TypedDeleteRequest,
    ) => Promise<DwnResponseStatus>;
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
       * the schema map for the given path.
       *
       * @param path - The protocol path (e.g. `'notebook'`, `'notebook/page'`).
       *   Provides compile-time autocompletion for valid paths.
       * @param request - Create options including the typed `data` payload
       *   and optional fields like `parentContextId`, `tags`, `recipient`.
       * @returns A {@link TypedCreateResponse} containing the DWN response
       *   `status` and the created {@link TypedRecord}.
       *
       * @example
       * ```ts
       * const { status, record } = await proto.records.create('notebook', {
       *   data: { name: 'My Notebook' },
       * });
       *
       * // Create a child page under the notebook's context
       * const { record: page } = await proto.records.create('notebook/page', {
       *   data: { title: 'First Page', body: '' },
       *   parentContextId: record.contextId,
       * });
       * ```
       */
      create: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedCreateRequest<D, M, Path>,
      ): Promise<TypedCreateResponse<DataForPath<D, M, Path>>> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const typeName = getTypeName(normalizedPath);
        const typeEntry = this._definition.types[typeName];

        const { status, record, audienceKeyDelivery } = await this._dwn.records.write({
          data                   : request.data,
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
          dataFormat             : request.dataFormat ?? typeEntry?.dataFormats?.[0],
        });

        return {
          status,
          record: record ? new TypedRecord<DataForPath<D, M, Path>>(record) : undefined,
          ...(audienceKeyDelivery ? { audienceKeyDelivery } : {}),
        };
      },

      /**
       * Query records at the given protocol path.
       *
       * Returns all matching records as an array of typed records, with
       * an optional pagination cursor for fetching additional pages.
       *
       * @param path - The protocol path to query (e.g. `'notebook'`,
       *   `'notebook/page'`).
       * @param request - Optional filter, sort, and pagination options.
       *   Omit entirely to return all records at the path.
       * @returns A {@link TypedQueryResponse} containing `status`, `records`
       *   (as {@link TypedRecord | TypedRecord<T>[]}), and an optional
       *   `cursor` for pagination.
       *
       * @example
       * ```ts
       * // Query all notebooks
       * const { records } = await proto.records.query('notebook');
       *
       * // Query pages under a specific notebook
       * const { records: pages } = await proto.records.query('notebook/page', {
       *   filter: { contextId: notebook.contextId },
       * });
       *
       * for (const page of pages) {
       *   const data = await page.data.json(); // PageData
       * }
       *
       * // Paginated query
       * const { records: batch, cursor } = await proto.records.query('notebook', {
       *   pagination: { limit: 10 },
       *   dateSort: DateSort.CreatedDescending,
       * });
       * ```
       */
      query: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request?: RecordQuery<D, Path>,
      ): Promise<TypedQueryResponse<DataForPath<D, M, Path>>> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const compiled = compileRecordQuery(this._definition, normalizedPath, request);
        const { status, records, cursor } = await this._dwn.records.query(compiled);

        return {
          status,
          records: records.map((r) => new TypedRecord<DataForPath<D, M, Path>>(r)),
          cursor,
        };
      },

      /**
       * Observe one bounded local query as immutable materialized snapshots.
       *
       * A local subscription is installed before the initial query. Its
       * payloads are wake hints only; every published collection comes from
       * re-running this exact canonical query. A pagination limit is required
       * so the view's retained collection has an explicit resource bound.
       */
      observe: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: Omit<RecordQuery<D, Path>, 'from' | 'pagination'> & {
          from?: never;
          pagination: { limit: number; cursor?: DwnPaginationCursor };
        },
      ): Promise<RecordView<DataForPath<D, M, Path>>> => {
        const normalizedPath = normalizePath(path);
        if ((request as RecordQuery<D, Path> | undefined)?.from !== undefined) {
          throw new TypeError('RecordView: remote queries are not supported; observe the connected tenant local replica.');
        }
        if (request?.pagination?.limit === undefined) {
          throw new TypeError('RecordView: pagination.limit is required to bound retained records.');
        }
        await this._ensureReady(normalizedPath);

        const compiled = compileRecordQuery(this._definition, normalizedPath, request);
        return createRecordView<DataForPath<D, M, Path>>({
          dwn         : this._dwn,
          filter      : compiled.filter,
          materialize : async () => {
            const { status, records, cursor } = await this._dwn.records.query(compiled);
            return {
              status,
              records: records.map((record) => new TypedRecord<DataForPath<D, M, Path>>(record)),
              cursor,
            };
          },
          protocol     : this._definition.protocol,
          protocolRole : compiled.protocolRole,
          signal       : this._options.signal,
          sync         : this._options.sync,
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
      ): Promise<RecordsCountResponse> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const compiled = compileRecordQuery(this._definition, normalizedPath, request);

        return this._dwn.records.count({
          from         : compiled.from,
          filter       : compiled.filter,
          protocolRole : compiled.protocolRole,
        });
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
       * @returns A {@link TypedReadResponse} containing `status` and the
       *   matching {@link TypedRecord}.
       *
       * @example
       * ```ts
       * const { record } = await proto.records.read('notebook', {
       *   filter: { recordId: notebookId },
       * });
       *
       * const data = await record.data.json(); // NotebookData
       * console.log(data.name);
       * ```
       */
      read: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedReadRequest<D, Path>,
      ): Promise<TypedReadResponse<DataForPath<D, M, Path>>> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        const readFilter = compileRecordFilter(this._definition, normalizedPath, request.filter);
        const { status, record } = await this._dwn.records.read({
          from   : request.from,
          filter : readFilter,
        });

        return {
          status,
          record: record ? new TypedRecord<DataForPath<D, M, Path>>(record) : undefined,
        };
      },

      /**
       * Delete a record at the given protocol path.
       *
       * The path is used for protocol validation and permission scoping,
       * while the actual record is identified by `recordId`.
       *
       * @param path - The protocol path (used for permission scoping and
       *   path validation).
       * @param request - Delete options. `recordId` is required; `contextId`
       *   scopes delegated grant resolution and `from` selects a remote DWN.
       * @returns The DWN response status.
       *
       * @example
       * ```ts
       * const { status } = await proto.records.delete('notebook', {
       *   recordId: notebook.id,
       * });
       *
       * if (status.code === 202) {
       *   console.log('Notebook deleted');
       * }
       * ```
       */
      delete: async <Path extends ProtocolPaths<D> & string>(
        path: Path,
        request: TypedDeleteRequest,
      ): Promise<DwnResponseStatus> => {
        const normalizedPath = normalizePath(path);
        await this._ensureReady(normalizedPath);
        return this._dwn.records.delete({
          contextId    : request.contextId,
          from         : request.from,
          protocol     : this._definition.protocol,
          protocolPath : normalizedPath,
          recordId     : request.recordId,
          prune        : request.prune,
        });
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

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$encryption' || key === '$keyAgreement') { continue; }
    result[key] = stripEncryptionBlocks(val);
  }
  return result;
}

/**
 * Returns `true` when the given structure node carries an injected
 * `$keyAgreement.publicKeyJwk`.
 */
function hasKeyAgreementKey(node: Record<string, unknown>): boolean {
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
 * `$`-prefixed keys are skipped, and `$ref` composition nodes are exempt —
 * their records are governed by the referenced protocol's own keys — while
 * their children (which belong to the composing protocol) are still checked.
 */
function collectMissingKeyAgreementPaths(definition: ProtocolDefinition): string[] {
  const missing: string[] = [];

  if (!hasKeyAgreementKey(definition as unknown as Record<string, unknown>)) {
    missing.push('');
  }

  const walk = (structure: Record<string, unknown>, prefix: string): void => {
    for (const key of Object.keys(structure)) {
      if (key.startsWith('$')) { continue; }

      const node = structure[key];
      if (node === null || typeof node !== 'object') { continue; }

      const nodeRecord = node as Record<string, unknown>;
      const path = prefix ? `${prefix}/${key}` : key;

      // `$ref` nodes are skipped by the injection (governed by the referenced
      // protocol) — children still belong to the composing protocol.
      if (nodeRecord.$ref === undefined && !hasKeyAgreementKey(nodeRecord)) {
        missing.push(path);
      }

      walk(nodeRecord, path);
    }
  };

  walk(definition.structure as Record<string, unknown>, '');
  return missing;
}

/**
 * Strips leading and trailing slashes from a path.
 *
 * `'friend/'` → `'friend'`, `'/group/member/'` → `'group/member'`.
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
 * Recursively collects all valid protocol path strings from a structure object.
 *
 * Given `{ foo: { bar: { $actions: [...] } } }`, returns `Set(['foo', 'foo/bar'])`.
 * Keys starting with `$` are skipped.
 */
function collectPaths(
  structure: Record<string, unknown>,
  prefix: string = '',
): Set<string> {
  const paths = new Set<string>();

  for (const key of Object.keys(structure)) {
    if (key.startsWith('$')) { continue; }

    const fullPath = prefix ? `${prefix}/${key}` : key;
    paths.add(fullPath);

    const child = structure[key];
    if (child !== null && typeof child === 'object') {
      for (const nested of collectPaths(child as Record<string, unknown>, fullPath)) {
        paths.add(nested);
      }
    }
  }

  return paths;
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
