import type { Filter } from '../types/query-types.js';
import type { GenericMessage } from '../types/message-types.js';
import type { HandlerDependencies } from '../types/method-handler.js';
import type { ModulesConfigureMessage } from '../types/modules-types.js';
import type { ResolvedModuleGraph } from './module-graph.js';
import type { ResolvedModuleRole } from './module-authorization-action.js';
import type { RoleRecordIdentity } from '../utils/modules.js';
import type { RecordsDeleteMessage, RecordsReadReplicationSupportEntry, RecordsWriteMessage } from '../types/records-types.js';

import { ENCRYPTION_CONTROL_DELIVERY_PATH } from './constants.js';
import { EncryptionControl } from './encryption-control.js';
import { loadModuleGraph } from './module-graph-loader.js';
import { Message } from './message.js';
import { Messages } from '../utils/messages.js';
import { queryModuleConfigure } from './module-configure-lookup.js';
import { Records } from '../utils/records.js';
import { RecordsDelete } from '../interfaces/records-delete.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { resolveModuleGraph } from './module-graph.js';
import { ROLE_AUDIENCE_DERIVATION_SCHEME } from '../utils/encryption.js';
import { SortDirection } from '../types/query-types.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { getRecordsWriteRoleIdentity, getRoleAudienceContextId, getRoleRecordIdentity } from '../utils/modules.js';

const MAX_SUPPORT_RECORDS_PER_KIND = 16;
const MAX_SUPPORT_MODULE_CONFIGS = 64;

type AuthorRoleSelector = RoleRecordIdentity;

/** Builds the bounded, server-proven closure used to seed a nested role-holder replica. */
export class RecordsReadReplicationSupport {
  public static async build(input: {
    deps: HandlerDependencies;
    matchedRecordsWrite: RecordsWriteMessage;
    recordsDelete?: RecordsDeleteMessage;
    requester: string;
    resolvedRole: ResolvedModuleRole;
    tenant: string;
  }): Promise<RecordsReadReplicationSupportEntry[]> {
    const { deps, matchedRecordsWrite, requester, resolvedRole, tenant } = input;
    const module = matchedRecordsWrite.descriptor.module;
    const contextId = resolvedRole.contextIdPrefix;
    const roleRecordId = resolvedRole.roleRecordId;

    if (contextId === undefined || roleRecordId === undefined) {
      throw RecordsReadReplicationSupport.unsupported(
        'replication support requires a context-scoped role with a concrete active assignment.'
      );
    }
    const graph = await loadModuleGraph(tenant, module, deps.validationStateReader, matchedRecordsWrite.descriptor.messageTimestamp);

    const [recordChain, roleRecord, audienceRecords] = await Promise.all([
      deps.validationStateReader.constructRecordChain(tenant, matchedRecordsWrite.recordId),
      RecordsReadReplicationSupport.fetchRoleRecord(deps, tenant, roleRecordId),
      RecordsReadReplicationSupport.fetchAudienceRecords({
        deps,
        includeCurrentRoleAudience : input.recordsDelete === undefined,
        matchedRecordsWrite,
        contextId,
        graph,
        module                     : resolvedRole.module,
        rolePath                   : resolvedRole.modulePath,
        tenant,
      }),
    ]);
    const node = graph.nodesByDeclaredPath.get(matchedRecordsWrite.descriptor.modulePath);
    if (node?.kind !== 'record') {
      throw RecordsReadReplicationSupport.unsupported('the matched record has no concrete module path.');
    }
    const expectedChain = [...node.physicalAncestors, node];
    if (recordChain.length !== expectedChain.length || recordChain.some((record, index): boolean =>
      record.descriptor.module !== expectedChain[index].owningModuleUri ||
      record.descriptor.modulePath !== expectedChain[index].owningModulePath)) {
      throw RecordsReadReplicationSupport.unsupported('record ancestry does not match the resolved module graph.');
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

      const audienceModule = audienceRecord.descriptor.module;
      const delivery = input.recordsDelete === undefined && audienceModule === resolvedRole.module &&
        rolePath === resolvedRole.modulePath && audienceContextId === contextId
        ? await RecordsReadReplicationSupport.fetchDelivery({
          deps,
          tenant,
          requester,
          module    : audienceModule,
          rolePath,
          contextId : audienceContextId,
          keyId,
        })
        : undefined;
      return { audienceRecord, delivery };
    }));
    const moduleConfigures = await RecordsReadReplicationSupport.fetchModuleConfigures(
      deps,
      tenant,
      module,
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
    for (const moduleConfigure of moduleConfigures) {
      await RecordsReadReplicationSupport.append(
        entries,
        moduleConfigure.message,
        moduleConfigure.isLatestBaseState,
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
    resolvedRole: ResolvedModuleRole;
    tenant: string;
  }, recordChain: readonly RecordsWriteMessage[]): Promise<RecordsWriteMessage[]> {
    const { deps, matchedRecordsWrite, recordsDelete, requester, resolvedRole, tenant } = input;
    const selectors = new Map<string, AuthorRoleSelector>();
    const graphs = new Map<string, Promise<ResolvedModuleGraph>>();
    const addSelector = async (
      moduleRole: string | undefined,
      recipient: string | undefined,
      contextId: string | undefined,
      module: string,
      messageTimestamp: string,
    ): Promise<void> => {
      if (moduleRole === undefined) {
        return;
      }
      if (recipient === undefined) {
        throw RecordsReadReplicationSupport.unsupported('role-authored record has no logical author.');
      }
      const graphKey = JSON.stringify([module, messageTimestamp]);
      let loading = graphs.get(graphKey);
      if (loading === undefined) {
        loading = loadModuleGraph(tenant, module, deps.validationStateReader, messageTimestamp);
        graphs.set(graphKey, loading);
      }
      const role = (await loading).resolveInvokedRole(moduleRole);
      const identity = getRoleRecordIdentity({ contextId, role, recipient });
      if (identity.contextIdPrefix === undefined && role.parentPhysicalDepth > 0) {
        throw RecordsReadReplicationSupport.unsupported(`record author role '${moduleRole}' has no context.`);
      }
      if (recipient === requester &&
        resolvedRole.module === role.owningModuleUri &&
        resolvedRole.modulePath === role.owningModulePath &&
        resolvedRole.contextIdPrefix === identity.contextIdPrefix) {
        return;
      }
      selectors.set(identity.key, identity);
    };

    for (const record of [matchedRecordsWrite, ...recordChain]) {
      const parsed = await RecordsWrite.parse(record);
      await addSelector( // NOSONAR: S9382 — retain proof order while resolving each governing snapshot.
        parsed.signaturePayload?.moduleRole,
        parsed.author,
        record.contextId,
        record.descriptor.module,
        record.descriptor.messageTimestamp,
      );
    }
    if (recordsDelete !== undefined) {
      const parsed = await RecordsDelete.parse(recordsDelete);
      await addSelector(
        parsed.signaturePayload?.moduleRole,
        parsed.author,
        matchedRecordsWrite.contextId,
        matchedRecordsWrite.descriptor.module,
        recordsDelete.descriptor.messageTimestamp,
      );
    }

    for (const ancestor of recordChain) {
      const identity = getRecordsWriteRoleIdentity(ancestor);
      if (identity !== undefined) {
        selectors.delete(identity.key);
      }
    }

    return Promise.all([...selectors.values()].map(async (selector): Promise<RecordsWriteMessage> => {
      const initialWrite = await RecordsReadReplicationSupport.fetchAuthorRoleInitialWrite(
        deps,
        tenant,
        selector,
      );
      if (initialWrite === undefined) {
        throw RecordsReadReplicationSupport.unsupported(
          `record author role '${selector.modulePath}' is unavailable for replication.`,
        );
      }
      return initialWrite;
    }));
  }

  private static async fetchAuthorRoleInitialWrite(
    deps: HandlerDependencies,
    tenant: string,
    selector: AuthorRoleSelector,
  ): Promise<RecordsWriteMessage | undefined> {
    const filter: Filter = {
      interface  : DwnInterfaceName.Records,
      method     : DwnMethodName.Write,
      module     : selector.module,
      modulePath : selector.modulePath,
      recipient  : selector.recipient,
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
      if (!Records.isRecordsWrite(message) || !await RecordsWrite.isInitialWrite(message)) {
        continue;
      }
      const candidate = getRecordsWriteRoleIdentity(message);
      if (candidate === undefined) {
        continue;
      }
      // Root roles intentionally match by module, path, and recipient only;
      // unlike nested roles, they have no context dimension.
      if (candidate.key === selector.key) {
        return message;
      }
    }
    return undefined;
  }

  private static async fetchAudienceRecords(input: {
    deps: HandlerDependencies;
    includeCurrentRoleAudience: boolean;
    matchedRecordsWrite: RecordsWriteMessage;
    graph: ResolvedModuleGraph;
    tenant: string;
    module: string;
    rolePath: string;
    contextId: string;
  }): Promise<RecordsWriteMessage[]> {
    const rootAudienceEntries = input.matchedRecordsWrite.encryption?.keyEncryption
      .filter((entry): boolean => entry.derivationScheme === ROLE_AUDIENCE_DERIVATION_SCHEME &&
        'module' in entry && input.graph.definitionsByUri.has(entry.module)) ?? [];
    if (input.includeCurrentRoleAudience && input.matchedRecordsWrite.encryption !== undefined &&
      !rootAudienceEntries.some((entry): boolean => 'rolePath' in entry && entry.module === input.module && entry.rolePath === input.rolePath)) {
      throw RecordsReadReplicationSupport.unsupported('the encrypted record is not wrapped for the invoked role.');
    }

    const current = input.includeCurrentRoleAudience
      ? await EncryptionControl.resolveCurrentAudienceRecord({
        contextId    : input.contextId,
        messageStore : input.deps.messageStore,
        module       : input.module,
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
      const providerDefinition = input.graph.definitionsByUri.get(entry.module)!;
      const providerGraph = resolveModuleGraph(providerDefinition, uri => input.graph.definitionsByUri.get(uri));
      const role = providerGraph.resolveInvokedRole(entry.rolePath);
      const audienceContextId = getRoleAudienceContextId(role, input.matchedRecordsWrite.contextId);
      if (audienceContextId === undefined) {
        throw RecordsReadReplicationSupport.unsupported(
          `the encrypted record has no audience context for role '${entry.rolePath}'.`
        );
      }
      const reference = JSON.stringify([entry.module, entry.rolePath, audienceContextId, entry.keyId]);
      if (queried.has(reference)) {
        continue;
      }
      queried.add(reference);
      const exact = await input.deps.validationStateReader.queryAudienceRecords({
        contextId : audienceContextId,
        keyId     : entry.keyId,
        module    : entry.module,
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

  private static async fetchModuleConfigures(
    deps: HandlerDependencies,
    tenant: string,
    module: string,
    records: readonly { descriptor: { messageTimestamp: string; module?: string } }[],
  ): Promise<{ isLatestBaseState: boolean; message: ModulesConfigureMessage }[]> {
    const unique = new Map<string, ModulesConfigureMessage>();
    const latestCids = new Set<string>();
    const visited = new Set<string>();
    const collect = async (uri: string, timestamp?: string): Promise<void> => {
      const key = JSON.stringify([uri, timestamp]);
      if (visited.has(key) || deps.coreModules?.getDefinition(uri) !== undefined) {
        return;
      }
      visited.add(key);
      const message = await RecordsReadReplicationSupport.fetchModuleConfigure(deps, tenant, uri, timestamp);
      const cid = await Message.getCid(message);
      unique.set(cid, message);
      if (timestamp === undefined) {
        latestCids.add(cid);
      }
      if (unique.size > MAX_SUPPORT_MODULE_CONFIGS) {
        throw RecordsReadReplicationSupport.unsupported(
          `replication support requires more than ${MAX_SUPPORT_MODULE_CONFIGS} module configurations.`
        );
      }
      for (const dependency of Object.values(message.descriptor.definition.uses ?? {})) {
        await collect(dependency, timestamp); // NOSONAR: S9382 — enforce the closure bound before loading the next dependency.
      }
      if (timestamp !== undefined) {
        await collect(uri);
      }
    };
    await collect(module);
    for (const record of records) {
      await collect( // NOSONAR: S9382 — bound history reads and retain per-record proof order.
        record.descriptor.module ?? module, record.descriptor.messageTimestamp,
      );
    }
    return [...unique].map(([cid, message]) => ({ isLatestBaseState: latestCids.has(cid), message }));
  }

  private static async fetchModuleConfigure(
    deps: HandlerDependencies,
    tenant: string,
    module: string,
    messageTimestamp?: string,
  ): Promise<ModulesConfigureMessage> {
    const moduleConfigure = await queryModuleConfigure(deps.messageStore, tenant, module, messageTimestamp);
    if (moduleConfigure === undefined) {
      throw RecordsReadReplicationSupport.unsupported(`no stored module configuration exists for '${module}'.`);
    }
    return moduleConfigure;
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
    module: string;
    rolePath: string;
    contextId: string;
    keyId: string;
  }): Promise<RecordsWriteMessage | undefined> {
    const { messages } = await input.deps.messageStore.query(input.tenant, [{
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
      module            : input.module,
      modulePath        : ENCRYPTION_CONTROL_DELIVERY_PATH,
      recipient         : input.requester,
      'tag.module'      : input.module,
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
