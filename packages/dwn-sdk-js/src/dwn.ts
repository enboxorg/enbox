import type { DataStore } from './types/data-store.js';
import type { DidResolver } from '@enbox/dids';
import type { MessageStore } from './types/message-store.js';
import type { MethodHandler } from './types/method-handler.js';
import type { ResumableTaskStore } from './types/resumable-task-store.js';
import type { StateIndex } from './types/state-index.js';
import type { TenantGate } from './core/tenant-gate.js';
import type { UnionMessageReply } from './core/message-reply.js';
import type { EventLog, EventStream } from './types/subscriptions.js';
import type { GenericMessage, GenericMessageReply } from './types/message-types.js';
import type { MessagesReadMessage, MessagesReadReply, MessagesSubscribeMessage, MessagesSubscribeMessageOptions, MessagesSubscribeReply, MessagesSyncMessage, MessagesSyncReply, MessageSubscriptionHandler } from './types/messages-types.js';
import type { ProtocolsConfigureMessage, ProtocolsQueryMessage, ProtocolsQueryReply } from './types/protocols-types.js';
import type { RecordsCountMessage, RecordsCountReply, RecordsDeleteMessage, RecordsQueryMessage, RecordsQueryReply, RecordsReadMessage, RecordsReadReply, RecordsSubscribeMessage, RecordsSubscribeMessageOptions, RecordsSubscribeReply, RecordSubscriptionHandler, RecordsWriteMessage, RecordsWriteMessageOptions } from './types/records-types.js';

import { AllowAllTenantGate } from './core/tenant-gate.js';
import { EventStreamToEventLogAdapter } from './event-stream/event-stream-to-event-log-adapter.js';
import { Message } from './core/message.js';
import { messageReplyFromError } from './core/message-reply.js';
import { MessagesReadHandler } from './handlers/messages-read.js';
import { MessagesSubscribeHandler } from './handlers/messages-subscribe.js';
import { MessagesSyncHandler } from './handlers/messages-sync.js';
import { ProtocolsConfigureHandler } from './handlers/protocols-configure.js';
import { ProtocolsQueryHandler } from './handlers/protocols-query.js';
import { RecordsCountHandler } from './handlers/records-count.js';
import { RecordsDeleteHandler } from './handlers/records-delete.js';
import { RecordsQueryHandler } from './handlers/records-query.js';
import { RecordsReadHandler } from './handlers/records-read.js';
import { RecordsSubscribeHandler } from './handlers/records-subscribe.js';
import { RecordsWriteHandler } from './handlers/records-write.js';
import { ResumableTaskManager } from './core/resumable-task-manager.js';
import { StorageController } from './store/storage-controller.js';
import { DidDht, DidJwk, DidKey, DidResolverCacheLevel, DidWeb, UniversalResolver } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName } from './enums/dwn-interface-method.js';

export class Dwn {
  private methodHandlers: { [key:string]: MethodHandler };
  private didResolver: DidResolver;
  private messageStore: MessageStore;
  private dataStore: DataStore;
  private resumableTaskStore: ResumableTaskStore;
  private stateIndex: StateIndex;
  private tenantGate: TenantGate;
  private eventLog?: EventLog;
  private storageController: StorageController;
  private resumableTaskManager: ResumableTaskManager;

  private constructor(config: DwnConfig) {
    this.didResolver = config.didResolver!;
    this.tenantGate = config.tenantGate!;
    this.messageStore = config.messageStore;
    this.dataStore = config.dataStore;
    this.resumableTaskStore = config.resumableTaskStore;
    this.stateIndex = config.stateIndex;

    // Resolve EventLog: prefer `eventLog`, fall back to wrapping deprecated `eventStream`.
    if (config.eventLog !== undefined) {
      this.eventLog = config.eventLog;
    } else if (config.eventStream !== undefined) {
      this.eventLog = new EventStreamToEventLogAdapter(config.eventStream);
    }

    this.storageController = new StorageController({
      messageStore : this.messageStore,
      dataStore    : this.dataStore,
      stateIndex   : this.stateIndex,
      eventLog     : this.eventLog
    });
    this.resumableTaskManager = new ResumableTaskManager(
      config.resumableTaskStore,
      this.storageController
    );

    this.methodHandlers = {
      [DwnInterfaceName.Messages + DwnMethodName.Read]: new MessagesReadHandler(
        this.didResolver,
        this.messageStore,
        this.dataStore,
      ),
      [DwnInterfaceName.Messages + DwnMethodName.Subscribe]: new MessagesSubscribeHandler(
        this.didResolver,
        this.messageStore,
        this.eventLog,
      ),
      [DwnInterfaceName.Messages + DwnMethodName.Sync]: new MessagesSyncHandler(
        this.didResolver,
        this.messageStore,
        this.stateIndex,
      ),
      [DwnInterfaceName.Protocols + DwnMethodName.Configure]: new ProtocolsConfigureHandler(
        this.didResolver,
        this.messageStore,
        this.stateIndex,
        this.eventLog
      ),
      [DwnInterfaceName.Protocols + DwnMethodName.Query]: new ProtocolsQueryHandler(
        this.didResolver,
        this.messageStore,
        this.dataStore
      ),
      [DwnInterfaceName.Records + DwnMethodName.Count]: new RecordsCountHandler(
        this.didResolver,
        this.messageStore,
      ),
      [DwnInterfaceName.Records + DwnMethodName.Delete]: new RecordsDeleteHandler(
        this.didResolver,
        this.messageStore,
        this.resumableTaskManager
      ),
      [DwnInterfaceName.Records + DwnMethodName.Query]: new RecordsQueryHandler(
        this.didResolver,
        this.messageStore,
        this.dataStore
      ),
      [DwnInterfaceName.Records + DwnMethodName.Read]: new RecordsReadHandler(
        this.didResolver,
        this.messageStore,
        this.dataStore
      ),
      [DwnInterfaceName.Records + DwnMethodName.Subscribe]: new RecordsSubscribeHandler(
        this.didResolver,
        this.messageStore,
        this.eventLog
      ),
      [DwnInterfaceName.Records + DwnMethodName.Write]: new RecordsWriteHandler(
        this.didResolver,
        this.messageStore,
        this.dataStore,
        this.stateIndex,
        this.eventLog
      )
    };
  }

  /**
   * Creates an instance of the DWN.
   */
  public static async create(config: DwnConfig): Promise<Dwn> {
    config.didResolver ??= new UniversalResolver({
      didResolvers : [ DidDht, DidJwk, DidKey, DidWeb ],
      cache        : new DidResolverCacheLevel({ location: 'RESOLVERCACHE' }),
    });
    config.tenantGate ??= new AllowAllTenantGate();

    const dwn = new Dwn(config);
    await dwn.open();
    return dwn;
  }

  /**
   * Initializes the DWN instance and opens the connection to it.
   */
  public async open(): Promise<void> {
    await this.messageStore.open();
    await this.dataStore.open();
    await this.resumableTaskStore.open();
    await this.stateIndex.open();
    await this.eventLog?.open();

    await this.resumableTaskManager.resumeTasksAndWaitForCompletion();
  }

  public async close(): Promise<void> {
    await this.eventLog?.close();
    await this.messageStore.close();
    await this.dataStore.close();
    await this.resumableTaskStore.close();
    await this.stateIndex.close();
  }

  /**
   * Returns the internal storage components for advanced operations that
   * cannot be expressed through the standard `processMessage()` pipeline
   * (e.g., owner-upgrade of externally authored encrypted records).
   *
   * Callers are responsible for maintaining consistency across stores.
   */
  public get storage(): { messageStore: MessageStore; stateIndex: StateIndex; eventLog: EventLog | undefined } {
    return {
      messageStore : this.messageStore,
      stateIndex   : this.stateIndex,
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
  public async processMessage(tenant: string, rawMessage: MessagesSyncMessage): Promise<MessagesSyncReply>;
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
      message: rawMessage as GenericMessage,
      dataStream,
      subscriptionHandler
    });

    return methodHandlerReply;
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
  subscriptionHandler?: MessageSubscriptionHandler | RecordSubscriptionHandler;
};

/**
 * DWN configuration.
 */
export type DwnConfig = {
  didResolver?: DidResolver;
  tenantGate?: TenantGate;

  /**
   * Persistent event log with cursor-based reads and in-process subscriptions.
   * Preferred over `eventStream`. If both are provided, `eventLog` takes precedence.
   */
  eventLog?: EventLog;

  /**
   * @deprecated Use `eventLog` instead. If only `eventStream` is provided it will
   * be wrapped in an adapter that satisfies the {@link EventLog} interface but
   * does NOT provide persistence or cursor-based reads.
   */
  eventStream?: EventStream;

  messageStore: MessageStore;
  dataStore: DataStore;
  stateIndex: StateIndex;
  resumableTaskStore: ResumableTaskStore;
};
