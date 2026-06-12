import type { CoreProtocolRegistry } from './core-protocol.js';
import type { DataStore } from '../types/data-store.js';
import type { Filter } from '../types/query-types.js';
import type { GenericMessage } from '../types/message-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { DataEncodedRecordsWriteMessage, RecordsWriteMessage } from '../types/records-types.js';
import type { ProtocolDefinition, ProtocolsConfigureMessage } from '../types/protocols-types.js';
import type { ValidationMode, ValidationStateReader } from '../types/validation-state-reader.js';

import { FilterUtility } from '../utils/filter.js';
import { PermissionGrant } from '../protocols/permission-grant.js';
import { PERMISSIONS_REVOCATION_PATH } from './constants.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { SortDirection } from '../types/query-types.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { fetchInitialRecordsWrite, fetchInitialRecordsWriteMessage, getInitialWrite } from '../interfaces/records-write-query.js';

/**
 * The store-backed `ValidationStateReader` — the single place where validation-time state reads
 * touch the `MessageStore`/`DataStore`, and the home of every replicated-validation divergence
 * (read-set table rows 3, 4, and 6). The divergences are implemented here keyed on
 * `ValidationMode` — nowhere else — so the divergence list stays grep-ably exhaustive.
 */
export class StoreValidationStateReader implements ValidationStateReader {
  private readonly messageStore: MessageStore;
  private readonly dataStore: DataStore;
  private readonly coreProtocols?: CoreProtocolRegistry;

  public constructor(input: {
    messageStore: MessageStore;
    dataStore: DataStore;
    coreProtocols?: CoreProtocolRegistry;
  }) {
    this.messageStore = input.messageStore;
    this.dataStore = input.dataStore;
    this.coreProtocols = input.coreProtocols;
  }

  /** @inheritdoc */
  public async fetchInitialRecordsWrite(tenant: string, recordId: string): Promise<RecordsWrite | undefined> {
    return fetchInitialRecordsWrite(this.messageStore, tenant, recordId);
  }

  /** @inheritdoc */
  public async fetchInitialWrite(tenant: string, recordId: string): Promise<RecordsWriteMessage | undefined> {
    const query: Filter = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
      recordId  : recordId
    };
    const { messages } = await this.messageStore.query(tenant, [query]);

    if (messages.length === 0) {
      return undefined;
    }

    const initialWrite = await getInitialWrite(messages);
    return initialWrite;
  }

  /** @inheritdoc */
  public async constructRecordChain(tenant: string, descendantRecordId: string | undefined): Promise<RecordsWriteMessage[]> {
    if (descendantRecordId === undefined) {
      return [];
    }

    const recordChain: RecordsWriteMessage[] = [];

    // keep walking up the chain from the inbound message's parent, until there is no more parent
    let currentRecordId: string | undefined = descendantRecordId;
    while (currentRecordId !== undefined) {

      const initialWrite = await this.fetchInitialWrite(tenant, currentRecordId);

      // RecordsWrite needed should be available since we perform necessary checks at the time of writes,
      // eg. check the immediate parent in `verifyProtocolPathAndContextId` at the time of writing,
      // so if this condition is triggered, it means there is an unexpected bug that caused an incomplete chain.
      // We add additional defensive check here because returning an unexpected/incorrect record chain could lead to security vulnerabilities.
      if (initialWrite === undefined) {
        throw new DwnError(
          DwnErrorCode.ProtocolAuthorizationParentNotFoundConstructingRecordChain,
          `Unexpected error that should never trigger: no parent found with ID ${currentRecordId} when constructing record chain.`
        );
      }

      recordChain.push(initialWrite);
      currentRecordId = initialWrite.descriptor.parentId;
    }

    return recordChain.reverse(); // root record first
  }

  /** @inheritdoc */
  public async fetchParentRecord(input: {
    tenant: string;
    parentProtocolUri: string;
    parentId: string;
    validationMode: ValidationMode;
  }): Promise<RecordsWriteMessage | undefined> {
    const { tenant, parentProtocolUri, parentId, validationMode } = input;

    const latestStateQuery: Filter = {
      isLatestBaseState : true, // NOTE: this filter is critical, to ensure are are not returning a deleted parent
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      protocol          : parentProtocolUri,
      recordId          : parentId
    };
    const { messages: parentMessages } = await this.messageStore.query(tenant, [latestStateQuery]);
    const latestParent = (parentMessages as RecordsWriteMessage[])[0];

    if (latestParent !== undefined || validationMode === 'live') {
      return latestParent;
    }

    // Replicated divergence — read-set row 3 (parent): a data-compacted parent is ancestry-only
    // mid-replay, so when no latest-state write exists, accept the parent's initial write for the
    // immutable protocolPath/contextId facts — provided no local RecordsDelete tombstone exists
    // for the parent, which preserves exactly the deleted-parent exclusion the latest-only filter
    // exists for, evaluated against replayed state in replayed order.
    const initialWrite = await fetchInitialRecordsWriteMessage(this.messageStore, tenant, parentId);
    if (initialWrite === undefined || initialWrite.descriptor.protocol !== parentProtocolUri) {
      return undefined;
    }

    if (await this.recordHasLocalTombstone(tenant, parentId)) {
      return undefined;
    }

    return initialWrite;
  }

  /** @inheritdoc */
  public async hasMatchingRoleRecord(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    recipient: string;
    contextIdPrefix?: string;
    validationMode: ValidationMode;
  }): Promise<boolean> {
    const { tenant, validationMode } = input;

    const latestStateFilter = StoreValidationStateReader.constructRoleRecordFilter({ ...input, latestStateOnly: true });
    const { messages: matchingMessages } = await this.messageStore.query(tenant, [latestStateFilter]);

    if (matchingMessages.length > 0 || validationMode === 'live') {
      return matchingMessages.length > 0;
    }

    // Replicated divergence — read-set row 4 (role): a role record superseded or compacted after
    // its dependents is ancestry-only mid-replay, so when no latest-state match exists, accept an
    // initial-write role record matching the selector — recipient, protocolPath, and context are
    // initial-write facts — provided its record has no local tombstone. The lookup stays
    // filter-only: role validation never reads record data.
    const anyWriteFilter = StoreValidationStateReader.constructRoleRecordFilter({ ...input, latestStateOnly: false });
    const { messages: candidates } = await this.messageStore.query(tenant, [anyWriteFilter]);

    for (const candidate of candidates as RecordsWriteMessage[]) {
      if (!await RecordsWrite.isInitialWrite(candidate)) {
        continue;
      }

      if (!await this.recordHasLocalTombstone(tenant, candidate.recordId)) {
        return true;
      }
    }

    return false;
  }

  /** @inheritdoc */
  public async queryLatestRoleRecords(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    recipient: string;
    contextIdPrefix?: string;
  }): Promise<RecordsWriteMessage[]> {
    const filter = StoreValidationStateReader.constructRoleRecordFilter({ ...input, latestStateOnly: true });
    const { messages: matchingMessages } = await this.messageStore.query(input.tenant, [filter]);
    return matchingMessages as RecordsWriteMessage[];
  }

  /** @inheritdoc */
  public async fetchGrant(tenant: string, permissionGrantId: string): Promise<PermissionGrant> {
    const grantQuery = {
      recordId          : permissionGrantId,
      isLatestBaseState : true
    };
    const { messages } = await this.messageStore.query(tenant, [grantQuery]);
    const possibleGrantMessage: GenericMessage | undefined = messages[0];

    const dwnInterface = possibleGrantMessage?.descriptor.interface;
    const dwnMethod = possibleGrantMessage?.descriptor.method;

    if (dwnInterface !== DwnInterfaceName.Records ||
        dwnMethod !== DwnMethodName.Write ||
        (possibleGrantMessage as RecordsWriteMessage).descriptor.protocolPath !== PermissionsProtocol.grantPath) {
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationGrantMissing,
        `Could not find permission grant with record ID ${permissionGrantId}.`
      );
    }

    const permissionGrantMessage = possibleGrantMessage as DataEncodedRecordsWriteMessage;
    const permissionGrant = PermissionGrant.parse(permissionGrantMessage);

    return permissionGrant;
  }

  /** @inheritdoc */
  public async fetchOldestGrantRevocation(tenant: string, permissionGrantId: string): Promise<GenericMessage | undefined> {
    const query: Filter = {
      parentId          : permissionGrantId,
      protocolPath      : PERMISSIONS_REVOCATION_PATH,
      isLatestBaseState : true
    };
    const { messages } = await this.messageStore.query(
      tenant,
      [query],
      { messageTimestamp: SortDirection.Ascending },
      { limit: 1 },
    );

    return messages[0];
  }

  /** @inheritdoc */
  public async fetchNewestRecordsWrite(tenant: string, recordId: string): Promise<RecordsWriteMessage> {
    return RecordsWrite.fetchNewestRecordsWrite(this.messageStore, tenant, recordId);
  }

  /** @inheritdoc */
  public async getGoverningTimestamp(input: {
    tenant: string;
    recordId: string;
    messageTimestamp: string;
    validationMode: ValidationMode;
  }): Promise<string | undefined> {
    const existingInitialWrite = await this.fetchInitialWrite(input.tenant, input.recordId);

    if (existingInitialWrite !== undefined) {
      // update case: use the initial write's timestamp — the protocol version is locked at creation time
      return existingInitialWrite.descriptor.messageTimestamp;
    }

    if (input.validationMode === 'replicated') {
      // Replicated divergence — read-set row 6 (protocol definition): the governing config for an
      // initial write is selected by the message's own messageTimestamp against retained config
      // history, reproducing the definition that governed the write's original admission.
      return input.messageTimestamp;
    }

    // live initial write case: validate against the latest protocol definition
    return undefined;
  }

  /** @inheritdoc */
  public async fetchProtocolDefinition(tenant: string, protocolUri: string, messageTimestamp?: string): Promise<ProtocolDefinition> {
    // if the protocol is a registered core protocol, return the definition directly without a store query
    if (this.coreProtocols !== undefined) {
      const coreDefinition = this.coreProtocols.getDefinition(protocolUri);
      if (coreDefinition !== undefined) {
        return coreDefinition;
      }
    }

    // fetch the corresponding protocol definition
    const query: Filter = {
      interface : DwnInterfaceName.Protocols,
      method    : DwnMethodName.Configure,
      protocol  : protocolUri,
    };

    if (messageTimestamp === undefined) {
      // default: return only the latest protocol definition
      query.isLatestBaseState = true;
    } else {
      // temporal lookup: find the protocol definition active at the given timestamp
      query.messageTimestamp = { lte: messageTimestamp };
    }

    let { messages: protocols } = await this.messageStore.query(
      tenant,
      [query],
      { messageTimestamp: SortDirection.Descending },
      { limit: 1 },
    );

    if (protocols.length === 0 && messageTimestamp !== undefined) {
      // A record can be authored (messageTimestamp) before the protocol's earliest retained
      // config yet still have been admitted under it — admission order, not timestamp order,
      // governed the source (in-scope dependencies are ordered by construction). When no config
      // predates the record, fall back to the OLDEST retained config: deterministic on every
      // replica, and the closest approximation to what governed the earliest admissions. A
      // protocol that is genuinely not installed still has zero configs and fails below.
      ({ messages: protocols } = await this.messageStore.query(
        tenant,
        [{
          interface : DwnInterfaceName.Protocols,
          method    : DwnMethodName.Configure,
          protocol  : protocolUri,
        }],
        { messageTimestamp: SortDirection.Ascending },
        { limit: 1 },
      ));
    }

    if (protocols.length === 0) {
      throw new DwnError(DwnErrorCode.ProtocolAuthorizationProtocolNotFound, `unable to find protocol definition for ${protocolUri}`);
    }

    const protocolMessage = protocols[0] as ProtocolsConfigureMessage;
    return protocolMessage.descriptor.definition;
  }

  /** @inheritdoc */
  public async countLatestRecordsAtScope(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    contextIdPrefix?: string;
  }): Promise<number> {
    const filter: Filter = {
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      protocol          : input.protocol,
      protocolPath      : input.protocolPath,
    };

    if (input.contextIdPrefix !== undefined) {
      filter.contextId = FilterUtility.constructPrefixFilterAsRangeFilter(input.contextIdPrefix);
    }

    return this.messageStore.count(input.tenant, [filter]);
  }

  /** @inheritdoc */
  public async fetchLatestSquashRecordAtScope(input: {
    tenant: string;
    protocol: string;
    protocolPath: string;
    contextIdPrefix?: string;
  }): Promise<RecordsWriteMessage | undefined> {
    const filter: Filter = {
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      protocol          : input.protocol,
      protocolPath      : input.protocolPath,
      squash            : true,
    };

    if (input.contextIdPrefix !== undefined) {
      filter.contextId = FilterUtility.constructPrefixFilterAsRangeFilter(input.contextIdPrefix);
    }

    const { messages } = await this.messageStore.query(
      input.tenant,
      [filter],
      { messageTimestamp: SortDirection.Descending },
      { limit: 1 },
    );

    return messages[0] as RecordsWriteMessage | undefined;
  }

  /** @inheritdoc */
  public async hasStoredData(tenant: string, recordId: string, dataCid: string): Promise<boolean> {
    const dataStoreGetResult = await this.dataStore.get(tenant, recordId, dataCid);
    return dataStoreGetResult !== undefined;
  }

  /**
   * Checks whether a `RecordsDelete` tombstone for the given record is locally present.
   * Used by the replicated reconstruction fallbacks (read-set rows 3 and 4) to preserve the
   * deleted-record exclusion that the live path's `isLatestBaseState` filter provides.
   */
  private async recordHasLocalTombstone(tenant: string, recordId: string): Promise<boolean> {
    const tombstoneQuery: Filter = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Delete,
      recordId  : recordId
    };
    const { messages } = await this.messageStore.query(tenant, [tombstoneQuery]);
    return messages.length > 0;
  }

  /**
   * Constructs the role-record selector filter shared by the invoked-role lookup and the
   * duplicate-role-recipient uniqueness check.
   */
  private static constructRoleRecordFilter(input: {
    protocol: string;
    protocolPath: string;
    recipient: string;
    contextIdPrefix?: string;
    latestStateOnly: boolean;
  }): Filter {
    const filter: Filter = {
      interface    : DwnInterfaceName.Records,
      method       : DwnMethodName.Write,
      protocol     : input.protocol,
      protocolPath : input.protocolPath,
      recipient    : input.recipient,
    };

    if (input.latestStateOnly) {
      filter.isLatestBaseState = true;
    }

    if (input.contextIdPrefix !== undefined) {
      filter.contextId = FilterUtility.constructPrefixFilterAsRangeFilter(input.contextIdPrefix);
    }

    return filter;
  }
}
