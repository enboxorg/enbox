import type { Filter } from '../types/query-types.js';
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

import { executeUnlessAborted } from '../utils/abort.js';
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
  cursor: ProgressToken;
  signal?: AbortSignal;
  unsubscribeAbort?: () => void;
  retry?: { timer: ReturnType<typeof setTimeout>; resume: () => void };
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
const DRAIN_RETRY_DELAY_MS = 100;

/**
 * EventLog implementation backed by the durable replication feed.
 *
 * Writes are store-owned: MessageStore commits publish wakes after the row is
 * durable.
 */
export class DurableEventLog implements EventLog {
  private readonly subscriptions: Map<string, DurableSubscription> = new Map();
  private readonly readLimit: number;
  private readonly idleRedrainIntervalMs: number;
  private readonly errorHandler: (error: unknown) => void;
  private unsubscribeWake?: () => void;
  private idleRedrainTimer?: ReturnType<typeof setInterval>;
  private isOpen: boolean = false;
  private closeGeneration: number = 0;

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
    this.closeGeneration++;
    this.unsubscribeWake?.();
    this.unsubscribeWake = undefined;

    if (this.idleRedrainTimer !== undefined) {
      clearInterval(this.idleRedrainTimer);
      this.idleRedrainTimer = undefined;
    }

    for (const subscription of this.subscriptions.values()) {
      this.closeSubscription(subscription);
    }
    this.subscriptions.clear();
    this.isOpen = false;
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
    const { signal } = options;
    signal?.throwIfAborted();
    const closeGeneration = this.closeGeneration;
    const streamId = await executeUnlessAborted(Replication.deriveStreamId(tenant), signal);
    const cursor = await executeUnlessAborted(this.getInitialCursor(tenant, options.cursor, streamId), signal);
    if (closeGeneration !== this.closeGeneration) {
      throw new DwnError(DwnErrorCode.EventLogNotOpenError, 'event log closed during subscription initialization');
    }
    signal?.throwIfAborted();
    const subscription: DurableSubscription = {
      id,
      tenant,
      listener,
      signal,
      filters          : options.filters,
      cursor,
      closed           : false,
      draining         : false,
      liveReady        : options.cursor === undefined,
      redrainRequested : false,
    };
    this.subscriptions.set(id, subscription);
    if (signal !== undefined) {
      const onAbort = (): void => this.closeSubscription(subscription);
      signal.addEventListener('abort', onAbort, { once: true });
      subscription.unsubscribeAbort = (): void => signal.removeEventListener('abort', onAbort);
    }

    if (options.cursor !== undefined) {
      try {
        const eoseCursor = await this.catchUpSubscription(subscription, options.cursor);
        if (!subscription.closed) {
          await this.deliverMessage(subscription, { type: 'eose', cursor: eoseCursor });
          if (!subscription.closed) {
            subscription.liveReady = true;
            if (subscription.redrainRequested) {
              this.scheduleDrain(subscription);
            }
          }
        }
      } catch (error) {
        this.closeSubscription(subscription);
        throw error;
      }
    }

    return {
      id,
      close: async (): Promise<void> => {
        // Do not wait for the drain: a listener may await its own subscription close.
        this.closeSubscription(subscription);
      }
    };
  }

  public async getReplayBounds(tenant: string): Promise<{ oldest: ProgressToken; latest: ProgressToken } | undefined> {
    return this.store.logBounds(tenant);
  }

  private closeSubscription(subscription: DurableSubscription): void {
    subscription.closed = true;
    this.clearRetry(subscription);
    subscription.unsubscribeAbort?.();
    subscription.unsubscribeAbort = undefined;
    // An older handle must not remove a replacement with the same signed message CID.
    if (this.subscriptions.get(subscription.id) === subscription) {
      this.subscriptions.delete(subscription.id);
    }
  }

  private async getInitialCursor(tenant: string, cursor: ProgressToken | undefined, streamId: string): Promise<ProgressToken> {
    if (cursor !== undefined) {
      return cursor;
    }

    const bounds = await this.store.logBounds(tenant);
    return bounds?.latest ?? { streamId, epoch: await this.store.epoch(), position: '0' };
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

    // Wakes remain detached from committed writes; only this subscription waits for its listener.
    void this.drainSubscription(subscription).catch((error): Promise<void> => this.handleDrainError(subscription, error));
  }

  private async handleDrainError(subscription: DurableSubscription, error: unknown): Promise<void> {
    if (subscription.closed) {
      return;
    }

    if (error instanceof DwnError && error.code === DwnErrorCode.EventLogProgressGap) {
      const gapInfo = DurableEventLog.getProgressGapInfo(error);
      const cursor = gapInfo?.requested ?? subscription.cursor;

      this.closeSubscription(subscription);
      try {
        await this.deliverMessage(subscription, {
          type  : 'error',
          cursor,
          error : {
            code   : 'ProgressGap',
            detail : error.message,
          },
        });
      } catch (listenerError) {
        this.errorHandler(listenerError);
      }
      return;
    }

    this.errorHandler(error);
  }

  private async catchUpSubscription(subscription: DurableSubscription, cursor: ProgressToken): Promise<ProgressToken> {
    const frozenCursor = await this.getCatchUpHighWater(subscription, cursor);
    const frozenPosition = BigInt(frozenCursor.position);
    let readCursor = cursor;
    subscription.cursor = cursor;

    while (!subscription.closed && BigInt(readCursor.position) < frozenPosition) {
      const result = await this.readSubscriptionPage(subscription, readCursor);
      const pageState = await this.deliverCatchUpPage(subscription, result.events, result.cursor ?? readCursor, readCursor, frozenPosition);
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

  private async getCatchUpHighWater(subscription: DurableSubscription, cursor: ProgressToken): Promise<ProgressToken> {
    const bounds = await executeUnlessAborted(this.store.logBounds(subscription.tenant), subscription.signal);
    const frozenCursor = bounds?.latest ?? cursor;

    await executeUnlessAborted(this.read(subscription.tenant, { cursor, limit: 0 }), subscription.signal);
    return frozenCursor;
  }

  private async deliverCatchUpPage(
    subscription: DurableSubscription,
    entries: EventLogEntry[],
    pageCursor: ProgressToken,
    readCursor: ProgressToken,
    frozenPosition: bigint,
  ): Promise<CatchUpPageState> {
    let nextCursor = readCursor;

    for (const entry of entries) {
      if (BigInt(DurableEventLog.getEntryPosition(entry)) > frozenPosition) {
        return { readCursor: nextCursor, reachedFrozenPosition: true };
      }

      const deliveredCursor = await this.deliverEntry(subscription, entry, pageCursor);
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
        try {
          await this.drainOnce(subscription);
        } catch (error) {
          await this.handleDrainError(subscription, error); // NOSONAR: S9382 - settle failure/terminal delivery before retrying this cursor.
          if (subscription.redrainRequested && !subscription.closed) {
            // Preserve wakes received during failed delivery without spinning on a poison event.
            await this.waitForRetry(subscription); // NOSONAR: S9382 - pace this subscription's next attempt to prevent a failure spin.
          }
        }
      } while (subscription.redrainRequested && !subscription.closed);
    } finally {
      subscription.draining = false;
    }
  }

  private async waitForRetry(subscription: DurableSubscription): Promise<void> {
    const delay = new Promise<void>((resolve): void => {
      subscription.retry = { timer: setTimeout(resolve, DRAIN_RETRY_DELAY_MS), resume: resolve };
    });
    try {
      await executeUnlessAborted(delay, subscription.signal);
    } finally {
      this.clearRetry(subscription);
    }
  }

  private clearRetry(subscription: DurableSubscription): void {
    const retry = subscription.retry;
    if (retry !== undefined) {
      subscription.retry = undefined;
      clearTimeout(retry.timer);
      retry.resume();
    }
  }

  /** Read a page and fence any generation change that occurred within the read itself. */
  private async readSubscriptionPage(subscription: DurableSubscription, cursor: ProgressToken): Promise<EventLogReadResult> {
    const { streamId, epoch } = cursor;
    const result = await executeUnlessAborted(this.read(subscription.tenant, {
      cursor,
      filters : subscription.filters,
      limit   : this.readLimit,
    }), subscription.signal);
    if (result.cursor !== undefined && (result.cursor.streamId !== streamId || result.cursor.epoch !== epoch)) {
      throw new DwnError(DwnErrorCode.EventLogProgressGap, 'progress token gap: stream domain changed during a subscription read');
    }
    return result;
  }

  private async drainOnce(subscription: DurableSubscription): Promise<void> {
    for (;;) {
      if (subscription.closed) {
        return;
      }

      const readCursor = subscription.cursor;
      const result = await this.readSubscriptionPage(subscription, readCursor);

      for (const entry of result.events) {
        const cursor = await this.deliverEntry(subscription, entry, result.cursor ?? readCursor);
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

  private async deliverEntry(
    subscription: DurableSubscription, entry: EventLogEntry, pageCursor: ProgressToken,
  ): Promise<ProgressToken | undefined> {
    if (subscription.closed) {
      return undefined;
    }

    const cursor = DurableEventLog.buildToken(pageCursor, DurableEventLog.getEntryPosition(entry), entry.messageCid);

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

    // Completion owns cursor advancement and prevents an unbounded queue of pending listeners.
    await this.deliverMessage(subscription, event);
    return cursor;
  }

  private deliverMessage(subscription: DurableSubscription, message: Parameters<SubscriptionListener>[0]): void | Promise<void> {
    subscription.signal?.throwIfAborted();
    const delivery = subscription.listener(message);
    if (subscription.signal === undefined) {
      return delivery;
    } else {
      return executeUnlessAborted(Promise.resolve(delivery), subscription.signal);
    }
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

    const { messages } = await this.store.query(tenant, [{ entryId: recordId }]);
    const initialWrite = messages[0] as RecordsWriteMessage | undefined;
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

  private static buildToken(pageCursor: ProgressToken, position: string, messageCid: string | undefined): ProgressToken {
    const token: ProgressToken = {
      // Rows retain the stream generation captured by their read page, even if a listener resets storage.
      streamId : pageCursor.streamId,
      epoch    : pageCursor.epoch,
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
