import type { CoreModuleRegistry } from './core-module.js';
import type { DataStore } from '../types/data-store.js';
import type { Filter } from '../types/query-types.js';
import type { GenericMessage } from '../types/message-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { ModuleDefinition } from '../types/modules-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { DataEncodedRecordsWriteMessage, RecordsWriteMessage } from '../types/records-types.js';

import { ENCRYPTION_CONTROL_AUDIENCE_PATH } from './constants.js';
import { PermissionGrant } from '../modules/permission-grant.js';
import { PermissionsModule } from '../modules/permissions.js';
import { queryModuleConfigure } from './module-configure-lookup.js';
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
  private readonly coreModules?: CoreModuleRegistry;

  public constructor(input: {
    messageStore: MessageStore;
    dataStore: DataStore;
    coreModules?: CoreModuleRegistry;
  }) {
    this.messageStore = input.messageStore;
    this.dataStore = input.dataStore;
    this.coreModules = input.coreModules;
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
      // eg. check the immediate parent in `verifyModulePathAndContextId` at the time of writing,
      // so if this condition is triggered, it means there is an unexpected bug that caused an incomplete chain.
      // We add additional defensive check here because returning an unexpected/incorrect record chain could lead to security vulnerabilities.
      if (initialWrite === undefined) {
        throw new DwnError(
          DwnErrorCode.ModuleAuthorizationParentNotFoundConstructingRecordChain,
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
    parentModuleUri: string;
    parentId: string;
  }): Promise<RecordsWriteMessage | undefined> {
    const { tenant, parentModuleUri, parentId } = input;

    const initialWrite = await fetchInitialRecordsWriteMessage(this.messageStore, tenant, parentId);
    if (initialWrite?.descriptor.module !== parentModuleUri) {
      return undefined;
    }

    if (await this.recordHasPruneTombstone(tenant, parentId)) {
      return undefined;
    }

    return initialWrite;
  }

  /** @inheritdoc */
  public async isRecordPruned(tenant: string, recordId: string): Promise<boolean> {
    return this.recordHasPruneTombstone(tenant, recordId);
  }

  /** @inheritdoc */
  public async hasMatchingRoleRecord(input: {
    tenant: string;
    module: string;
    modulePath: string;
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
    module: string;
    modulePath: string;
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
    module: string;
    rolePath: string;
    contextId: string;
    keyId?: string;
  }): Promise<RecordsWriteMessage[]> {
    const filter: Filter = {
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      module            : input.module,
      modulePath        : ENCRYPTION_CONTROL_AUDIENCE_PATH,
      'tag.module'      : input.module,
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
      (possibleGrantMessage as RecordsWriteMessage).descriptor.modulePath !== PermissionsModule.grantPath) {
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
    const query = PermissionsModule.grantRevocationFilter(permissionGrantId);
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
  public async fetchModuleDefinition(tenant: string, moduleUri: string, messageTimestamp?: string): Promise<ModuleDefinition> {
    // if the module is a registered core module, return the definition directly without a store query
    if (this.coreModules !== undefined) {
      const coreDefinition = this.coreModules.getDefinition(moduleUri);
      if (coreDefinition !== undefined) {
        return coreDefinition;
      }
    }

    // fetch the corresponding module definition
    const moduleMessage = await queryModuleConfigure(this.messageStore, tenant, moduleUri, messageTimestamp);
    if (moduleMessage === undefined) {
      throw new DwnError(DwnErrorCode.ModuleAuthorizationModuleNotFound, `unable to find module definition for ${moduleUri}`);
    }

    return moduleMessage.descriptor.definition;
  }

  /** @inheritdoc */
  public async fetchLatestSquashRecordAtScope(input: {
    tenant: string;
    module: string;
    modulePath: string;
    contextIdPrefix?: string;
  }): Promise<RecordsWriteMessage | undefined> {
    const filter: Filter = {
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      module            : input.module,
      modulePath        : input.modulePath,
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
   * Role revocation remains current-state, including soft deletes.
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

  /** Checks whether prune has removed a record's structural ancestry. */
  private async recordHasPruneTombstone(tenant: string, recordId: string): Promise<boolean> {
    const { messages } = await this.messageStore.query(tenant, [{
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Delete,
      recordId,
      prune     : true,
    }]);
    return messages.length > 0;
  }

  /**
   * Constructs the role-record selector filter shared by the invoked-role lookup and the
   * duplicate-role-recipient uniqueness check.
   */
  private static constructRoleRecordFilter(input: {
    module: string;
    modulePath: string;
    recipient: string;
    contextIdPrefix?: string;
    latestStateOnly: boolean;
  }): Filter {
    const filter: Filter = {
      interface  : DwnInterfaceName.Records,
      method     : DwnMethodName.Write,
      module     : input.module,
      modulePath : input.modulePath,
      recipient  : input.recipient,
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
