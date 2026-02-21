import type { KeyValues } from '../types/query-types.js';
import type {
  EventListener,
  EventLog,
  EventLogReadOptions,
  EventLogReadResult,
  EventStream,
  EventSubscription,
  MessageEvent,
} from '../types/subscriptions.js';

/**
 * Adapter that wraps a legacy {@link EventStream} implementation to satisfy the
 * {@link EventLog} interface. The adapter provides no persistence, no
 * cursor-based reads, and no trim — it simply delegates `emit()` and
 * `subscribe()` to the underlying `EventStream`.
 *
 * This exists solely as a backward-compatibility bridge so that existing
 * `EventStream` plugins continue to work when passed to `DwnConfig.eventStream`.
 */
export class EventStreamToEventLogAdapter implements EventLog {
  private seq: number = 0;

  constructor(private eventStream: EventStream) {}

  public async emit(tenant: string, event: MessageEvent, indexes: KeyValues): Promise<number> {
    this.seq++;
    this.eventStream.emit(tenant, event, indexes);
    return this.seq;
  }

  public async read(_tenant: string, options: EventLogReadOptions = {}): Promise<EventLogReadResult> {
    // Legacy EventStream has no persistence — read always returns empty.
    return { events: [], cursor: options.cursor ?? -1 };
  }

  public async subscribe(tenant: string, id: string, listener: EventListener): Promise<EventSubscription> {
    return this.eventStream.subscribe(tenant, id, listener);
  }

  public async trim(): Promise<void> {
    // no-op — legacy EventStream has no persistence.
  }

  public async open(): Promise<void> {
    return this.eventStream.open();
  }

  public async close(): Promise<void> {
    return this.eventStream.close();
  }
}
