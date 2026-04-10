import type { KeyValues } from '../types/query-types.js';
import type {
  EventLog,
  EventLogEntry,
  EventLogReadOptions,
  EventLogReadResult,
  EventLogSubscribeOptions,
  EventSubscription,
  MessageEvent,
  ProgressGapInfo,
  ProgressGapReason,
  ProgressToken,
  SubscriptionListener,
} from '../types/subscriptions.js';

import mitt from 'mitt';

import { FilterUtility } from '../utils/filter.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

const EVENTS_LISTENER_CHANNEL = 'events';

/**
 * Payload shape used internally by mitt. We bundle the three EventListener
 * arguments into a single object because mitt emits one value per event.
 */
type EmitterPayload = { tenant: string; event: MessageEvent; indexes: KeyValues; seq: number; messageCid: string };

/**
 * mitt event map — every channel name maps to an `EmitterPayload`.
 * Using `Record<string, EmitterPayload>` lets us create channels dynamically.
 */
type EmitterEvents = Record<string, EmitterPayload>;

/**
 * Internal storage entry — the event plus its indexes and message CID.
 */
type StoredEntry = {
  event : MessageEvent;
  indexes : KeyValues;
  messageCid : string;
};

export interface EventEmitterEventLogConfig {
  /**
   * Maximum number of events to retain per tenant.
   * Oldest events are evicted when the limit is reached.
   * Defaults to 10_000.
   */
  maxEventsPerTenant?: number;

  /**
   * An optional error handler in order to be able to react to any errors or warnings.
   * By default we log errors with `console.error`.
   */
  errorHandler?: (error: any) => void;
}

/**
 * In-memory implementation of {@link EventLog} backed by `mitt` for in-process
 * pub/sub and a per-tenant `Map<number, StoredEntry>` for persistence with
 * cursor-based reads.
 *
 * Suitable for single-process embedded DWN instances and tests.
 * For multi-node deployments, use a distributed implementation (NATS, Redis, etc.).
 */
export class EventEmitterEventLog implements EventLog {
  private emitter = mitt<EmitterEvents>();
  private isOpen: boolean = false;
  private errorHandler: (error: any) => void = (error): void => { console.error('event log error', error); };
  private maxEventsPerTenant: number;

  /**
   * Per-tenant ordered event storage.
   * Key: tenant DID → Map of seq → StoredEntry.
   */
  private tenantLogs: Map<string, Map<number, StoredEntry>> = new Map();

  /**
   * Per-tenant monotonic sequence counter.
   */
  private tenantSeqs: Map<string, number> = new Map();

  /**
   * Epoch for this EventLog instance. Generated once at construction as a
   * UUID v4. Changes every restart (correct for in-memory — state is lost).
   */
  private readonly epoch: string;

  constructor(config: EventEmitterEventLogConfig = {}) {
    this.maxEventsPerTenant = config.maxEventsPerTenant ?? 10_000;
    this.epoch = crypto.randomUUID();

    if (config.errorHandler) {
      this.errorHandler = config.errorHandler;
    }
  }

  /**
   * Derives a stable `streamId` for a given tenant. Deterministic — same
   * tenant always produces the same streamId on any instance.
   */
  private async getStreamId(tenant: string): Promise<string> {
    const bytes = new TextEncoder().encode(tenant);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = new Uint8Array(hashBuffer);
    // Take first 16 hex chars (64 bits) of the hash for a compact stable ID.
    return Array.from(hashArray.slice(0, 8), (b: number) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Constructs a {@link ProgressToken} from internal state.
   */
  private async buildToken(tenant: string, seq: number, messageCid: string): Promise<ProgressToken> {
    return {
      streamId : await this.getStreamId(tenant),
      epoch    : this.epoch,
      position : String(seq),
      messageCid,
    };
  }

  /**
   * Validates a cursor against the current EventLog state. Throws
   * `DwnError(EventLogProgressGap)` with {@link ProgressGapInfo} metadata
   * if the cursor cannot be resumed.
   */
  private async validateCursor(tenant: string, cursor: ProgressToken): Promise<void> {
    const expectedStreamId = await this.getStreamId(tenant);

    let reason: ProgressGapReason;
    if (cursor.streamId !== expectedStreamId) {
      reason = 'stream_mismatch';
    } else if (cursor.epoch === this.epoch) {
      // Check if position is still within replay bounds.
      const log = this.tenantLogs.get(tenant);
      if (log !== undefined && log.size > 0) {
        const firstSeq = log.keys().next().value as number;
        const cursorSeq = EventEmitterEventLog.parsePosition(cursor.position);
        if (cursorSeq < firstSeq - 1) {
          // Cursor position has been evicted — events between cursor and firstSeq are lost.
          reason = 'token_too_old';
        } else {
          return; // Cursor is valid.
        }
      } else {
        return; // No events for tenant — cursor is vacuously valid (will get empty catch-up + EOSE).
      }
    } else {
      reason = 'epoch_mismatch';
    }

    // Build gap metadata.
    const bounds = await this.getReplayBounds(tenant);
    const gapInfo: ProgressGapInfo = {
      requested       : cursor,
      oldestAvailable : bounds?.oldest ?? cursor,
      latestAvailable : bounds?.latest ?? cursor,
      reason,
    };

    const error = new DwnError(
      DwnErrorCode.EventLogProgressGap,
      `progress token gap: ${reason}`
    );
    (error as any).gapInfo = gapInfo;
    throw error;
  }

  public async open(): Promise<void> {
    this.isOpen = true;
  }

  public async close(): Promise<void> {
    this.isOpen = false;
    this.emitter.all.clear();
    this.tenantLogs.clear();
    this.tenantSeqs.clear();
  }

  public async emit(tenant: string, event: MessageEvent, indexes: KeyValues, messageCid: string): Promise<ProgressToken | undefined> {
    if (!this.isOpen) {
      this.errorHandler(new DwnError(
        DwnErrorCode.EventLogNotOpenError,
        'a message emitted when EventLog is closed'
      ));
      return undefined;
    }

    // Assign a monotonic sequence number for this tenant.
    const prevSeq = this.tenantSeqs.get(tenant) ?? 0;
    const seq = prevSeq + 1;
    this.tenantSeqs.set(tenant, seq);

    // Persist the event.
    let log = this.tenantLogs.get(tenant);
    if (log === undefined) {
      log = new Map();
      this.tenantLogs.set(tenant, log);
    }
    log.set(seq, { event, indexes, messageCid });

    // Evict oldest entries if the log exceeds the retention limit.
    if (log.size > this.maxEventsPerTenant) {
      const evictCount = log.size - this.maxEventsPerTenant;
      let evicted = 0;
      for (const key of log.keys()) {
        if (evicted >= evictCount) { break; }
        log.delete(key);
        evicted++;
      }
    }

    // Notify in-process subscribers.
    const channel = `${tenant}_${EVENTS_LISTENER_CHANNEL}`;
    this.emitter.emit(channel, { tenant, event, indexes, seq, messageCid });

    return this.buildToken(tenant, seq, messageCid);
  }

  public async read(tenant: string, options: EventLogReadOptions = {}): Promise<EventLogReadResult> {
    const { cursor, limit, filters } = options;

    // Validate cursor before attempting to read.
    if (cursor !== undefined) {
      await this.validateCursor(tenant, cursor);
    }

    const cursorSeq = cursor === undefined ? undefined : EventEmitterEventLog.parsePosition(cursor.position);
    const log = this.tenantLogs.get(tenant);

    if (log === undefined || log.size === 0) {
      return { events: [], cursor };
    }

    const results: EventLogEntry[] = [];
    const maxResults = limit ?? Number.MAX_SAFE_INTEGER;

    for (const [seq, entry] of log) {
      // Skip entries at or before the cursor.
      if (cursorSeq !== undefined && seq <= cursorSeq) { continue; }

      // Apply filters if provided (OR semantics — match any filter).
      if (filters !== undefined && filters.length > 0) {
        if (!FilterUtility.matchAnyFilter(entry.indexes, filters)) { continue; }
      }

      results.push({
        seq,
        event      : entry.event,
        indexes    : entry.indexes,
        messageCid : entry.messageCid,
      });

      if (results.length >= maxResults) { break; }
    }

    if (results.length > 0) {
      const lastEntry = results[results.length - 1];
      // Use the messageCid captured during the synchronous iteration above —
      // no re-lookup needed, so eviction during the await cannot lose it.
      const lastToken = await this.buildToken(tenant, lastEntry.seq, lastEntry.messageCid!);
      return { events: results, cursor: lastToken };
    }

    return { events: results, cursor };
  }

  /**
   * Parse a position string into an internal sequence number using BigInt
   * for safe handling of values beyond `Number.MAX_SAFE_INTEGER`.
   *
   * The returned `number` is safe for the in-memory EventLog which uses
   * `Map<number, StoredEntry>` keys — in-memory sequences will never
   * exceed safe integer range. The BigInt parse validates correctness
   * before the narrowing conversion.
   */
  private static parsePosition(position: string): number {
    try {
      const big = BigInt(position);
      if (big < 0n) {
        throw new DwnError(DwnErrorCode.EventLogNotOpenError, `invalid cursor position: '${position}'`);
      }
      return Number(big);
    } catch (e) {
      if (e instanceof DwnError) { throw e; }
      throw new DwnError(DwnErrorCode.EventLogNotOpenError, `invalid cursor position: '${position}'`);
    }
  }

  public async subscribe(
    tenant: string,
    id: string,
    listener: SubscriptionListener,
    options?: EventLogSubscribeOptions,
  ): Promise<EventSubscription> {
    const channel = `${tenant}_${EVENTS_LISTENER_CHANNEL}`;
    const { cursor, filters } = options ?? {};

    // Helper to build a token from a live emitter payload.
    const tokenFromPayload = async (payload: EmitterPayload): Promise<ProgressToken> => {
      return this.buildToken(tenant, payload.seq, payload.messageCid);
    };

    if (cursor !== undefined) {
      // ---- Cursor mode: catch-up from stored events, then EOSE, then live ----
      // Validate cursor before subscribing — throws DwnError(EventLogProgressGap) on gap.
      await this.validateCursor(tenant, cursor);

      const cursorSeq = EventEmitterEventLog.parsePosition(cursor.position);

      // Buffer live events that arrive during catch-up to avoid losing them.
      type BufferedEvent = { event: MessageEvent; seq: number; messageCid: string };
      const pendingLiveEvents: BufferedEvent[] = [];
      let catchUpComplete = false;

      // Step 1: Register live listener FIRST so no events are missed during read.
      const handler = (payload: EmitterPayload): void => {
        if (filters !== undefined && filters.length > 0) {
          if (!FilterUtility.matchAnyFilter(payload.indexes, filters)) { return; }
        }
        if (catchUpComplete) {
          void tokenFromPayload(payload).then((token) => {
            listener({ type: 'event', cursor: token, event: payload.event });
          });
        } else {
          pendingLiveEvents.push({ event: payload.event, seq: payload.seq, messageCid: payload.messageCid });
        }
      };

      this.emitter.on(channel, handler);

      // Step 2: Read stored events from cursor and deliver them.
      const readResult = await this.read(tenant, { cursor, filters });
      // The read cursor is the token of the last read event, or the input cursor if nothing new.
      const eoseCursor = readResult.cursor ?? cursor;
      const lastCatchUpSeq = readResult.cursor === undefined
        ? cursorSeq
        : EventEmitterEventLog.parsePosition(readResult.cursor.position);

      // Use the messageCid captured by read() during its synchronous iteration.
      // This eliminates re-lookup races: read() populates entry.messageCid before
      // any async yield, so eviction during read()'s buildToken() cannot lose it.
      for (const entry of readResult.events) {
        const token = await this.buildToken(tenant, entry.seq, entry.messageCid ?? '');
        listener({ type: 'event', cursor: token, event: entry.event });
      }

      // Step 3: Deliver any live events that arrived during catch-up (with seq > lastCatchUpSeq).
      // messageCid was captured at buffer time from the EmitterPayload.
      catchUpComplete = true;
      for (const liveEvent of pendingLiveEvents) {
        if (liveEvent.seq > lastCatchUpSeq) {
          const token = await this.buildToken(tenant, liveEvent.seq, liveEvent.messageCid);
          listener({ type: 'event', cursor: token, event: liveEvent.event });
        }
      }

      // Step 4: Send EOSE marker.
      listener({ type: 'eose', cursor: eoseCursor });

      return {
        id,
        close: async (): Promise<void> => { this.emitter.off(channel, handler); }
      };
    }

    // ---- No cursor: live events only ----

    const handler = (payload: EmitterPayload): void => {
      if (filters !== undefined && filters.length > 0) {
        if (!FilterUtility.matchAnyFilter(payload.indexes, filters)) { return; }
      }
      void tokenFromPayload(payload).then((token) => {
        listener({ type: 'event', cursor: token, event: payload.event });
      });
    };

    this.emitter.on(channel, handler);

    return {
      id,
      close: async (): Promise<void> => { this.emitter.off(channel, handler); }
    };
  }

  public async getReplayBounds(tenant: string): Promise<{ oldest: ProgressToken; latest: ProgressToken } | undefined> {
    const log = this.tenantLogs.get(tenant);
    if (log === undefined || log.size === 0) {
      return undefined;
    }

    // Map is ordered by insertion (ascending seq). First and last keys are min/max.
    const keys = [...log.keys()];
    const oldestSeq = keys[0];
    const latestSeq = keys[keys.length - 1];

    const oldestEntry = log.get(oldestSeq)!;
    const latestEntry = log.get(latestSeq)!;

    const oldest = await this.buildToken(tenant, oldestSeq, oldestEntry.messageCid);
    const latest = await this.buildToken(tenant, latestSeq, latestEntry.messageCid);

    return { oldest, latest };
  }

  public async trim(tenant: string, olderThan: number | string): Promise<void> {
    const log = this.tenantLogs.get(tenant);
    if (log === undefined) { return; }

    if (typeof olderThan === 'number') {
      // Trim by sequence number: delete entries with seq < olderThan.
      for (const seq of log.keys()) {
        if (seq < olderThan) {
          log.delete(seq);
        } else {
          break; // Map is ordered by insertion (ascending seq), safe to stop.
        }
      }
    } else {
      // Trim by ISO-8601 timestamp: delete entries whose message timestamp is before the given time.
      for (const [seq, entry] of log) {
        const messageTimestamp = (entry.indexes['messageTimestamp'] as string) ?? '';
        if (messageTimestamp < olderThan) {
          log.delete(seq);
        }
      }
    }
  }
}
