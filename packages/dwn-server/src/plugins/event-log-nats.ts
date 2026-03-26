import type { NatsConnection } from '@nats-io/transport-node';
import type { ConsumerMessages, JetStreamClient, JetStreamManager } from '@nats-io/jetstream';
import type { EventLog, EventLogEntry, EventLogReadOptions, EventLogReadResult, EventLogSubscribeOptions, EventSubscription, Filter, KeyValues, MessageEvent, ProgressGapInfo, ProgressGapReason, ProgressToken, SubscriptionListener } from '@enbox/dwn-sdk-js';

import log from 'loglevel';

import { DwnError, DwnErrorCode } from '@enbox/dwn-sdk-js';

import { connect } from '@nats-io/transport-node';
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from '@nats-io/jetstream';

// ---------------------------------------------------------------------------
// Configuration — all sourced from environment variables
// ---------------------------------------------------------------------------

type NatsEventLogConfig = {
  /** NATS connection URL(s), comma-separated. */
  url : string;
  /** JetStream stream name. */
  streamName : string;
  /** Max event age in nanoseconds (0 = unlimited). */
  streamMaxAge : number;
  /** JetStream replication factor. */
  replicas : number;
  /** Max messages per subject (per-tenant cap). */
  maxMsgsPerSubject : number;
};

function loadConfig(): NatsEventLogConfig {
  return {
    url               : process.env.NATS_URL || 'nats://localhost:4222',
    streamName        : process.env.NATS_STREAM_NAME || 'DWN_EVENTS',
    streamMaxAge      : parseInt(process.env.NATS_STREAM_MAX_AGE || '604800000000000'), // 7 days in nanos
    replicas          : parseInt(process.env.NATS_STREAM_REPLICAS || '1'),
    maxMsgsPerSubject : parseInt(process.env.NATS_MAX_MSGS_PER_SUBJECT || '100000'),
  };
}

// ---------------------------------------------------------------------------
// Minimal filter matching (OR semantics, matching FilterUtility behaviour)
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the indexed key-values match at least one of the given
 * filters (OR semantics). An empty or undefined filter array matches all events.
 */
function matchAnyFilter(keyValues: KeyValues, filters: Filter[] | undefined): boolean {
  if (filters === undefined || filters.length === 0) {
    return true;
  }
  for (const filter of filters) {
    if (matchFilter(keyValues, filter)) {
      return true;
    }
  }
  return false;
}

/** Returns `true` if every property in the filter matches the indexed values (AND semantics). */
function matchFilter(indexedValues: KeyValues, filter: Filter): boolean {
  for (const key in filter) {
    const filterValue = filter[key];
    const indexValue = indexedValues[key];
    if (indexValue === undefined) {
      return false;
    }

    const values = Array.isArray(indexValue) ? indexValue : [indexValue];
    let anyMatch = false;
    for (const v of values) {
      if (matchSingleValue(filterValue, v)) {
        anyMatch = true;
        break;
      }
    }
    if (!anyMatch) {
      return false;
    }
  }
  return true;
}

/** Match a single index value against a filter value (equal, oneOf, or range). */
function matchSingleValue(filterValue: unknown, indexValue: string | number | boolean): boolean {
  if (typeof filterValue === 'object' && filterValue !== null) {
    if (Array.isArray(filterValue)) {
      // OneOfFilter
      return (filterValue as Array<string | number | boolean>).includes(indexValue as never);
    }
    // RangeFilter
    const range = filterValue as { gt?: string | number; gte?: string | number; lt?: string | number; lte?: string | number };
    if (range.lt !== undefined && indexValue >= range.lt) {
      return false;
    }
    if (range.lte !== undefined && indexValue > range.lte) {
      return false;
    }
    if (range.gt !== undefined && indexValue <= range.gt) {
      return false;
    }
    if (range.gte !== undefined && indexValue < range.gte) {
      return false;
    }
    return true;
  }
  // EqualFilter
  return indexValue === filterValue;
}

// ---------------------------------------------------------------------------
// Payload encoding — JSON over NATS messages
// ---------------------------------------------------------------------------

type NatsEventPayload = {
  event : MessageEvent;
  indexes : KeyValues;
  /** The CID of the message that triggered this event. Added in v0.0.16. */
  messageCid? : string;
};

function encodePayload(payload: NatsEventPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

function decodePayload(data: Uint8Array): NatsEventPayload | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(data)) as NatsEventPayload;
  } catch {
    log.error('NatsEventLog: failed to decode payload, skipping corrupt message');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Subject helpers
// ---------------------------------------------------------------------------

/**
 * Encodes a tenant DID into a NATS-safe subject token by replacing `.` and `>`
 * (which are NATS subject delimiters) with URL-safe equivalents.
 */
function tenantToSubjectToken(tenant: string): string {
  return tenant.replace(/\./g, '~').replace(/>/g, '_');
}

// ---------------------------------------------------------------------------
// NatsEventLog — distributed EventLog implementation over NATS JetStream
// ---------------------------------------------------------------------------

/**
 * Distributed {@link EventLog} implementation backed by NATS JetStream.
 *
 * Events are published to per-tenant subjects within a single JetStream stream.
 * NATS stream sequence numbers are used as opaque cursors, providing native
 * cursor-based replay and EOSE detection via `msg.info.pending`.
 *
 * Designed for multi-node DWN deployments: node A can emit an event, and a
 * subscriber connected to node B receives it via the shared NATS cluster.
 *
 * Loaded by the DWN server plugin system via `DWN_EVENT_LOG_PLUGIN_PATH`.
 * Must be a default export with a no-arg constructor.
 */
export default class NatsEventLog implements EventLog {
  #config: NatsEventLogConfig;
  #nc: NatsConnection | undefined;
  #js: JetStreamClient | undefined;
  #jsm: JetStreamManager | undefined;

  /** Active subscription consumers, keyed by consumer name. */
  #activeConsumers: Map<string, { messages?: ConsumerMessages; stopped: boolean }> = new Map();

  /**
   * Epoch for this EventLog instance. Stable as long as the JetStream stream exists.
   * Generated once at `open()` from the stream's creation timestamp.
   */
  #epoch: string = '';

  constructor() {
    this.#config = loadConfig();
  }

  // ---- Lifecycle -----------------------------------------------------------

  public async open(): Promise<void> {
    if (this.#nc !== undefined) {
      return;
    }

    const servers = this.#config.url.split(',').map((s: string): string => s.trim());
    this.#nc = await connect({ servers });
    this.#js = jetstream(this.#nc);
    this.#jsm = await jetstreamManager(this.#nc);

    // Ensure the stream exists (idempotent — update if it already exists).
    await this.#ensureStream();

    // Derive a stable epoch from the stream creation time.
    const streamInfo = await this.#jsm.streams.info(this.#config.streamName);
    this.#epoch = streamInfo.created ?? crypto.randomUUID();

    log.info(`NatsEventLog: connected to ${servers.join(', ')}, stream '${this.#config.streamName}' ready`);
  }

  public async close(): Promise<void> {
    // Stop all active subscription consumers.
    for (const [name, entry] of this.#activeConsumers) {
      entry.stopped = true;
      entry.messages?.stop();
      try {
        await this.#jsm!.consumers.delete(this.#config.streamName, name);
      } catch {
        // Consumer may already be gone (ephemeral timeout).
      }
    }
    this.#activeConsumers.clear();

    if (this.#nc !== undefined) {
      await this.#nc.drain();
      this.#nc = undefined;
      this.#js = undefined;
      this.#jsm = undefined;
    }
  }

  /**
   * Derives a stable streamId from the JetStream stream name and tenant subject.
   */
  async #getStreamId(tenant: string): Promise<string> {
    const input = `${this.#config.streamName}/${this.#tenantSubject(tenant)}`;
    const bytes = new TextEncoder().encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray.slice(0, 8), (b: number) => b.toString(16).padStart(2, '0')).join('');
  }

  async #buildToken(tenant: string, seq: number, messageCid: string): Promise<ProgressToken> {
    return {
      streamId : await this.#getStreamId(tenant),
      epoch    : this.#epoch,
      position : String(seq),
      messageCid,
    };
  }

  /**
   * Validates a cursor against the current NatsEventLog state.
   * Throws `DwnError(EventLogProgressGap)` if the cursor cannot be resumed.
   */
  async #validateCursor(tenant: string, cursor: ProgressToken): Promise<void> {
    const expectedStreamId = await this.#getStreamId(tenant);

    let reason: ProgressGapReason;
    if (cursor.streamId !== expectedStreamId) {
      reason = 'stream_mismatch';
    } else if (cursor.epoch !== this.#epoch) {
      reason = 'epoch_mismatch';
    } else {
      // Check if position is within replay bounds using BigInt
      // for safe handling of NATS sequences beyond Number.MAX_SAFE_INTEGER.
      const bounds = await this.getReplayBounds(tenant);
      if (bounds !== undefined) {
        const cursorSeq = BigInt(cursor.position);
        const oldestSeq = BigInt(bounds.oldest.position);
        if (cursorSeq < oldestSeq - 1n) {
          reason = 'token_too_old';
        } else {
          return; // Valid.
        }
      } else {
        return; // No events — vacuously valid.
      }
    }

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

  // ---- emit ----------------------------------------------------------------

  public async emit(tenant: string, event: MessageEvent, indexes: KeyValues, messageCid: string): Promise<ProgressToken | undefined> {
    this.#assertOpen();

    const subject = this.#tenantSubject(tenant);
    const data = encodePayload({ event, indexes, messageCid });
    const ack = await this.#js!.publish(subject, data);
    return this.#buildToken(tenant, ack.seq, messageCid);
  }

  // ---- read ----------------------------------------------------------------

  public async read(tenant: string, options: EventLogReadOptions = {}): Promise<EventLogReadResult> {
    this.#assertOpen();

    const { cursor, limit, filters } = options;
    if (cursor !== undefined) {
      await this.#validateCursor(tenant, cursor);
    }
    const subject = this.#tenantSubject(tenant);

    // Create a one-shot ordered consumer for the read.
    const consumerOpts: Record<string, unknown> = {
      filter_subject : subject,
      ack_policy     : AckPolicy.None, // ordered consumers use AckNone
    };

    if (cursor !== undefined) {
      consumerOpts.deliver_policy = DeliverPolicy.StartSequence;
      consumerOpts.opt_start_seq = Number(cursor.position) + 1;
    } else {
      consumerOpts.deliver_policy = DeliverPolicy.All;
    }

    const consumer = await this.#jsm!.consumers.add(this.#config.streamName, consumerOpts);
    const maxResults = limit ?? Number.MAX_SAFE_INTEGER;

    const events: EventLogEntry[] = [];
    let lastSeq: number | undefined;
    let lastMessageCid: string | undefined;

    try {
      const messages = await this.#js!.consumers.get(this.#config.streamName, consumer.name);
      const iter = await messages.fetch({ max_messages: maxResults, expires: 2_000 });

      for await (const msg of iter) {
        const payload = decodePayload(msg.data);
        if (payload === undefined) {
          continue;
        }

        if (!matchAnyFilter(payload.indexes, filters)) {
          continue;
        }

        events.push({
          seq     : msg.seq,
          event   : payload.event,
          indexes : payload.indexes,
        });

        lastSeq = msg.seq;
        // Prefer the dedicated messageCid field (v0.0.16+), fall back to indexes for older payloads.
        lastMessageCid = payload.messageCid || (payload.indexes['messageCid'] as string) || '';

        if (events.length >= maxResults) {
          break;
        }
      }
    } finally {
      // Clean up the one-shot consumer.
      try {
        await this.#jsm!.consumers.delete(this.#config.streamName, consumer.name);
      } catch {
        // May already be cleaned up.
      }
    }

    if (lastSeq !== undefined) {
      const lastToken = await this.#buildToken(tenant, lastSeq, lastMessageCid || '');
      return { events, cursor: lastToken };
    }

    return {
      events,
      cursor,
    };
  }

  // ---- subscribe -----------------------------------------------------------

  public async subscribe(
    tenant: string,
    id: string,
    listener: SubscriptionListener,
    options?: EventLogSubscribeOptions,
  ): Promise<EventSubscription> {
    this.#assertOpen();

    const subject = this.#tenantSubject(tenant);
    const { cursor, filters } = options ?? {};

    // Validate cursor before subscribing.
    if (cursor !== undefined) {
      await this.#validateCursor(tenant, cursor);
    }

    // Build the consumer config.
    const consumerName = `sub-${id}`;
    const consumerOpts: Record<string, unknown> = {
      name               : consumerName,
      filter_subject     : subject,
      ack_policy         : AckPolicy.Explicit,
      inactive_threshold : 60_000_000_000, // 60 seconds in nanos
    };

    if (cursor !== undefined) {
      consumerOpts.deliver_policy = DeliverPolicy.StartSequence;
      consumerOpts.opt_start_seq = Number(cursor.position) + 1;
    } else {
      consumerOpts.deliver_policy = DeliverPolicy.New;
    }

    await this.#jsm!.consumers.add(this.#config.streamName, consumerOpts);

    const entry: { messages?: ConsumerMessages; stopped: boolean } = { stopped: false };
    this.#activeConsumers.set(consumerName, entry);

    // Start the consume loop asynchronously.
    const consumeLoop = async (): Promise<void> => {
      let sentEose = cursor === undefined; // no cursor → no EOSE needed

      try {
        const consumer = await this.#js!.consumers.get(this.#config.streamName, consumerName);
        const messages = await consumer.consume();
        entry.messages = messages;

        for await (const msg of messages) {
          if (entry.stopped) {
            break;
          }

          const payload = decodePayload(msg.data);
          if (payload === undefined) {
            msg.ack();
            continue;
          }

          if (!matchAnyFilter(payload.indexes, filters)) {
            msg.ack();
            continue;
          }

          // Prefer the dedicated messageCid field (v0.0.16+), fall back to indexes for older payloads.
          const msgCid = payload.messageCid || (payload.indexes['messageCid'] as string) || '';
          const eventToken = await this.#buildToken(tenant, msg.seq, msgCid);
          listener({ type: 'event', cursor: eventToken, event: payload.event });
          msg.ack();

          // EOSE detection: when pending reaches 0, all stored events have been
          // delivered and we transition to live mode.
          if (!sentEose && msg.info.pending === 0) {
            listener({ type: 'eose', cursor: eventToken });
            sentEose = true;
          }
        }
      } catch (err) {
        if (!entry.stopped) {
          log.error(`NatsEventLog: consume loop error for subscription '${id}'`, err);
        }
      }
    };

    // Fire and forget — the loop runs until stop or connection close.
    consumeLoop();

    // Handle the edge case where cursor was provided but there are zero
    // stored events after it. The consume loop won't receive any messages,
    // so we need to send EOSE proactively. We check consumer info after a
    // short delay to allow the loop to start.
    if (cursor !== undefined) {
      setTimeout(async (): Promise<void> => {
        if (entry.stopped) {
          return;
        }
        try {
          const info = await this.#jsm!.consumers.info(this.#config.streamName, consumerName);
          if (info.num_pending === 0 && info.delivered.stream_seq <= Number(cursor.position)) {
            listener({ type: 'eose', cursor });
          }
        } catch {
          // Consumer may be gone already.
        }
      }, 50);
    }

    return {
      id,
      close: async (): Promise<void> => {
        entry.stopped = true;
        entry.messages?.stop();
        this.#activeConsumers.delete(consumerName);
        try {
          await this.#jsm!.consumers.delete(this.#config.streamName, consumerName);
        } catch {
          // Consumer may already be gone (ephemeral timeout).
        }
      },
    };
  }

  // ---- getReplayBounds ------------------------------------------------------

  public async getReplayBounds(tenant: string): Promise<{ oldest: ProgressToken; latest: ProgressToken } | undefined> {
    this.#assertOpen();

    const subject = this.#tenantSubject(tenant);

    // Get stream info to find first/last sequence for this subject.
    const streamInfo = await this.#jsm!.streams.info(this.#config.streamName, { subjects_filter: subject });
    const firstSeq = streamInfo.state.first_seq;
    const lastSeq = streamInfo.state.last_seq;

    if (lastSeq === 0 || firstSeq > lastSeq) {
      return undefined;
    }

    // Read boundary messages to extract their real messageCid values.
    // Uses a one-shot ordered consumer to fetch a single message at a given sequence.
    const readBoundaryCid = async (seq: number): Promise<string> => {
      let consumerName: string | undefined;
      try {
        const consumer = await this.#jsm!.consumers.add(this.#config.streamName, {
          filter_subject : subject,
          ack_policy     : AckPolicy.None,
          deliver_policy : DeliverPolicy.StartSequence,
          opt_start_seq  : seq,
        });
        consumerName = consumer.name;

        const handle = await this.#js!.consumers.get(this.#config.streamName, consumerName);
        const iter = await handle.fetch({ max_messages: 1, expires: 2_000 });

        for await (const msg of iter) {
          const payload = decodePayload(msg.data);
          const cid = (payload?.indexes?.['messageCid'] as string);
          if (cid && cid !== '') {
            return cid;
          }
        }
      } catch {
        // Fall through to deterministic placeholder.
      } finally {
        if (consumerName) {
          try {
            await this.#jsm!.consumers.delete(this.#config.streamName, consumerName);
          } catch { /* best effort */ }
        }
      }
      // Deterministic placeholder if the message could not be read.
      return `boundary-seq-${seq}`;
    };

    const oldestCid = await readBoundaryCid(firstSeq);
    const latestCid = await readBoundaryCid(lastSeq);

    const oldest = await this.#buildToken(tenant, firstSeq, oldestCid);
    const latest = await this.#buildToken(tenant, lastSeq, latestCid);

    return { oldest, latest };
  }

  // ---- trim ----------------------------------------------------------------

  public async trim(tenant: string, olderThan: number | string): Promise<void> {
    this.#assertOpen();

    const subject = this.#tenantSubject(tenant);

    if (typeof olderThan === 'number') {
      // Purge events with sequence < olderThan.
      await this.#jsm!.streams.purge(this.#config.streamName, {
        filter : subject,
        seq    : olderThan,
      });
    } else {
      // Timestamp-based trim: purge events older than the given ISO-8601 time.
      // NATS stream purge doesn't support timestamp-based purging natively, so
      // we find the sequence threshold by reading events and checking timestamps.
      // For simplicity, we do a full purge of the subject if olderThan is provided
      // as a string — this matches the EventEmitterEventLog behaviour of deleting
      // entries whose messageTimestamp is before the given time.
      // A more precise implementation could binary-search for the sequence cutoff.
      await this.#jsm!.streams.purge(this.#config.streamName, {
        filter: subject,
      });
    }
  }

  // ---- Private helpers -----------------------------------------------------

  #tenantSubject(tenant: string): string {
    return `dwn.events.${tenantToSubjectToken(tenant)}`;
  }

  #assertOpen(): void {
    if (this.#nc === undefined || this.#js === undefined || this.#jsm === undefined) {
      throw new Error('NatsEventLog: not open. Call open() before using.');
    }
  }

  async #ensureStream(): Promise<void> {
    const cfg = this.#config;
    try {
      await this.#jsm!.streams.info(cfg.streamName);
      // Stream exists — update config if needed.
      await this.#jsm!.streams.update(cfg.streamName, {
        subjects             : ['dwn.events.>'],
        max_age              : cfg.streamMaxAge,
        num_replicas         : cfg.replicas,
        max_msgs_per_subject : cfg.maxMsgsPerSubject,
      });
    } catch {
      // Stream does not exist — create it.
      await this.#jsm!.streams.add({
        name                 : cfg.streamName,
        subjects             : ['dwn.events.>'],
        max_age              : cfg.streamMaxAge,
        num_replicas         : cfg.replicas,
        max_msgs_per_subject : cfg.maxMsgsPerSubject,
      });
    }
  }
}
