import type { CoreProtocol } from './core/core-protocol.js';
import type { DataStore } from './types/data-store.js';
import type { DidResolver } from '@enbox/dids';
import type { MessageStore } from './types/message-store.js';
import type { ResumableTaskStore } from './types/resumable-task-store.js';
import type { TenantGate } from './core/tenant-gate.js';
import type { UnionMessageReply } from './core/message-reply.js';
import type { ValidationStateReader } from './types/validation-state-reader.js';
import type { EventLog, SubscriptionListener } from './types/subscriptions.js';
import type { GenericMessage, GenericMessageReply } from './types/message-types.js';
import type { HandlerDependencies, MethodHandler } from './types/method-handler.js';
import type {
  MessagesQueryMessage,
  MessagesQueryReply,
  MessagesReadMessage,
  MessagesReadReply,
  MessagesSubscribeMessage,
  MessagesSubscribeMessageOptions,
  MessagesSubscribeReply,
} from './types/messages-types.js';
import type { ProtocolDefinition, ProtocolsConfigureMessage, ProtocolsQueryMessage, ProtocolsQueryReply } from './types/protocols-types.js';
import type {
  RecordsCountMessage,
  RecordsCountReply,
  RecordsDeleteMessage,
  RecordsQueryMessage,
  RecordsQueryReply,
  RecordsQueryReplyEntry,
  RecordsReadMessage,
  RecordsReadReply,
  RecordsSubscribeMessage,
  RecordsSubscribeMessageOptions,
  RecordsSubscribeReply,
  RecordsWriteMessage,
  RecordsWriteMessageOptions
} from './types/records-types.js';
import type { ReplicationApplyOptions, ReplicationApplyResult } from './core/replication-apply.js';

import { AllowAllTenantGate } from './core/tenant-gate.js';
import { Cid } from './utils/cid.js';
import { CoreProtocolRegistry } from './core/core-protocol.js';
import { DataStream } from './utils/data-stream.js';
import { DwnConstant } from './core/dwn-constant.js';
import { EncryptionProtocol } from './protocols/encryption.js';
import { findMissingRoleAudienceEncryptionContext } from './core/protocol-authorization-validation.js';
import { Message } from './core/message.js';
import { messageReplyFromError } from './core/message-reply.js';
import { MessagesQueryHandler } from './handlers/messages-query.js';
import { MessagesReadHandler } from './handlers/messages-read.js';
import { MessagesSubscribeHandler } from './handlers/messages-subscribe.js';
import { PermissionsProtocol } from './protocols/permissions.js';
import { ProtocolsConfigureHandler } from './handlers/protocols-configure.js';
import { ProtocolsQueryHandler } from './handlers/protocols-query.js';
import { Records } from './utils/records.js';
import { RecordsCountHandler } from './handlers/records-count.js';
import { RecordsDelete } from './interfaces/records-delete.js';
import { RecordsDeleteHandler } from './handlers/records-delete.js';
import { RecordsQueryHandler } from './handlers/records-query.js';
import { RecordsReadHandler } from './handlers/records-read.js';
import { RecordsSubscribeHandler } from './handlers/records-subscribe.js';
import { RecordsWrite } from './interfaces/records-write.js';
import { RecordsWriteHandler } from './handlers/records-write.js';
import { ResumableTaskManager } from './core/resumable-task-manager.js';
import { StorageController } from './store/storage-controller.js';
import { StoreValidationStateReader } from './core/validation-state-reader.js';
import { DidDht, DidJwk, DidKey, DidResolverCacheMemory, DidWeb, UniversalResolver } from '@enbox/dids';
import { DwnError, DwnErrorCode } from './core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from './enums/dwn-interface-method.js';
import { missingAncestorRecordIdsFromReply, replicationApplyResultFromReply } from './core/replication-apply.js';

/**
 * Structural shape for `DidResolver` implementations that expose
 * optional lifecycle hooks (e.g. cache-backed resolvers that need to
 * open/close a store). The base `DidResolver` interface in
 * `@enbox/dids` doesn't declare these methods, so `Dwn.open()` /
 * `Dwn.close()` probe via this narrowly-typed cast (no `any`).
 */
type LifecycleResolver = {
  open: () => Promise<void>;
  close: () => Promise<void>;
};

type ReplicationApplyProtocolDefinitionLookup = {
  protocol: string;
  messageTimestamp?: string;
};

type DwnStorage = {
  dataStore: DataStore;
  messageStore: MessageStore;
  eventLog: EventLog | undefined;
};

export class Dwn {
  private readonly methodHandlers: { [key:string]: MethodHandler };
  private readonly didResolver: DidResolver;
  private readonly messageStore: MessageStore;
  private readonly dataStore: DataStore;
  private readonly resumableTaskStore: ResumableTaskStore;
  private readonly tenantGate: TenantGate;
  private readonly eventLog?: EventLog;
  private readonly storageController: StorageController;
  private readonly resumableTaskManager: ResumableTaskManager;
  private readonly _coreProtocols: CoreProtocolRegistry;
  private readonly validationStateReader: ValidationStateReader;

  /** Whether the DWN owns the resolver's lifecycle (i.e., created it via defaults). */
  private readonly ownsResolver: boolean;

  private constructor(config: DwnConfig) {
    this.didResolver = config.didResolver!;
    this.ownsResolver = config.ownsResolver ?? false;
    this.tenantGate = config.tenantGate!;
    this.messageStore = config.messageStore;
    this.dataStore = config.dataStore;
    this.resumableTaskStore = config.resumableTaskStore;

    // Initialize the core protocol registry with built-in system protocols.
    this._coreProtocols = new CoreProtocolRegistry();
    this._coreProtocols.register(new EncryptionProtocol());
    this._coreProtocols.register(new PermissionsProtocol());

    // The single narrow surface through which validation logic reads state (replay-basis closure).
    const validationStateReader = new StoreValidationStateReader({
      messageStore  : this.messageStore,
      dataStore     : this.dataStore,
      coreProtocols : this._coreProtocols,
    });
    this.validationStateReader = config.instrumentValidationStateReader?.(validationStateReader) ?? validationStateReader;

    this.eventLog = config.eventLog;

    this.storageController = new StorageController({
      messageStore : this.messageStore,
      dataStore    : this.dataStore,
    });
    this.resumableTaskManager = new ResumableTaskManager(
      config.resumableTaskStore,
      this.storageController
    );

    // Build the shared dependency bag once; every handler receives the same object
    // and accesses only the dependencies it needs.
    const deps: HandlerDependencies = {
      didResolver           : this.didResolver,
      messageStore          : this.messageStore,
      validationStateReader : this.validationStateReader,
      dataStore             : this.dataStore,
      resumableTaskManager  : this.resumableTaskManager,
      coreProtocols         : this._coreProtocols,
      eventLog              : this.eventLog,
    };

    this.methodHandlers = {
      [DwnInterfaceName.Messages + DwnMethodName.Read]       : new MessagesReadHandler(deps),
      [DwnInterfaceName.Messages + DwnMethodName.Query]      : new MessagesQueryHandler(deps),
      [DwnInterfaceName.Messages + DwnMethodName.Subscribe]  : new MessagesSubscribeHandler(deps),
      [DwnInterfaceName.Protocols + DwnMethodName.Configure] : new ProtocolsConfigureHandler(deps),
      [DwnInterfaceName.Protocols + DwnMethodName.Query]     : new ProtocolsQueryHandler(deps),
      [DwnInterfaceName.Records + DwnMethodName.Count]       : new RecordsCountHandler(deps),
      [DwnInterfaceName.Records + DwnMethodName.Delete]      : new RecordsDeleteHandler(deps),
      [DwnInterfaceName.Records + DwnMethodName.Query]       : new RecordsQueryHandler(deps),
      [DwnInterfaceName.Records + DwnMethodName.Read]        : new RecordsReadHandler(deps),
      [DwnInterfaceName.Records + DwnMethodName.Subscribe]   : new RecordsSubscribeHandler(deps),
      [DwnInterfaceName.Records + DwnMethodName.Write]       : new RecordsWriteHandler(deps),
    };
  }

  /**
   * Creates an instance of the DWN.
   */
  public static async create(config: DwnConfig): Promise<Dwn> {
    if (!config.didResolver) {
      config.didResolver = new UniversalResolver({
        didResolvers : [ DidDht, DidJwk, DidKey, DidWeb ],
        cache        : new DidResolverCacheMemory(),
      });
      config.ownsResolver = true;
    }
    config.tenantGate ??= new AllowAllTenantGate();

    const dwn = new Dwn(config);
    await dwn.open();
    return dwn;
  }

  /**
   * Initializes the DWN instance and opens the connection to it.
   */
  public async open(): Promise<void> {
    // Open the resolver's cache if the DWN owns it (created via defaults).
    // The base `DidResolver` interface in `@enbox/dids` doesn't declare
    // optional lifecycle hooks; cache-backed implementations expose them
    // structurally. Narrowly-typed probe (no `any`).
    const lifecycleResolver = this.didResolver as Partial<LifecycleResolver>;
    if (this.ownsResolver && typeof lifecycleResolver.open === 'function') {
      await lifecycleResolver.open();
    }

    await this.messageStore.open();
    await this.dataStore.open();
    await this.resumableTaskStore.open();
    await this.eventLog?.open();

    await this.resumableTaskManager.resumeTasksAndWaitForCompletion();
  }

  public async close(): Promise<void> {
    await this.eventLog?.close();
    await this.messageStore.close();
    await this.dataStore.close();
    await this.resumableTaskStore.close();

    // Close the resolver's cache if the DWN owns it.
    const lifecycleResolver = this.didResolver as Partial<LifecycleResolver>;
    if (this.ownsResolver && typeof lifecycleResolver.close === 'function') {
      await lifecycleResolver.close();
    }
  }

  /**
   * The registry of core protocols (hardcoded, immutable, always-installed).
   * Used by handlers and utilities that need to check whether a protocol URI
   * belongs to a core protocol or to dispatch lifecycle hooks.
   */
  public get coreProtocols(): CoreProtocolRegistry {
    return this._coreProtocols;
  }

  /**
   * Returns the internal storage components for advanced operations that
   * cannot be expressed through the standard `processMessage()` pipeline.
   *
   * Callers are responsible for maintaining consistency across stores.
   */
  public get storage(): DwnStorage {
    return {
      dataStore    : this.dataStore,
      messageStore : this.messageStore,
      eventLog     : this.eventLog,
    };
  }

  /**
   * Processes the given DWN message and returns with a reply.
   * @param tenant The tenant DID to route the given message to.
   */
  public async processMessage(
    tenant: string, rawMessage: MessagesSubscribeMessage, options?: MessagesSubscribeMessageOptions): Promise<MessagesSubscribeReply>;
  public async processMessage(tenant: string, rawMessage: MessagesReadMessage): Promise<MessagesReadReply>;
  public async processMessage(tenant: string, rawMessage: MessagesQueryMessage): Promise<MessagesQueryReply>;
  public async processMessage(tenant: string, rawMessage: ProtocolsConfigureMessage): Promise<GenericMessageReply>;
  public async processMessage(tenant: string, rawMessage: ProtocolsQueryMessage): Promise<ProtocolsQueryReply>;
  public async processMessage(tenant: string, rawMessage: RecordsCountMessage): Promise<RecordsCountReply>;
  public async processMessage(tenant: string, rawMessage: RecordsDeleteMessage): Promise<GenericMessageReply>;
  public async processMessage(tenant: string, rawMessage: RecordsQueryMessage): Promise<RecordsQueryReply>;
  public async processMessage(
    tenant: string, rawMessage: RecordsSubscribeMessage, options: RecordsSubscribeMessageOptions): Promise<RecordsSubscribeReply>;
  public async processMessage(tenant: string, rawMessage: RecordsReadMessage): Promise<RecordsReadReply>;
  public async processMessage(tenant: string, rawMessage: RecordsWriteMessage, options?: RecordsWriteMessageOptions): Promise<GenericMessageReply>;
  public async processMessage(tenant: string, rawMessage: unknown, options?: MessageOptions): Promise<UnionMessageReply>;
  public async processMessage(tenant: string, rawMessage: GenericMessage, options: MessageOptions = {}): Promise<UnionMessageReply> {
    const errorMessageReply = await this.validateTenant(tenant) ?? await this.validateMessageIntegrity(rawMessage);
    if (errorMessageReply !== undefined) {
      return errorMessageReply;
    }

    const { dataStream, subscriptionHandler } = options;

    const handlerKey = rawMessage.descriptor.interface + rawMessage.descriptor.method;
    const methodHandlerReply = await this.methodHandlers[handlerKey].handle({
      tenant,
      message: rawMessage,
      dataStream,
      subscriptionHandler,
    });

    return methodHandlerReply;
  }

  /**
   * Applies a message obtained through replication and returns a structured
   * outcome instead of an HTTP-like handler status. Normal authoring still
   * uses `processMessage`; sync uses this entry point so missing local
   * dependencies can be fetched and retried without treating the replicated
   * message as permanently invalid.
   */
  public async applyReplicatedMessage(
    tenant: string,
    rawMessage: GenericMessage,
    options: ReplicationApplyOptions = {},
  ): Promise<ReplicationApplyResult> {
    const tenantError = await this.validateTenant(tenant);
    if (tenantError !== undefined) {
      return { kind: 'Deferred', reason: 'tenant-inactive' };
    }

    const integrityError = await this.validateMessageIntegrity(rawMessage);
    if (integrityError !== undefined) {
      return { kind: 'Invalid', reason: integrityError.status.detail };
    }

    if (await this.replicatedMessageAlreadyStored(tenant, rawMessage)) {
      return { kind: 'Duplicate' };
    }

    const reply = await this.processMessage(tenant, rawMessage, options);
    const replicatedWriteBeatenByDeleteResult = await this.storeReplicatedWriteBeatenByDelete(tenant, rawMessage, reply, options);
    if (replicatedWriteBeatenByDeleteResult !== undefined) {
      return replicatedWriteBeatenByDeleteResult;
    }

    const protocolDefinition = await this.getReplicationApplyProtocolDefinition(tenant, rawMessage, reply);
    const missingAncestorRecordIds = await this.getReplicationApplyMissingAncestors(tenant, rawMessage, reply);
    const missingRoleAudienceRolePath = await this.getReplicationApplyMissingRoleAudienceRolePath(tenant, rawMessage, reply);
    return replicationApplyResultFromReply(rawMessage, reply, { protocolDefinition, missingAncestorRecordIds, missingRoleAudienceRolePath });
  }

  /**
   * Computes the layer-batched missing-ancestor set for a replicated message that failed on a
   * missing ancestor (immediate parent or record-chain construction), so the resulting
   * `Incomplete` names every locally-absent ancestor at once. Returns `undefined`
   * (single-ancestor emission) when the set cannot be computed.
   */
  private async getReplicationApplyMissingAncestors(
    tenant: string,
    message: GenericMessage,
    reply: { status: { detail?: string } },
  ): Promise<string[] | undefined> {
    try {
      return await missingAncestorRecordIdsFromReply(tenant, message, reply, this.validationStateReader);
    } catch {
      return undefined;
    }
  }

  private async getReplicationApplyMissingRoleAudienceRolePath(
    tenant: string,
    message: GenericMessage,
    reply: { status: { detail?: string } },
  ): Promise<string | undefined> {
    const detail = reply.status.detail ?? '';
    if (
      !detail.startsWith(`${DwnErrorCode.ProtocolAuthorizationEncryptionRoleAudienceEpochMissing}:`) ||
      !Dwn.isRecordsWriteMessage(message)
    ) {
      return undefined;
    }

    try {
      return (await findMissingRoleAudienceEncryptionContext(tenant, message, this.validationStateReader))?.rolePath;
    } catch {
      return undefined;
    }
  }

  private async storeReplicatedWriteBeatenByDelete(
    tenant: string,
    message: GenericMessage,
    reply: { status: { detail?: string } },
    options: ReplicationApplyOptions,
  ): Promise<ReplicationApplyResult | undefined> {
    const detail = reply.status.detail ?? '';
    if (!detail.startsWith(`${DwnErrorCode.RecordsWriteNotAllowedAfterDelete}:`) || !Records.isRecordsWrite(message)) {
      return undefined;
    }

    const query = {
      interface : DwnInterfaceName.Records,
      recordId  : message.recordId,
    };
    const { messages: existingMessages } = await this.messageStore.query(tenant, [query]);
    const initialWrite = await RecordsWrite.getInitialWrite(existingMessages);
    const existingDelete = await Records.getNewestRecordsDelete(existingMessages);
    if (existingDelete === undefined) {
      return undefined;
    }

    const validationReply = await this.validateReplicatedWriteBeatenByDelete(tenant, message, existingMessages, options);
    if (validationReply !== undefined) {
      return replicationApplyResultFromReply(message, validationReply);
    }

    const recordsWrite = await RecordsWrite.parse(message);
    const storedWriteMessage: RecordsWriteMessage & { encodedData?: string } = { ...message };
    delete storedWriteMessage.encodedData;
    const recordsWriteIndexes = await recordsWrite.constructIndexes(false);
    await this.messageStore.put(tenant, storedWriteMessage, recordsWriteIndexes);

    const recordsDelete = await RecordsDelete.parse(existingDelete);
    const visibilitySourceWrite = await Records.getNewestRecordsWrite([...existingMessages, storedWriteMessage]) ?? initialWrite;
    const recordsDeleteIndexes = recordsDelete.constructIndexes(initialWrite, visibilitySourceWrite);
    const recordsDeleteCid = await Message.getCid(existingDelete);
    await this.messageStore.updateIndexes(tenant, recordsDeleteCid, recordsDeleteIndexes);

    return { kind: 'Superseded' };
  }

  private async validateReplicatedWriteBeatenByDelete(
    tenant: string,
    message: RecordsWriteMessage,
    existingMessages: GenericMessage[],
    options: ReplicationApplyOptions,
  ): Promise<GenericMessageReply | undefined> {
    try {
      await this.validateReplicatedWriteBeatenByDeleteOrThrow(tenant, message, existingMessages, options);
      return undefined;
    } catch (error) {
      const statusCode = error instanceof DwnError
        ? this._coreProtocols.mapErrorToStatusCode(error.code) ?? 400
        : 400;
      return messageReplyFromError(error, statusCode);
    }
  }

  private async validateReplicatedWriteBeatenByDeleteOrThrow(
    tenant: string,
    message: RecordsWriteMessage,
    existingMessages: GenericMessage[],
    options: ReplicationApplyOptions,
  ): Promise<void> {
    const coreProtocol = message.descriptor.protocol === undefined
      ? undefined
      : this._coreProtocols.get(message.descriptor.protocol);

    if (coreProtocol?.preProcessWrite !== undefined) {
      await coreProtocol.preProcessWrite(tenant, message, this.validationStateReader);
    }

    if (options.dataStream !== undefined) {
      await Dwn.validateReplicatedWriteBeatenByDeleteDataStream(message, options.dataStream, coreProtocol);
      return;
    }

    if (await RecordsWrite.isInitialWrite(message)) {
      return;
    }

    await this.validateReplicatedWriteBeatenByDeleteExistingData(tenant, message, existingMessages);
  }

  private static async validateReplicatedWriteBeatenByDeleteDataStream(
    message: RecordsWriteMessage,
    dataStream: ReadableStream<Uint8Array>,
    coreProtocol: CoreProtocol | undefined,
  ): Promise<void> {
    if (message.descriptor.dataSize <= DwnConstant.maxDataSizeAllowedToBeEncoded) {
      const dataBytes = await DataStream.toBytes(dataStream);
      const dataCid = await Cid.computeDagPbCidFromBytes(dataBytes);
      RecordsWrite.validateDataIntegrity(message.descriptor.dataCid, message.descriptor.dataSize, dataCid, dataBytes.length);

      if (coreProtocol?.validateRecord !== undefined) {
        await coreProtocol.validateRecord(message, dataBytes);
      }

      return;
    }

    const [dataCidStream, dataSizeStream] = DataStream.duplicateDataStream(dataStream, 2);
    const [dataCid, dataSize] = await Promise.all([
      Cid.computeDagPbCidFromStream(dataCidStream),
      Dwn.getDataStreamByteLength(dataSizeStream),
    ]);
    RecordsWrite.validateDataIntegrity(message.descriptor.dataCid, message.descriptor.dataSize, dataCid, dataSize);
  }

  private async validateReplicatedWriteBeatenByDeleteExistingData(
    tenant: string,
    message: RecordsWriteMessage,
    existingMessages: GenericMessage[],
  ): Promise<void> {
    const newestExistingWrite = await Records.getNewestRecordsWrite(existingMessages);
    if (newestExistingWrite === undefined) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteGetInitialWriteNotFound,
        `initial write is missing for record ${message.recordId}`
      );
    }

    const { dataCid, dataSize } = message.descriptor;
    RecordsWrite.validateDataIntegrity(dataCid, dataSize, newestExistingWrite.descriptor.dataCid, newestExistingWrite.descriptor.dataSize);

    if (dataSize <= DwnConstant.maxDataSizeAllowedToBeEncoded) {
      const newestExistingWriteWithData = newestExistingWrite as RecordsQueryReplyEntry;
      if (newestExistingWriteWithData.encodedData === undefined) {
        throw new DwnError(
          DwnErrorCode.RecordsWriteMissingEncodedDataInPrevious,
          `No dataStream was provided and unable to get data from previous message`
        );
      }

      return;
    }

    const priorDataExists = await this.validationStateReader.hasStoredData(tenant, newestExistingWrite.recordId, dataCid);
    if (!priorDataExists) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteMissingDataInPrevious,
        `No dataStream was provided and unable to get data from previous message`
      );
    }
  }

  private static async getDataStreamByteLength(dataStream: ReadableStream<Uint8Array>): Promise<number> {
    let byteLength = 0;
    for await (const chunk of DataStream.asAsyncIterable(dataStream)) {
      byteLength += chunk.length;
    }

    return byteLength;
  }

  private async getReplicationApplyProtocolDefinition(
    tenant: string,
    message: GenericMessage,
    reply: { status: { detail?: string } },
  ): Promise<ProtocolDefinition | undefined> {
    const detail = reply.status.detail ?? '';
    if (
      !detail.startsWith(`${DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound}:`) &&
      !detail.startsWith(`${DwnErrorCode.EncryptionProtocolValidateAudienceWriterUnauthorized}:`)
    ) {
      return undefined;
    }

    const lookup = Dwn.getReplicationApplyProtocolDefinitionLookup(message);
    if (lookup === undefined) {
      return undefined;
    }

    try {
      return await this.validationStateReader.fetchProtocolDefinition(
        tenant,
        lookup.protocol,
        lookup.messageTimestamp,
      );
    } catch {
      return undefined;
    }
  }

  private static getReplicationApplyProtocolDefinitionLookup(
    message: GenericMessage,
  ): ReplicationApplyProtocolDefinitionLookup | undefined {
    if (Dwn.isRecordsWriteMessage(message)) {
      const taggedProtocol = Dwn.getEncryptionRecordTaggedProtocol(message);
      if (taggedProtocol !== undefined) {
        return {
          protocol         : taggedProtocol,
          messageTimestamp : message.descriptor.messageTimestamp,
        };
      }

      return {
        protocol         : message.descriptor.protocol,
        messageTimestamp : message.descriptor.messageTimestamp,
      };
    }

    const protocol = Dwn.getMessageProtocolForReplicationApply(message);
    return protocol === undefined ? undefined : { protocol };
  }

  private static getEncryptionRecordTaggedProtocol(message: RecordsWriteMessage): string | undefined {
    if (message.descriptor.protocol !== EncryptionProtocol.uri) {
      return undefined;
    }

    const protocol = message.descriptor.tags?.protocol;
    return typeof protocol === 'string' ? protocol : undefined;
  }

  private static getMessageProtocolForReplicationApply(message: GenericMessage): string | undefined {
    const descriptor = message.descriptor as { protocol?: unknown; filter?: { protocol?: unknown } };
    if (typeof descriptor.protocol === 'string') {
      return descriptor.protocol;
    }
    if (typeof descriptor.filter?.protocol === 'string') {
      return descriptor.filter.protocol;
    }
  }

  private static isRecordsWriteMessage(message: GenericMessage): message is RecordsWriteMessage {
    return message.descriptor.interface === DwnInterfaceName.Records &&
      message.descriptor.method === DwnMethodName.Write;
  }

  private async replicatedMessageAlreadyStored(
    tenant: string,
    message: GenericMessage,
  ): Promise<boolean> {
    const existingMessages = await this.getExistingMessagesForReplicationDedup(tenant, message);
    if (existingMessages.length === 0) {
      return false;
    }

    const incomingCid = await Message.getCid(message);
    for (const existing of existingMessages) {
      if (await Message.getCid(existing) !== incomingCid) {
        continue;
      }

      return true;
    }

    return false;
  }

  private async getExistingMessagesForReplicationDedup(
    tenant: string,
    message: GenericMessage,
  ): Promise<GenericMessage[]> {
    const { descriptor } = message;
    if (descriptor.interface === DwnInterfaceName.Records && descriptor.method === DwnMethodName.Write) {
      const recordId = (message as { recordId?: unknown }).recordId;
      if (typeof recordId !== 'string') {
        return [];
      }

      const { messages } = await this.messageStore.query(tenant, [{
        interface: DwnInterfaceName.Records,
        recordId,
      }]);
      return messages;
    }

    if (descriptor.interface === DwnInterfaceName.Records && descriptor.method === DwnMethodName.Delete) {
      const recordId = (descriptor as { recordId?: unknown }).recordId;
      if (typeof recordId !== 'string') {
        return [];
      }

      const { messages } = await this.messageStore.query(tenant, [{
        interface: DwnInterfaceName.Records,
        recordId,
      }]);
      return messages;
    }

    if (descriptor.interface === DwnInterfaceName.Protocols && descriptor.method === DwnMethodName.Configure) {
      const protocol = (descriptor as { definition?: { protocol?: unknown } }).definition?.protocol;
      if (typeof protocol !== 'string') {
        return [];
      }

      const { messages } = await this.messageStore.query(tenant, [{
        interface : DwnInterfaceName.Protocols,
        method    : DwnMethodName.Configure,
        protocol,
      }]);
      return messages;
    }

    return [];
  }

  /**
   * Checks tenant gate to see if tenant is allowed.
   * @param tenant The tenant DID to route the given message to.
   * @returns GenericMessageReply if the message has an integrity error, otherwise undefined.
   */
  public async validateTenant(tenant: string): Promise<GenericMessageReply | undefined> {
    const result = await this.tenantGate.isActiveTenant(tenant);
    if (!result.isActiveTenant) {
      const detail = result.detail ?? `DID ${tenant} is not an active tenant.`;
      return {
        status: { code: 401, detail }
      };
    }
  }

  /**
   * Validates structure of DWN message
   * @param tenant The tenant DID to route the given message to.
   * @param dwnMessageInterface The interface of DWN message.
   * @param dwnMessageMethod The interface of DWN message.

   * @returns GenericMessageReply if the message has an integrity error, otherwise undefined.
   */
  public async validateMessageIntegrity(
    rawMessage: any,
  ): Promise<GenericMessageReply | undefined> {
    // Verify interface and method
    const dwnInterface = rawMessage?.descriptor?.interface;
    const dwnMethod = rawMessage?.descriptor?.method;

    if (dwnInterface === undefined || dwnMethod === undefined) {
      return {
        status: { code: 400, detail: `Both interface and method must be present, interface: ${dwnInterface}, method: ${dwnMethod}` }
      };
    }

    // validate message structure
    try {
      // consider to push this down to individual handlers
      Message.validateJsonSchema(rawMessage);
    } catch (error) {
      return messageReplyFromError(error, 400);
    }
  }
};

/**
 *  MessageOptions that are used when processing a message.
 */
export interface MessageOptions {
  dataStream?: ReadableStream<Uint8Array>;
  subscriptionHandler?: SubscriptionListener;
};

/**
 * DWN configuration.
 */
export type DwnConfig = {
  didResolver?: DidResolver;
  tenantGate?: TenantGate;

  /**
   * Internal flag indicating the DWN created and owns the resolver's lifecycle.
   * When true, the DWN will call open()/close() on the resolver during its own lifecycle.
   * Set automatically by `Dwn.create()` when it creates a default resolver.
   * @internal
   */
  ownsResolver?: boolean;

  /**
   * Persistent event log with cursor-based reads and in-process subscriptions.
   * Optional — if not provided, subscriptions will not be supported.
   */
  eventLog?: EventLog;

  /**
   * Instrumentation seam: wraps the internally constructed `ValidationStateReader` before it is
   * handed to the handlers (e.g. with a `RecordingValidationStateReader`). Used by the
   * replay-basis closure tests and harnesses to record every validation-time state read.
   */
  instrumentValidationStateReader?: (validationStateReader: ValidationStateReader) => ValidationStateReader;

  messageStore: MessageStore;
  dataStore: DataStore;
  resumableTaskStore: ResumableTaskStore;
};
