import type { AdminActivityEvent } from './types.js';

/** Default maximum number of events retained in the ring buffer. */
export const DEFAULT_ACTIVITY_LOG_CAPACITY = 10_000;

/**
 * In-memory ring buffer that captures recent DWN request activity.
 *
 * Events are assigned a monotonically increasing `id` that acts as a cursor.
 * When the buffer reaches capacity, the oldest events are evicted. This is
 * **not** a persistent audit log — it is designed for real-time admin
 * observability.
 */
export class ActivityLog {
  readonly #capacity: number;
  readonly #buffer: AdminActivityEvent[];
  #nextId = 1;

  constructor(capacity: number = DEFAULT_ACTIVITY_LOG_CAPACITY) {
    this.#capacity = Math.max(1, capacity);
    this.#buffer = [];
  }

  /**
   * Records a new activity event. If the buffer is full, the oldest event is
   * evicted.
   */
  public record(event: Omit<AdminActivityEvent, 'id' | 'timestamp'>): void {
    const entry: AdminActivityEvent = {
      id            : this.#nextId++,
      timestamp     : new Date().toISOString(),
      tenant        : event.tenant,
      interface     : event.interface,
      method        : event.method,
      statusCode    : event.statusCode,
      transport     : event.transport,
      dataSizeBytes : event.dataSizeBytes,
    };

    if (this.#buffer.length >= this.#capacity) {
      this.#buffer.shift();
    }

    this.#buffer.push(entry);
  }

  /**
   * Returns recent events, optionally filtered by a cursor (returns events
   * with `id > since`) and limited to `limit` entries.
   */
  public getEvents(options?: {
    since? : number;
    limit? : number;
  }): { events: AdminActivityEvent[]; cursor?: number } {
    const since = options?.since ?? 0;
    const limit = options?.limit ?? 50;

    // Binary search for the start index (events are ordered by id).
    let startIdx = 0;
    if (since > 0 && this.#buffer.length > 0) {
      let lo = 0;
      let hi = this.#buffer.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.#buffer[mid].id <= since) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      startIdx = lo;
    }

    const events = this.#buffer.slice(startIdx, startIdx + limit);
    const cursor = events.length > 0 ? events[events.length - 1].id : undefined;

    return { events, cursor };
  }

  /**
   * Returns the current number of events in the buffer.
   */
  public get size(): number {
    return this.#buffer.length;
  }

  /**
   * Returns the configured capacity of the ring buffer.
   */
  public get capacity(): number {
    return this.#capacity;
  }

  /**
   * Clears all events from the buffer.
   */
  public clear(): void {
    this.#buffer.length = 0;
  }
}
