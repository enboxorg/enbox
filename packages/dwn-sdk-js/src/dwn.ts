import type { DataStore } from './types/data-store.js';
import type { DidResolver } from '@enbox/dids';
import type { MessageStore } from './types/message-store.js';
import type { ResumableTaskStore } from './types/resumable-task-store.js';
import type { StateIndex } from './types/state-index.js';
import type { TenantGate } from './core/tenant-gate.js';
import type { UnionMessageReply } from './core/message-reply.js';
import type { EventLog, SubscriptionListener } from './types/subscriptions.js';
import type { GenericMessage, GenericMessageReply } from './types/message-types.js';
import type { HandlerDependencies, MethodHandler } from './types/method-handler.js';
import type { MessagesReadMessage, MessagesReadReply, MessagesSubscribeMessage, MessagesSubscribeMessageOptions, MessagesSubscribeReply, MessagesSyncMessage, MessagesSyncReply } from './types/messages-types.js';
import type { ProtocolsConfigureMessage, ProtocolsQueryMessage, ProtocolsQueryReply } from './types/protocols-types.js';
import type { RecordsCountMessage, RecordsCountReply, RecordsDeleteMessage, RecordsQueryMessage, RecordsQueryReply, RecordsReadMessage, RecordsReadReply, RecordsSubscribeMessage, RecordsSubscribeMessageOptions, RecordsSubscribeReply, RecordsWriteMessage, RecordsWriteMessageOptions } from './types/records-types.js';

import { AllowAllTenantGate } from './core/tenant-gate.js';
import { CoreProtocolRegistry } from './core/core-protocol.js';
import { Message } from './core/message.js';
import { messageReplyFromError } from './core/message-reply.js';
import { MessagesReadHandler } from './handlers/messages-read.js';
import { MessagesSubscribeHandler } from './handlers/messages-subscribe.js';
import { MessagesSyncHandler } from './handlers/messages-sync.js';
import { PermissionsProtocol } from './protocols/permissions.js';
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
import { DidDht, DidJwk, DidKey, DidResolverCacheMemory, DidWeb, UniversalResolver } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName } from './enums/dwn-interface-method.js';

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

export class Dwn {
  private readonly methodHandlers: { [key:string]: MethodHandler };
  private readonly didResolver: DidResolver;
  private readonly messageStore: MessageStore;
  private readonly dataStore: DataStore;
  private readonly resumableTaskStore: ResumableTaskStore;
  private readonly stateIndex: StateIndex;
  private readonly tenantGate: TenantGate;
  private readonly eventLog?: EventLog;
  private readonly storageController: StorageController;
  private readonly resumableTaskManager: ResumableTaskManager;
  private readonly _coreProtocols: CoreProtocolRegistry;

  /** Whether the DWN owns the resolver's lifecycle (i.e., created it via defaults). */
  private readonly ownsResolver: boolean;

  private constructor(config: DwnConfig) {
    this.didResolver = config.didResolver!;
    this.ownsResolver = config.ownsResolver ?? false;
    this.tenantGate = config.tenantGate!;
    this.messageStore = config.messageStore;
    this.dataStore = config.dataStore;
    this.resumableTaskStore = config.resumableTaskStore;
    this.stateIndex = config.stateIndex;

    this.eventLog = config.eventLog;

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

    // Initialize the core protocol registry with built-in system protocols.
    this._coreProtocols = new CoreProtocolRegistry();
    this._coreProtocols.register(new PermissionsProtocol());

    // Build the shared dependency bag once; every handler receives the same object
    // and accesses only the dependencies it needs.
    const deps: HandlerDependencies = {
      didResolver          : this.didResolver,
      messageStore         : this.messageStore,
      dataStore            : this.dataStore,
      stateIndex           : this.stateIndex,
      resumableTaskManager : this.resumableTaskManager,
      coreProtocols        : this._coreProtocols,
      eventLog             : this.eventLog,
    };

    this.methodHandlers = {
      [DwnInterfaceName.Messages + DwnMethodName.Read]       : new MessagesReadHandler(deps),
      [DwnInterfaceName.Messages + DwnMethodName.Subscribe]  : new MessagesSubscribeHandler(deps),
      [DwnInterfaceName.Messages + DwnMethodName.Sync]       : new MessagesSyncHandler(deps),
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
      message: rawMessage,
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

  messageStore: MessageStore;
  dataStore: DataStore;
  stateIndex: StateIndex;
  resumableTaskStore: ResumableTaskStore;
};
