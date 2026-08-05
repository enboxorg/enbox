import type { CoreProtocolRegistry } from './core-protocol.js';
import type { DataStore } from '../types/data-store.js';
import type { Filter } from '../types/query-types.js';
import type { GenericMessage } from '../types/message-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { ProtocolDefinition } from '../types/protocols-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { DataEncodedRecordsWriteMessage, RecordsWriteMessage } from '../types/records-types.js';

import { ENCRYPTION_CONTROL_AUDIENCE_PATH } from './constants.js';
import { PermissionGrant } from '../protocols/permission-grant.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { queryProtocolConfigure } from './protocol-configure-lookup.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { SortDirection } from '../types/query-types.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { fetchInitialRecordsWrite, fetchInitialRecordsWriteMessage, getInitialWrite } from '../interfaces/records-write-query.js';

/**
 * The store-backed `ValidationStateReader` — the single place where validation-time state reads
 * touch the `MessageStore`/`DataStore`.
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
  }): Promise<RecordsWriteMessage | undefined> {
    const { tenant, parentProtocolUri, parentId } = input;

    const latestStateQuery: Filter = {
      isLatestBaseState : true, // NOTE: this filter is critical, to ensure are are not returning a deleted parent
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      protocol          : parentProtocolUri,
      recordId          : parentId
    };
    const { messages: parentMessages } = await this.messageStore.query(tenant, [latestStateQuery]);
    const latestParent = (parentMessages as RecordsWriteMessage[])[0];
    if (latestParent !== undefined) {
      return latestParent;
    }

    const initialWrite = await fetchInitialRecordsWriteMessage(this.messageStore, tenant, parentId);
    if (initialWrite?.descriptor.protocol !== parentProtocolUri) {
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
  }): Promise<boolean> {
    const latestStateFilter = StoreValidationStateReader.constructRoleRecordFilter({ ...input, latestStateOnly: true });
    const { messages: matchingMessages } = await this.messageStore.query(input.tenant, [latestStateFilter]);
    if (matchingMessages.length > 0) {
      return true;
    }

    const anyWriteFilter = StoreValidationStateReader.constructRoleRecordFilter({ ...input, latestStateOnly: false });
    const { messages: candidates } = await this.messageStore.query(input.tenant, [anyWriteFilter]);

    for (const candidate of candidates as RecordsWriteMessage[]) {
      if (!await RecordsWrite.isInitialWrite(candidate)) {
        continue;
      }

      if (!await this.recordHasLocalTombstone(input.tenant, candidate.recordId)) {
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
  public async queryAudienceRecords(input: {
    tenant: string;
    protocol: string;
    rolePath: string;
    contextId: string;
    keyId?: string;
  }): Promise<RecordsWriteMessage[]> {
    const filter: Filter = {
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      protocol          : input.protocol,
      protocolPath      : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      'tag.protocol'    : input.protocol,
      'tag.rolePath'    : input.rolePath,
      'tag.contextId'   : input.contextId,
    };

    if (input.keyId !== undefined) {
      filter['tag.keyId'] = input.keyId;
    }

    const { messages } = await this.messageStore.query(input.tenant, [filter]);
    return messages as RecordsWriteMessage[];
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
    const query = PermissionsProtocol.grantRevocationFilter(permissionGrantId);
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
  public async fetchProtocolDefinition(tenant: string, protocolUri: string, messageTimestamp?: string): Promise<ProtocolDefinition> {
    // if the protocol is a registered core protocol, return the definition directly without a store query
    if (this.coreProtocols !== undefined) {
      const coreDefinition = this.coreProtocols.getDefinition(protocolUri);
      if (coreDefinition !== undefined) {
        return coreDefinition;
      }
    }

    // fetch the corresponding protocol definition
    const protocolMessage = await queryProtocolConfigure(this.messageStore, tenant, protocolUri, messageTimestamp);
    if (protocolMessage === undefined) {
      throw new DwnError(DwnErrorCode.ProtocolAuthorizationProtocolNotFound, `unable to find protocol definition for ${protocolUri}`);
    }

    return protocolMessage.descriptor.definition;
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
      filter.contextId = { subtree: input.contextIdPrefix };
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
   * Retained initial writes can prove immutable parent/role facts, but a tombstone still wins.
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
      filter.contextId = { subtree: input.contextIdPrefix };
    }

    return filter;
  }
}
