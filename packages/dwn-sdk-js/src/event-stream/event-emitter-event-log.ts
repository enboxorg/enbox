import type { KeyValues } from '../types/query-types.js';
import type {
  EventListener,
  EventLog,
  EventLogEntry,
  EventLogReadOptions,
  EventLogReadResult,
  EventSubscription,
  MessageEvent,
} from '../types/subscriptions.js';

import mitt from 'mitt';

import { FilterUtility } from '../utils/filter.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

const EVENTS_LISTENER_CHANNEL = 'events';

/**
 * Payload shape used internally by mitt. We bundle the three EventListener
 * arguments into a single object because mitt emits one value per event.
 */
type EmitterPayload = { tenant: string; event: MessageEvent; indexes: KeyValues };

/**
 * mitt event map — every channel name maps to an `EmitterPayload`.
 * Using `Record<string, EmitterPayload>` lets us create channels dynamically.
 */
type EmitterEvents = Record<string, EmitterPayload>;

/**
 * Internal storage entry — the event plus its indexes.
 */
type StoredEntry = {
  event : MessageEvent;
  indexes : KeyValues;
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

  constructor(config: EventEmitterEventLogConfig = {}) {
    this.maxEventsPerTenant = config.maxEventsPerTenant ?? 10_000;

    if (config.errorHandler) {
      this.errorHandler = config.errorHandler;
    }
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

  public async emit(tenant: string, event: MessageEvent, indexes: KeyValues): Promise<number> {
    if (!this.isOpen) {
      this.errorHandler(new DwnError(
        DwnErrorCode.EventEmitterStreamNotOpenError,
        'a message emitted when EventLog is closed'
      ));
      return -1;
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
    log.set(seq, { event, indexes });

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
    this.emitter.emit(channel, { tenant, event, indexes });

    return seq;
  }

  public async read(tenant: string, options: EventLogReadOptions = {}): Promise<EventLogReadResult> {
    const { cursor, limit, filters } = options;
    const log = this.tenantLogs.get(tenant);

    if (log === undefined || log.size === 0) {
      return { events: [], cursor: cursor ?? -1 };
    }

    const results: EventLogEntry[] = [];
    const maxResults = limit ?? Number.MAX_SAFE_INTEGER;

    for (const [seq, entry] of log) {
      // Skip entries at or before the cursor.
      if (cursor !== undefined && seq <= cursor) { continue; }

      // Apply filters if provided (OR semantics — match any filter).
      if (filters !== undefined && filters.length > 0) {
        if (!FilterUtility.matchAnyFilter(entry.indexes, filters)) { continue; }
      }

      results.push({
        seq,
        event   : entry.event,
        indexes : entry.indexes,
      });

      if (results.length >= maxResults) { break; }
    }

    const lastSeq = results.length > 0 ? results[results.length - 1].seq : (cursor ?? -1);
    return { events: results, cursor: lastSeq };
  }

  public async subscribe(tenant: string, id: string, listener: EventListener): Promise<EventSubscription> {
    const channel = `${tenant}_${EVENTS_LISTENER_CHANNEL}`;

    // Wrap the three-arg EventListener into a single-arg mitt handler.
    const handler = (payload: EmitterPayload): void => {
      listener(payload.tenant, payload.event, payload.indexes);
    };

    this.emitter.on(channel, handler);

    return {
      id,
      close: async (): Promise<void> => { this.emitter.off(channel, handler); }
    };
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
