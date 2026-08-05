import type { Filter } from '../types/query-types.js';
import type { GenericMessage } from '../types/message-types.js';
import type { HandlerDependencies } from '../types/method-handler.js';
import type { ProtocolsConfigureMessage } from '../types/protocols-types.js';
import type { ResolvedProtocolRole } from './protocol-authorization-action.js';
import type { RecordsDeleteMessage, RecordsReadReplicationSupportEntry, RecordsWriteMessage } from '../types/records-types.js';

import { ENCRYPTION_CONTROL_DELIVERY_PATH } from './constants.js';
import { EncryptionControl } from './encryption-control.js';
import { lexicographicalCompare } from '../utils/string.js';
import { Message } from './message.js';
import { Messages } from '../utils/messages.js';
import { Records } from '../utils/records.js';
import { RecordsDelete } from '../interfaces/records-delete.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { ROLE_AUDIENCE_DERIVATION_SCHEME } from '../utils/encryption.js';
import { SortDirection } from '../types/query-types.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRoleAudienceContextId, getRoleContextPrefix, getRuleSetAtPath, isCrossProtocolRef } from '../utils/protocols.js';

const MAX_SUPPORT_RECORDS_PER_KIND = 16;
const MAX_SUPPORT_PROTOCOL_CONFIGS = 64;

type AuthorRoleSelector = {
  contextIdPrefix: string | undefined;
  protocolPath: string;
  recipient: string;
};

/** Builds the bounded, server-proven closure used to seed a nested role-holder replica. */
export class RecordsReadReplicationSupport {
  public static async build(input: {
    deps: HandlerDependencies;
    matchedRecordsWrite: RecordsWriteMessage;
    recordsDelete?: RecordsDeleteMessage;
    requester: string;
    resolvedRole: ResolvedProtocolRole;
    tenant: string;
  }): Promise<RecordsReadReplicationSupportEntry[]> {
    const { deps, matchedRecordsWrite, requester, resolvedRole, tenant } = input;
    const protocol = matchedRecordsWrite.descriptor.protocol;
    const contextId = resolvedRole.contextIdPrefix;
    const roleRecordId = resolvedRole.roleRecordId;

    if (resolvedRole.protocol !== protocol || contextId === undefined || roleRecordId === undefined) {
      throw RecordsReadReplicationSupport.unsupported(
        'replication support requires a context-scoped role in the record protocol with a concrete active assignment.'
      );
    }

    const [recordChain, roleRecord, audienceRecords] = await Promise.all([
      deps.validationStateReader.constructRecordChain(tenant, matchedRecordsWrite.recordId),
      RecordsReadReplicationSupport.fetchRoleRecord(deps, tenant, roleRecordId),
      RecordsReadReplicationSupport.fetchAudienceRecords({
        deps,
        includeCurrentRoleAudience : input.recordsDelete === undefined,
        matchedRecordsWrite,
        contextId,
        protocol,
        rolePath                   : resolvedRole.protocolPath,
        tenant,
      }),
    ]);
    if (recordChain.some((record): boolean => record.descriptor.protocol !== protocol)) {
      throw RecordsReadReplicationSupport.unsupported('cross-protocol record ancestry is not supported by this bootstrap response.');
    }
    const authorRoleInitialWrites = await RecordsReadReplicationSupport.fetchAuthorRoleInitialWrites(
      input,
      recordChain,
    );

    const roleInitialWrite = await RecordsReadReplicationSupport.initialWrite(deps, tenant, roleRecord);
    const audienceDependencies = await Promise.all(audienceRecords.map(async (audienceRecord) => {
      const { contextId: audienceContextId, keyId, rolePath } = audienceRecord.descriptor.tags ?? {};
      if (typeof audienceContextId !== 'string' || typeof keyId !== 'string' || typeof rolePath !== 'string') {
        throw RecordsReadReplicationSupport.unsupported('the current audience record has incomplete role-audience tags.');
      }

      const delivery = input.recordsDelete === undefined &&
        rolePath === resolvedRole.protocolPath && audienceContextId === contextId
        ? await RecordsReadReplicationSupport.fetchDelivery({
          deps,
          tenant,
          requester,
          protocol,
          rolePath,
          contextId: audienceContextId,
          keyId,
        })
        : undefined;
      return { audienceRecord, delivery };
    }));
    const protocolConfigures = await RecordsReadReplicationSupport.fetchProtocolConfigures(
      deps,
      tenant,
      protocol,
      [
        matchedRecordsWrite,
        ...(input.recordsDelete === undefined ? [] : [input.recordsDelete]),
        ...recordChain,
        roleRecord,
        ...(roleInitialWrite === undefined ? [] : [roleInitialWrite]),
        ...authorRoleInitialWrites,
        ...audienceDependencies.flatMap(({ audienceRecord, delivery }) =>
          delivery === undefined ? [audienceRecord] : [audienceRecord, delivery]),
      ],
    );

    const entries: RecordsReadReplicationSupportEntry[] = [];
    for (const protocolConfigure of protocolConfigures) {
      await RecordsReadReplicationSupport.append(
        entries,
        protocolConfigure.message,
        protocolConfigure.isLatestBaseState,
        true,
      );
    }

    for (const ancestor of recordChain) {
      if (ancestor.recordId !== matchedRecordsWrite.recordId) {
        await RecordsReadReplicationSupport.append(entries, ancestor, false, false);
      }
    }

    if (roleInitialWrite !== undefined) {
      await RecordsReadReplicationSupport.append(entries, roleInitialWrite, false, false);
    }
    await RecordsReadReplicationSupport.append(entries, roleRecord, true, true);
    for (const authorRoleInitialWrite of authorRoleInitialWrites) {
      await RecordsReadReplicationSupport.append(entries, authorRoleInitialWrite, false, false);
    }

    for (const { audienceRecord, delivery } of audienceDependencies) {
      await RecordsReadReplicationSupport.append(entries, audienceRecord, true, true);
      if (delivery !== undefined) {
        await RecordsReadReplicationSupport.append(entries, delivery, true, true);
      }
    }

    return entries;
  }

  /** Returns the ancestry-only role proofs needed by every record write in the replay closure. */
  private static async fetchAuthorRoleInitialWrites(input: {
    deps: HandlerDependencies;
    matchedRecordsWrite: RecordsWriteMessage;
    recordsDelete?: RecordsDeleteMessage;
    requester: string;
    resolvedRole: ResolvedProtocolRole;
    tenant: string;
  }, recordChain: readonly RecordsWriteMessage[]): Promise<RecordsWriteMessage[]> {
    const { deps, matchedRecordsWrite, recordsDelete, requester, resolvedRole, tenant } = input;
    const protocol = matchedRecordsWrite.descriptor.protocol;
    const selectors = new Map<string, AuthorRoleSelector>();
    const addSelector = async (
      protocolRole: string | undefined,
      recipient: string | undefined,
      contextId: string | undefined,
      messageTimestamp: string,
    ): Promise<void> => {
      if (protocolRole === undefined) {
        return;
      }
      if (isCrossProtocolRef(protocolRole)) {
        throw RecordsReadReplicationSupport.unsupported('cross-protocol author role proofs are not supported.');
      }
      const definition = await deps.validationStateReader.fetchProtocolDefinition(
        tenant,
        protocol,
        messageTimestamp,
      );
      if (getRuleSetAtPath(protocolRole, definition.structure)?.$role !== true) {
        throw RecordsReadReplicationSupport.unsupported(`record author invoked non-role path '${protocolRole}'.`);
      }
      if (recipient === undefined) {
        throw RecordsReadReplicationSupport.unsupported('role-authored record has no logical author.');
      }
      const contextIdPrefix = getRoleContextPrefix(protocolRole, contextId);
      if (contextIdPrefix === undefined && protocolRole.includes('/')) {
        throw RecordsReadReplicationSupport.unsupported(`record author role '${protocolRole}' has no context.`);
      }
      if (recipient === requester &&
        resolvedRole.protocol === protocol &&
        resolvedRole.protocolPath === protocolRole &&
        resolvedRole.contextIdPrefix === contextIdPrefix) {
        return;
      }
      selectors.set(JSON.stringify([protocolRole, recipient, contextIdPrefix]), {
        contextIdPrefix,
        protocolPath: protocolRole,
        recipient,
      });
    };

    for (const record of [matchedRecordsWrite, ...recordChain]) {
      const parsed = await RecordsWrite.parse(record);
      await addSelector(
        parsed.signaturePayload?.protocolRole,
        parsed.author,
        record.contextId,
        record.descriptor.messageTimestamp,
      );
    }
    if (recordsDelete !== undefined) {
      const parsed = await RecordsDelete.parse(recordsDelete);
      await addSelector(
        parsed.signaturePayload?.protocolRole,
        parsed.author,
        matchedRecordsWrite.contextId,
        recordsDelete.descriptor.messageTimestamp,
      );
    }

    return Promise.all([...selectors.values()].map(async (selector): Promise<RecordsWriteMessage> => {
      const initialWrite = await RecordsReadReplicationSupport.fetchAuthorRoleInitialWrite(
        deps,
        tenant,
        protocol,
        selector,
      );
      if (initialWrite === undefined) {
        throw RecordsReadReplicationSupport.unsupported(
          `record author role '${selector.protocolPath}' is unavailable for replication.`,
        );
      }
      return initialWrite;
    }));
  }

  private static async fetchAuthorRoleInitialWrite(
    deps: HandlerDependencies,
    tenant: string,
    protocol: string,
    selector: AuthorRoleSelector,
  ): Promise<RecordsWriteMessage | undefined> {
    const filter: Filter = {
      interface    : DwnInterfaceName.Records,
      method       : DwnMethodName.Write,
      protocol,
      protocolPath : selector.protocolPath,
      recipient    : selector.recipient,
    };
    if (selector.contextIdPrefix !== undefined) {
      filter.contextId = { subtree: selector.contextIdPrefix };
    }
    const { messages } = await deps.messageStore.query(
      tenant,
      [filter],
      { messageTimestamp: SortDirection.Descending },
    );
    for (const message of messages) {
      if (Records.isRecordsWrite(message) && await RecordsWrite.isInitialWrite(message) &&
        Records.getParentContextFromOfContextId(message.contextId) === selector.contextIdPrefix) {
        return message;
      }
    }
    return undefined;
  }

  private static async fetchAudienceRecords(input: {
    deps: HandlerDependencies;
    includeCurrentRoleAudience: boolean;
    matchedRecordsWrite: RecordsWriteMessage;
    tenant: string;
    protocol: string;
    rolePath: string;
    contextId: string;
  }): Promise<RecordsWriteMessage[]> {
    const rootAudienceEntries = input.matchedRecordsWrite.encryption?.keyEncryption
      .filter((entry): boolean => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
        'protocol' in entry && entry.protocol === input.protocol) ?? [];
    if (input.includeCurrentRoleAudience && input.matchedRecordsWrite.encryption !== undefined &&
      !rootAudienceEntries.some((entry): boolean => 'rolePath' in entry && entry.rolePath === input.rolePath)) {
      throw RecordsReadReplicationSupport.unsupported('the encrypted record is not wrapped for the invoked role.');
    }

    const current = input.includeCurrentRoleAudience
      ? await EncryptionControl.resolveCurrentAudienceRecord({
        contextId    : input.contextId,
        messageStore : input.deps.messageStore,
        protocol     : input.protocol,
        rolePath     : input.rolePath,
        tenant       : input.tenant,
      })
      : undefined;
    const records = current === undefined ? [] : [current];
    const seen = new Set(records.map((record): string => record.recordId));
    const queried = new Set<string>();
    for (const entry of rootAudienceEntries) {
      if (!('rolePath' in entry)) {
        continue;
      }
      const audienceContextId = getRoleAudienceContextId(
        entry.rolePath,
        input.matchedRecordsWrite.contextId,
      );
      if (audienceContextId === undefined) {
        throw RecordsReadReplicationSupport.unsupported(
          `the encrypted record has no audience context for role '${entry.rolePath}'.`
        );
      }
      const reference = JSON.stringify([entry.rolePath, audienceContextId, entry.keyId]);
      if (queried.has(reference)) {
        continue;
      }
      queried.add(reference);
      const exact = await input.deps.validationStateReader.queryAudienceRecords({
        contextId : audienceContextId,
        keyId     : entry.keyId,
        protocol  : input.protocol,
        rolePath  : entry.rolePath,
        tenant    : input.tenant,
      });
      const record = exact[0];
      if (record !== undefined && !seen.has(record.recordId)) {
        records.push(record);
        seen.add(record.recordId);
      }
    }

    if (records.length > MAX_SUPPORT_RECORDS_PER_KIND) {
      throw RecordsReadReplicationSupport.unsupported(
        `replication support requires more than ${MAX_SUPPORT_RECORDS_PER_KIND} audience records.`
      );
    }
    return records;
  }

  private static async fetchProtocolConfigures(
    deps: HandlerDependencies,
    tenant: string,
    protocol: string,
    records: readonly { descriptor: { messageTimestamp: string } }[],
  ): Promise<{ isLatestBaseState: boolean; message: ProtocolsConfigureMessage }[]> {
    const latest = await RecordsReadReplicationSupport.fetchProtocolConfigure(deps, tenant, protocol);
    const timestamps = [...new Set(records.map((record): string => record.descriptor.messageTimestamp))]
      .sort(lexicographicalCompare);
    const historical = await Promise.all(timestamps.map((messageTimestamp) =>
      RecordsReadReplicationSupport.fetchProtocolConfigure(deps, tenant, protocol, messageTimestamp)));
    const latestCid = await Message.getCid(latest);
    const unique = new Map<string, ProtocolsConfigureMessage>();
    for (const configure of [...historical, latest]) {
      unique.set(await Message.getCid(configure), configure);
    }
    if (unique.size > MAX_SUPPORT_PROTOCOL_CONFIGS) {
      throw RecordsReadReplicationSupport.unsupported(
        `replication support requires more than ${MAX_SUPPORT_PROTOCOL_CONFIGS} protocol configurations.`
      );
    }

    return [...unique].map(([cid, message]) => ({
      isLatestBaseState: cid === latestCid,
      message,
    }));
  }

  private static async fetchProtocolConfigure(
    deps: HandlerDependencies,
    tenant: string,
    protocol: string,
    messageTimestamp?: string,
  ): Promise<ProtocolsConfigureMessage> {
    const filter = {
      interface : DwnInterfaceName.Protocols,
      method    : DwnMethodName.Configure,
      protocol,
      ...(messageTimestamp === undefined
        ? { isLatestBaseState: true }
        : { messageTimestamp: { lte: messageTimestamp } }),
    };
    let { messages } = await deps.messageStore.query(
      tenant,
      [filter],
      messageTimestamp === undefined ? undefined : { messageTimestamp: SortDirection.Descending },
      { limit: 1 },
    );
    if (messages.length === 0 && messageTimestamp !== undefined) {
      ({ messages } = await deps.messageStore.query(tenant, [{
        interface : DwnInterfaceName.Protocols,
        method    : DwnMethodName.Configure,
        protocol,
      }], { messageTimestamp: SortDirection.Ascending }, { limit: 1 }));
    }

    const protocolConfigure = messages[0] as ProtocolsConfigureMessage | undefined;
    if (protocolConfigure === undefined) {
      throw RecordsReadReplicationSupport.unsupported(`no stored protocol configuration exists for '${protocol}'.`);
    }
    return protocolConfigure;
  }

  private static async fetchRoleRecord(
    deps: HandlerDependencies,
    tenant: string,
    roleRecordId: string,
  ): Promise<RecordsWriteMessage> {
    const { messages } = await deps.messageStore.query(tenant, [{
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      recordId          : roleRecordId,
      isLatestBaseState : true,
    }], undefined, { limit: 1 });
    const roleRecord = messages[0];
    if (roleRecord === undefined || !Records.isRecordsWrite(roleRecord)) {
      throw RecordsReadReplicationSupport.unsupported(`active role record '${roleRecordId}' is unavailable.`);
    }
    return roleRecord;
  }

  private static async fetchDelivery(input: {
    deps: HandlerDependencies;
    tenant: string;
    requester: string;
    protocol: string;
    rolePath: string;
    contextId: string;
    keyId: string;
  }): Promise<RecordsWriteMessage | undefined> {
    const { messages } = await input.deps.messageStore.query(input.tenant, [{
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      protocol          : input.protocol,
      protocolPath      : ENCRYPTION_CONTROL_DELIVERY_PATH,
      recipient         : input.requester,
      'tag.protocol'    : input.protocol,
      'tag.rolePath'    : input.rolePath,
      'tag.contextId'   : input.contextId,
      'tag.keyId'       : input.keyId,
    }], { dateCreated: SortDirection.Descending }, { limit: 1 });
    return messages.find(Records.isRecordsWrite);
  }

  private static async initialWrite(
    deps: HandlerDependencies,
    tenant: string,
    record: RecordsWriteMessage,
  ): Promise<RecordsWriteMessage | undefined> {
    if (await RecordsWrite.isInitialWrite(record)) {
      return undefined;
    }
    return deps.validationStateReader.fetchInitialWrite(tenant, record.recordId);
  }

  private static async append(
    entries: RecordsReadReplicationSupportEntry[],
    storedMessage: GenericMessage,
    isLatestBaseState: boolean,
    includeData: boolean,
  ): Promise<void> {
    const { message, encodedData } = Messages.detachEncodedData(storedMessage);
    if (includeData && Records.isRecordsWrite(storedMessage) && encodedData === undefined) {
      throw RecordsReadReplicationSupport.unsupported(
        `support record '${storedMessage.recordId}' is too large to include inline.`
      );
    }

    entries.push({
      isLatestBaseState,
      message,
      encodedData: includeData ? encodedData : undefined,
    });
  }

  private static unsupported(detail: string): DwnError {
    return new DwnError(DwnErrorCode.RecordsReadReplicationSupportUnsupported, detail);
  }
}
