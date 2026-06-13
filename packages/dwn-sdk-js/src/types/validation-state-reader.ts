import type { GenericMessage } from './message-types.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { ProtocolDefinition } from './protocols-types.js';
import type { RecordsWrite } from '../interfaces/records-write.js';
import type { RecordsWriteMessage } from './records-types.js';

/**
 * The single narrow surface through which validation logic reads state.
 *
 * Every validation-time state read performed during message admission routes through this
 * interface, so the replay basis (initial writes ∪ latest states ∪ tombstones ∪ protocol-config
 * history ∪ permission records) provably stays closed under admission's read set. Validation
 * modules (`core/protocol-authorization*`, `protocols/permissions*`) are lint-banned from
 * importing `MessageStore` directly; a new protocol-engine feature that needs new state must add
 * a reader method here.
 */
export interface ValidationStateReader {
  /**
   * Fetches a record's initial `RecordsWrite` by entry ID, parsed.
   * @returns the initial write, or `undefined` when no message carries the entry ID.
   */
  fetchInitialRecordsWrite(tenant: string, recordId: string): Promise<RecordsWrite | undefined>;

  /**
   * Fetches a record's initial write from among all of the record's writes.
   * @returns the initial write message, or `undefined` when the record has no messages at all.
   * @throws {DwnError} with `RecordsWriteGetInitialWriteNotFound` when writes exist for the
   *         record but none of them is the initial write.
   */
  fetchInitialWrite(tenant: string, recordId: string): Promise<RecordsWriteMessage | undefined>;

  /**
   * Constructs the chain of existing records from the root to the given
   * descendant, each represented by its initial `RecordsWrite`.
   * @returns the chain root-first; an empty array when `descendantRecordId` is `undefined`.
   * @throws {DwnError} with `ProtocolAuthorizationParentNotFoundConstructingRecordChain` when any
   *         link in the chain is missing.
   */
  constructRecordChain(tenant: string, descendantRecordId: string | undefined): Promise<RecordsWriteMessage[]>;

  /**
   * Fetches the immediate parent record for protocolPath/contextId verification.
   *
   * Queries the latest-state write first — the fast path that excludes deleted parents. If no
   * latest write exists, a retained initial write is sufficient for immutable parent facts
   * (protocolPath/contextId) provided no local tombstone exists for that record.
   * @returns the parent write, or `undefined` when the parent is absent (or deleted).
   */
  fetchParentRecord(input: {
    tenant: string;
    parentProtocolUri: string;
    parentId: string;
  }): Promise<RecordsWriteMessage | undefined>;

  /**
   * Checks whether a role record matching the invoked-role selector exists.
   * Filter-only — role validation never reads record data. The latest-state match is the fast
   * path. If no latest match exists, a retained initial role write is sufficient for immutable
   * role facts (recipient/path/context) provided no local tombstone exists for that role record.
   */
  hasMatchingRoleRecord(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    recipient: string;
    contextIdPrefix?: string;
  }): Promise<boolean>;

  /**
   * Queries the latest-state role records matching the given
   * selector, used to reject duplicate role assignments to the same recipient. Filter-only.
   */
  queryLatestRoleRecords(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    recipient: string;
    contextIdPrefix?: string;
  }): Promise<RecordsWriteMessage[]>;

  /**
   * Fetches the permission grant with the given record ID, with its scope parsed from grant data.
   * @throws {DwnError} with `GrantAuthorizationGrantMissing` when the grant does not exist.
   */
  fetchGrant(tenant: string, permissionGrantId: string): Promise<PermissionGrant>;

  /**
   * Fetches the oldest latest-state revocation record for the given permission grant, if any.
   * Grant activity checks compare the oldest revocation timestamp to the incoming message timestamp.
   */
  fetchOldestGrantRevocation(tenant: string, permissionGrantId: string): Promise<GenericMessage | undefined>;

  /**
   * Fetches the newest `RecordsWrite` associated with a record, used to authorize `Messages.Read`
   * access to `RecordsDelete` messages by projecting the delete back to the deleted record's
   * protocol scope.
   * @throws {DwnError} with `RecordsWriteGetNewestWriteRecordNotFound` when no write exists.
   */
  fetchNewestRecordsWrite(tenant: string, recordId: string): Promise<RecordsWriteMessage>;

  /**
   * Fetches the protocol definition for the given protocol URI.
   * When `messageTimestamp` is provided, returns the definition active at that point in time —
   * the `ProtocolsConfigure` with the greatest `messageTimestamp` that is <= the given timestamp,
   * read from retained config history. When not provided, returns the latest definition.
   * Core protocol definitions are returned from the registry without a store read.
   * @throws {DwnError} with `ProtocolAuthorizationProtocolNotFound` when no definition exists.
   */
  fetchProtocolDefinition(tenant: string, protocolUri: string, messageTimestamp?: string): Promise<ProtocolDefinition>;

  /**
   * Counts the latest-state records at a `$recordLimit` scope:
   * protocol + protocolPath within the parent context.
   */
  countLatestRecordsAtScope(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    contextIdPrefix?: string;
  }): Promise<number>;

  /**
   * Fetches the latest `$squash: true` record at a protocol path within the parent context.
   * This is the temporal floor used by the squash backstop.
   */
  fetchLatestSquashRecordAtScope(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    contextIdPrefix?: string;
  }): Promise<RecordsWriteMessage | undefined>;

  /**
   * Checks whether the data with the given CID is present in the `DataStore` for the given record.
   * This is the prior-data integrity check for dataless non-initial writes.
   */
  hasStoredData(tenant: string, recordId: string, dataCid: string): Promise<boolean>;
}
