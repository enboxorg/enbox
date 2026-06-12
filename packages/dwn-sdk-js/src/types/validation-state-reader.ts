import type { GenericMessage } from './message-types.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { ProtocolDefinition } from './protocols-types.js';
import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from './records-types.js';

/**
 * The validation mode a message is admitted under.
 *
 * - `live`: direct authoring through `processMessage()` — every validation read sees current state
 *   and is enforced strictly.
 * - `replicated`: admission through `applyReplicatedMessage()` — the message was already validated
 *   by its source against the state the source held at that position, so a small, exhaustively
 *   enumerated set of reads (read-set table rows 3, 4, and 6) reconstructs the historical answer
 *   from retained material instead of requiring current-latest state.
 *
 * The mode is threaded from the two entry points as a per-call field on `MethodHandler.handle()`
 * input — never stored on the shared `HandlerDependencies` bag.
 */
export type ValidationMode = 'live' | 'replicated';

/**
 * The single narrow surface through which validation logic reads state.
 *
 * Every validation-time state read performed during message admission routes through this
 * interface, so the replay basis (initial writes ∪ latest states ∪ tombstones ∪ protocol-config
 * history ∪ permission records) provably stays closed under admission's read set. Validation
 * modules (`core/protocol-authorization*`, `protocols/permissions*`) are lint-banned from
 * importing `MessageStore` directly; a new protocol-engine feature that needs new state must add
 * a reader method here, which forces writing its read-set table row first.
 *
 * Each method's doc names its row in the read-set table (sync replication-log design,
 * "Invariant and the replay basis"). Methods take a `ValidationMode` argument only where the
 * replicated behavior diverges from live — rows 3, 4, and 6 are the complete divergence list.
 */
export interface ValidationStateReader {
  /**
   * Read-set row 1: fetches a record's initial `RecordsWrite` by entry ID, parsed.
   * @returns the initial write, or `undefined` when no message carries the entry ID.
   */
  fetchInitialRecordsWrite(tenant: string, recordId: string): Promise<RecordsWrite | undefined>;

  /**
   * Read-set row 1: fetches a record's initial write from among all of the record's writes.
   * @returns the initial write message, or `undefined` when the record has no messages at all.
   * @throws {DwnError} with `RecordsWriteGetInitialWriteNotFound` when writes exist for the
   *         record but none of them is the initial write.
   */
  fetchInitialWrite(tenant: string, recordId: string): Promise<RecordsWriteMessage | undefined>;

  /**
   * Read-set row 1: constructs the chain of existing records from the root to the given
   * descendant, each represented by its initial `RecordsWrite`.
   * @returns the chain root-first; an empty array when `descendantRecordId` is `undefined`.
   * @throws {DwnError} with `ProtocolAuthorizationParentNotFoundConstructingRecordChain` when any
   *         link in the chain is missing.
   */
  constructRecordChain(tenant: string, descendantRecordId: string | undefined): Promise<RecordsWriteMessage[]>;

  /**
   * Read-set row 3: fetches the immediate parent record for protocolPath/contextId verification.
   *
   * Live mode queries the latest-state write only — the `isLatestBaseState` filter is what
   * excludes deleted parents. Replicated mode adds a reconstruction fallback: when no latest
   * write exists (a data-compacted parent is ancestry-only mid-replay), the parent's initial
   * write is accepted for the immutable protocolPath/contextId facts, provided no local
   * `RecordsDelete` tombstone exists for the parent — preserving the deleted-parent exclusion.
   * @returns the parent write, or `undefined` when the parent is absent (or deleted).
   */
  fetchParentRecord(input: {
    tenant: string;
    parentProtocolUri: string;
    parentId: string;
    validationMode: ValidationMode;
  }): Promise<RecordsWriteMessage | undefined>;

  /**
   * Read-set row 4: checks whether a role record matching the invoked-role selector exists.
   * Filter-only — role validation never reads record data.
   *
   * Live mode requires a latest-state match. Replicated mode adds a reconstruction fallback:
   * when no latest match exists (a role record superseded or compacted after its dependents),
   * an initial-write role record matching the selector is accepted — recipient, protocolPath,
   * and context are initial-write facts — provided its record has no local tombstone.
   */
  hasMatchingRoleRecord(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    recipient: string;
    contextIdPrefix?: string;
    validationMode: ValidationMode;
  }): Promise<boolean>;

  /**
   * Read-set row 4 (role uniqueness): queries the latest-state role records matching the given
   * selector, used to reject duplicate role assignments to the same recipient. Filter-only; no
   * mode divergence — the uniqueness constraint is enforced identically in both modes.
   */
  queryLatestRoleRecords(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    recipient: string;
    contextIdPrefix?: string;
  }): Promise<RecordsWriteMessage[]>;

  /**
   * Read-set row 5: fetches the permission grant with the given record ID (latest state, scope
   * parsed from the grant's data).
   * @throws {DwnError} with `GrantAuthorizationGrantMissing` when the grant does not exist.
   */
  fetchGrant(tenant: string, permissionGrantId: string): Promise<PermissionGrant>;

  /**
   * Read-set row 5: fetches the oldest latest-state revocation record for the given permission
   * grant, if any. Grant activity checks compare the oldest revocation timestamp to the incoming
   * message timestamp.
   */
  fetchOldestGrantRevocation(tenant: string, permissionGrantId: string): Promise<GenericMessage | undefined>;

  /**
   * Read-set row 2: fetches the newest `RecordsWrite` associated with a record, used to authorize
   * `Messages.Read` access to `RecordsDelete` messages by projecting the delete back to the
   * deleted record's protocol scope.
   * @throws {DwnError} with `RecordsWriteGetNewestWriteRecordNotFound` when no write exists.
   */
  fetchNewestRecordsWrite(tenant: string, recordId: string): Promise<RecordsWriteMessage>;

  /**
   * Read-set row 6: determines the timestamp that selects the governing protocol definition for
   * the given `RecordsWrite`.
   *
   * For an update (an initial write already exists), both modes return the initial write's
   * `messageTimestamp` — the protocol version is locked at creation time. For an initial write,
   * live mode returns `undefined` (the record is being created now, so the latest definition
   * governs) while replicated mode returns the message's own `messageTimestamp`, selecting the
   * historically-governing config from retained config history.
   * @throws {DwnError} with `RecordsWriteGetInitialWriteNotFound` when writes exist for the
   *         record but none of them is the initial write.
   */
  getGoverningTimestamp(input: {
    tenant: string;
    recordId: string;
    messageTimestamp: string;
    validationMode: ValidationMode;
  }): Promise<string | undefined>;

  /**
   * Read-set row 6: fetches the protocol definition for the given protocol URI.
   * When `messageTimestamp` is provided, returns the definition active at that point in time —
   * the `ProtocolsConfigure` with the greatest `messageTimestamp` that is <= the given timestamp,
   * read from retained config history. When not provided, returns the latest definition.
   * Core protocol definitions are returned from the registry without a store read.
   * @throws {DwnError} with `ProtocolAuthorizationProtocolNotFound` when no definition exists.
   */
  fetchProtocolDefinition(tenant: string, protocolUri: string, messageTimestamp?: string): Promise<ProtocolDefinition>;

  /**
   * Read-set row 7: counts the latest-state records at a `$recordLimit` scope
   * (protocol + protocolPath within the parent context). No mode divergence in this reader —
   * live-mode `Reject` semantics apply as-is; the replicated occupancy fold is a separate,
   * later change.
   */
  countLatestRecordsAtScope(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    contextIdPrefix?: string;
  }): Promise<number>;

  /**
   * Read-set row 9: fetches the latest `$squash: true` record at a protocol path within the parent
   * context. This is the temporal floor used by the squash backstop.
   */
  fetchLatestSquashRecordAtScope(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    contextIdPrefix?: string;
  }): Promise<RecordsWriteMessage | undefined>;

  /**
   * Read-set row 8: checks whether the data with the given CID is present in the `DataStore` for
   * the given record — the prior-data integrity check for dataless non-initial writes.
   */
  hasStoredData(tenant: string, recordId: string, dataCid: string): Promise<boolean>;
}
