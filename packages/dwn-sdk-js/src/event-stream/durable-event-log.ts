import type { GenericMessage } from '../types/message-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { RecordsWriteMessage } from '../types/records-types.js';
import type {
  EventLog,
  EventLogEntry,
  EventLogReadOptions,
  EventLogReadResult,
  EventLogSubscribeOptions,
  EventSubscription,
  MessageEvent,
  ProgressGapInfo,
  ProgressToken,
  ReplicationFeedReader,
  SubscriptionEvent,
  SubscriptionListener,
  Wake,
  WakeSubscriber,
} from '../types/subscriptions.js';
import type { Filter, KeyValues } from '../types/query-types.js';

import { Messages } from '../utils/messages.js';
import { Records } from '../utils/records.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { Replication } from '../utils/replication.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export type DurableEventLogStore = ReplicationFeedReader & Pick<MessageStore, 'query'>;

export type DurableEventLogConfig = {
  /**
   * Maximum number of log rows read per drain step.
   * Defaults to 100.
   */
  readLimit?: number;

  /**
   * Interval for idle re-drain. This bounds dropped-wake latency.
   * Set to 0 to disable the interval.
   */
  idleRedrainIntervalMs?: number;

  /**
   * Optional handler for background subscription-drain errors.
   */
  errorHandler?: (error: unknown) => void;
};

type DurableSubscription = {
  id: string;
  tenant: string;
  listener: SubscriptionListener;
  filters?: Filter[];
  cursor?: ProgressToken;
  closed: boolean;
  draining: boolean;
  liveReady: boolean;
  redrainRequested: boolean;
};

type CatchUpPageState = {
  readCursor : ProgressToken;
  reachedFrozenPosition : boolean;
};

const DEFAULT_READ_LIMIT = 100;
const DEFAULT_IDLE_REDRAIN_INTERVAL_MS = 30_000;

/**
 * EventLog implementation backed by the durable replication feed.
 *
 * Writes are store-owned: MessageStore commits publish wakes after the row is
 * durable. `emit()` is therefore intentionally a no-op while legacy handlers
 * still depend on the EventLog interface.
 */
export class DurableEventLog implements EventLog {
  private readonly subscriptions: Map<string, DurableSubscription> = new Map();
  private readonly readLimit: number;
  private readonly idleRedrainIntervalMs: number;
  private readonly errorHandler: (error: unknown) => void;
  private unsubscribeWake?: () => void;
  private idleRedrainTimer?: ReturnType<typeof setInterval>;
  private isOpen: boolean = false;

  public constructor(
    private readonly store: DurableEventLogStore,
    private readonly wakeSubscriber: WakeSubscriber,
    config: DurableEventLogConfig = {},
  ) {
    this.readLimit = Math.max(1, config.readLimit ?? DEFAULT_READ_LIMIT);
    this.idleRedrainIntervalMs = config.idleRedrainIntervalMs ?? DEFAULT_IDLE_REDRAIN_INTERVAL_MS;
    this.errorHandler = config.errorHandler ?? ((error): void => { console.error('durable event log error', error); });
  }

  public async open(): Promise<void> {
    if (this.isOpen) {
      return;
    }

    this.unsubscribeWake = this.wakeSubscriber.subscribe((wake): void => {
      this.handleWake(wake);
    });

    if (this.idleRedrainIntervalMs > 0) {
      this.idleRedrainTimer = setInterval((): void => {
        this.redrainAll();
      }, this.idleRedrainIntervalMs);
    }

    this.isOpen = true;
  }

  public async close(): Promise<void> {
    this.unsubscribeWake?.();
    this.unsubscribeWake = undefined;

    if (this.idleRedrainTimer !== undefined) {
      clearInterval(this.idleRedrainTimer);
      this.idleRedrainTimer = undefined;
    }

    for (const subscription of this.subscriptions.values()) {
      subscription.closed = true;
    }
    this.subscriptions.clear();
    this.isOpen = false;
  }

  public async emit(_tenant: string, _event: MessageEvent, _indexes: KeyValues, _messageCid: string): Promise<ProgressToken | undefined> {
    return undefined;
  }

  public async read(tenant: string, options: EventLogReadOptions = {}): Promise<EventLogReadResult> {
    const result = await this.store.logRead(tenant, options);
    return {
      ...result,
      events: DurableEventLog.detachEntryEncodedData(await this.attachInitialWrites(tenant, result.events)),
    };
  }

  public async subscribe(
    tenant: string,
    id: string,
    listener: SubscriptionListener,
    options: EventLogSubscribeOptions = {},
  ): Promise<EventSubscription> {
    const subscription: DurableSubscription = {
      id,
      tenant,
      listener,
      filters          : options.filters,
      cursor           : await this.getInitialCursor(tenant, options.cursor),
      closed           : false,
      draining         : false,
      liveReady        : options.cursor === undefined,
      redrainRequested : false,
    };
    this.subscriptions.set(id, subscription);

    if (options.cursor !== undefined) {
      try {
        const eoseCursor = await this.catchUpSubscription(subscription, options.cursor);
        if (!subscription.closed) {
          listener({ type: 'eose', cursor: eoseCursor });
          subscription.liveReady = true;
          if (subscription.redrainRequested) {
            this.scheduleDrain(subscription);
          }
        }
      } catch (error) {
        subscription.closed = true;
        this.subscriptions.delete(id);
        throw error;
      }
    }

    return {
      id,
      close: async (): Promise<void> => {
        subscription.closed = true;
        this.subscriptions.delete(id);
      }
    };
  }

  public async getReplayBounds(tenant: string): Promise<{ oldest: ProgressToken; latest: ProgressToken } | undefined> {
    return this.store.logBounds(tenant);
  }

  public async trim(_tenant: string, _olderThan: number | string): Promise<void> {
    // Durable retention is owned by the backing store.
  }

  private async getInitialCursor(tenant: string, cursor: ProgressToken | undefined): Promise<ProgressToken | undefined> {
    if (cursor !== undefined) {
      return cursor;
    }

    const bounds = await this.store.logBounds(tenant);
    return bounds?.latest;
  }

  private handleWake(wake: Wake): void {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.tenant !== wake.tenant || subscription.closed) {
        continue;
      }

      this.scheduleDrain(subscription);
    }
  }

  private redrainAll(): void {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.closed) {
        continue;
      }

      this.scheduleDrain(subscription);
    }
  }

  private scheduleDrain(subscription: DurableSubscription): void {
    if (!subscription.liveReady) {
      subscription.redrainRequested = true;
      return;
    }

    void this.drainSubscription(subscription).catch((error): void => {
      this.handleDrainError(subscription, error);
    });
  }

  private handleDrainError(subscription: DurableSubscription, error: unknown): void {
    if (subscription.closed) {
      return;
    }

    if (error instanceof DwnError && error.code === DwnErrorCode.EventLogProgressGap) {
      const gapInfo = DurableEventLog.getProgressGapInfo(error);
      const cursor = gapInfo?.requested ?? subscription.cursor ?? gapInfo?.latestAvailable;
      if (cursor === undefined) {
        this.errorHandler(error);
        return;
      }

      subscription.closed = true;
      this.subscriptions.delete(subscription.id);
      subscription.listener({
        type  : 'error',
        cursor,
        error : {
          code   : 'ProgressGap',
          detail : error.message,
        },
      });
      return;
    }

    this.errorHandler(error);
  }

  private async catchUpSubscription(subscription: DurableSubscription, cursor: ProgressToken): Promise<ProgressToken> {
    const frozenCursor = await this.getCatchUpHighWater(subscription.tenant, cursor);
    const frozenPosition = BigInt(frozenCursor.position);
    let readCursor = cursor;
    subscription.cursor = cursor;

    while (!subscription.closed && BigInt(readCursor.position) < frozenPosition) {
      const result = await this.read(subscription.tenant, {
        cursor  : readCursor,
        filters : subscription.filters,
        limit   : this.readLimit,
      });
      const pageState = await this.deliverCatchUpPage(subscription, result.events, readCursor, frozenPosition);
      if (subscription.closed) {
        return frozenCursor;
      }

      const resultCursor = result.cursor ?? pageState.readCursor;
      if (DurableEventLog.isCatchUpComplete(pageState.reachedFrozenPosition, result, resultCursor, frozenPosition)) {
        DurableEventLog.finishCatchUp(subscription, frozenCursor);
        return frozenCursor;
      }

      readCursor = resultCursor;
      subscription.cursor = resultCursor;
    }

    DurableEventLog.finishCatchUp(subscription, frozenCursor);
    return frozenCursor;
  }

  private async getCatchUpHighWater(tenant: string, cursor: ProgressToken): Promise<ProgressToken> {
    const bounds = await this.store.logBounds(tenant);
    const frozenCursor = bounds?.latest ?? cursor;

    await this.read(tenant, { cursor, limit: 0 });
    return frozenCursor;
  }

  private async deliverCatchUpPage(
    subscription: DurableSubscription,
    entries: EventLogEntry[],
    readCursor: ProgressToken,
    frozenPosition: bigint,
  ): Promise<CatchUpPageState> {
    let nextCursor = readCursor;

    for (const entry of entries) {
      if (BigInt(DurableEventLog.getEntryPosition(entry)) > frozenPosition) {
        return { readCursor: nextCursor, reachedFrozenPosition: true };
      }

      const deliveredCursor = await this.deliverEntry(subscription, entry);
      if (subscription.closed) {
        return { readCursor: nextCursor, reachedFrozenPosition: false };
      }

      nextCursor = deliveredCursor ?? nextCursor;
      subscription.cursor = nextCursor;
    }

    return { readCursor: nextCursor, reachedFrozenPosition: false };
  }

  private async drainSubscription(subscription: DurableSubscription): Promise<void> {
    if (subscription.draining) {
      subscription.redrainRequested = true;
      return;
    }

    subscription.draining = true;
    try {
      do {
        subscription.redrainRequested = false;
        await this.drainOnce(subscription);
      } while (subscription.redrainRequested && !subscription.closed);
    } finally {
      subscription.draining = false;
    }
  }

  private async drainOnce(subscription: DurableSubscription): Promise<void> {
    for (;;) {
      if (subscription.closed) {
        return;
      }

      const result = await this.read(subscription.tenant, {
        cursor  : subscription.cursor,
        filters : subscription.filters,
        limit   : this.readLimit,
      });

      for (const entry of result.events) {
        const cursor = await this.deliverEntry(subscription, entry);
        if (subscription.closed) {
          return;
        }

        subscription.cursor = cursor ?? subscription.cursor;
      }

      if (subscription.closed) {
        return;
      }

      subscription.cursor = result.cursor ?? subscription.cursor;
      if (result.drained) {
        return;
      }
    }
  }

  private async deliverEntry(subscription: DurableSubscription, entry: EventLogEntry): Promise<ProgressToken | undefined> {
    if (subscription.closed) {
      return undefined;
    }

    const cursor = await this.buildToken(subscription.tenant, DurableEventLog.getEntryPosition(entry), entry.messageCid);
    if (subscription.closed) {
      return undefined;
    }

    const event: SubscriptionEvent = {
      type              : 'event',
      cursor,
      event             : entry.event,
      seq               : entry.seq,
      messageCid        : entry.messageCid,
      isLatestBaseState : DurableEventLog.isLatestBaseState(entry),
      protocol          : DurableEventLog.getProtocol(entry),
    };

    if (entry.encodedData !== undefined) {
      event.encodedData = entry.encodedData;
    }

    subscription.listener(event);
    return cursor;
  }

  private async attachInitialWrites(tenant: string, entries: EventLogEntry[]): Promise<EventLogEntry[]> {
    const result: EventLogEntry[] = [];
    for (const entry of entries) {
      result.push({
        ...entry,
        event: await this.attachInitialWrite(tenant, entry.event),
      });
    }

    return result;
  }

  private async attachInitialWrite(tenant: string, event: MessageEvent): Promise<MessageEvent> {
    if (event.initialWrite !== undefined || !await DurableEventLog.needsInitialWrite(event.message)) {
      return event;
    }

    const recordId = DurableEventLog.getRecordId(event.message);
    if (recordId === undefined) {
      return event;
    }

    const { messages } = await this.store.query(tenant, [{
      interface: DwnInterfaceName.Records,
      recordId,
    }]);
    const initialWrite = await RecordsWrite.getInitialWrite(messages);
    if (initialWrite === undefined) {
      return event;
    }

    const { message } = Messages.detachEncodedData(initialWrite);
    return { ...event, initialWrite: message as RecordsWriteMessage };
  }

  private static async needsInitialWrite(message: GenericMessage): Promise<boolean> {
    if (Records.isRecordsWrite(message)) {
      return !await RecordsWrite.isInitialWrite(message);
    }

    return message.descriptor.interface === DwnInterfaceName.Records &&
      message.descriptor.method === DwnMethodName.Delete;
  }

  private static getRecordId(message: GenericMessage): string | undefined {
    const recordId = (message as { recordId?: unknown }).recordId;
    if (typeof recordId === 'string') {
      return recordId;
    }

    const descriptorRecordId = (message.descriptor as { recordId?: unknown }).recordId;
    return typeof descriptorRecordId === 'string' ? descriptorRecordId : undefined;
  }

  private async buildToken(tenant: string, position: string, messageCid: string | undefined): Promise<ProgressToken> {
    const token: ProgressToken = {
      streamId : await Replication.deriveStreamId(tenant),
      epoch    : await this.store.epoch(),
      position,
    };

    if (messageCid !== undefined) {
      token.messageCid = messageCid;
    }

    return token;
  }

  private static getEntryPosition(entry: EventLogEntry): string {
    return entry.position ?? entry.seq;
  }

  private static getProgressGapInfo(error: DwnError): ProgressGapInfo | undefined {
    const gapInfo = (error as DwnError & { gapInfo?: ProgressGapInfo }).gapInfo;
    if (gapInfo === undefined) {
      return undefined;
    }

    return gapInfo;
  }

  private static isCatchUpComplete(
    reachedFrozenPosition: boolean,
    result: EventLogReadResult,
    resultCursor: ProgressToken,
    frozenPosition: bigint,
  ): boolean {
    return reachedFrozenPosition || result.drained || BigInt(resultCursor.position) >= frozenPosition;
  }

  private static finishCatchUp(subscription: DurableSubscription, frozenCursor: ProgressToken): void {
    subscription.cursor = frozenCursor;
  }

  private static isLatestBaseState(entry: EventLogEntry): boolean {
    return entry.indexes.isLatestBaseState === true || entry.indexes.isLatestBaseState === 'true';
  }

  private static getProtocol(entry: EventLogEntry): string | undefined {
    const protocol = entry.indexes.protocol;
    return typeof protocol === 'string' ? protocol : undefined;
  }

  private static detachEntryEncodedData(entries: EventLogEntry[]): EventLogEntry[] {
    return entries.map((entry): EventLogEntry => {
      const { message, encodedData } = Messages.detachEncodedData(entry.event.message);
      return {
        ...entry,
        event: {
          ...entry.event,
          message,
        },
        encodedData,
      };
    });
  }
}
