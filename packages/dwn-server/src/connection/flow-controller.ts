import type { JsonRpcId, JsonRpcSuccessResponse } from '@enbox/dwn-clients';
import type { ProgressToken, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import log from 'loglevel';

import { createJsonRpcSuccessResponse } from '@enbox/dwn-clients';

/** Default maximum number of unacknowledged events before pausing delivery. */
export const DEFAULT_MAX_IN_FLIGHT = 32;

/** Maximum buffer size; awaited producers pause here to prevent unbounded memory growth. */
export const MAX_BUFFER_SIZE = 1000;

/** Maximum time a full buffer may wait for ACKs before its subscription closes. */
export const MAX_BUFFER_WAIT_MS = 30_000;

/**
 * Per-subscription flow controller that enforces a sliding window of
 * unacknowledged events. When the window is full, incoming events are
 * buffered. When the client sends `rpc.ack` with a cursor, events up
 * to that cursor are acknowledged and buffered events are flushed.
 *
 * Producers pause at {@link MAX_BUFFER_SIZE} until ACKs free capacity. A
 * {@link MAX_BUFFER_WAIT_MS} deadline closes stalled subscriptions. Producers
 * that push past capacity without awaiting are closed immediately.
 */
export class FlowController {
  /** Ordered list of progress tokens for events that have been sent but not yet acknowledged. */
  private unacked: ProgressToken[] = [];

  /** Buffer of events waiting to be sent once the window opens. */
  private buffer: SubscriptionMessage[] = [];

  /** Whether the controller has been closed. */
  private closed = false;

  private capacityWait?: { resume: () => void; timer: ReturnType<typeof setTimeout> };

  constructor(
    private readonly subscriptionId: JsonRpcId,
    private readonly maxInFlight: number,
    private readonly send: (response: JsonRpcSuccessResponse) => void,
    private readonly onOverflow: () => void,
  ) {}

  /**
   * Accept an incoming {@link SubscriptionMessage} from the EventLog listener.
   * If the window has room, send immediately. Otherwise buffer. At buffer
   * capacity, the producer must await the returned promise before pushing again.
   */
  public push(message: SubscriptionMessage): void | Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.unacked.length < this.maxInFlight) {
      this.sendMessage(message);
    } else {
      this.buffer.push(message);

      if (this.buffer.length > MAX_BUFFER_SIZE) {
        log.warn(
          `FlowController: buffer overflow for subscription ${String(this.subscriptionId)}, ` +
          `closing subscription (buffer=${this.buffer.length}, unacked=${this.unacked.length})`
        );
        this.fail(message, 'SubscriptionBufferOverflow', 'subscription producer exceeded the flow-control buffer capacity');
      } else if (this.buffer.length === MAX_BUFFER_SIZE) {
        // The EventLog awaits this only at capacity, letting socket ACKs catch up
        // without adding a promise or a timer to ordinary event delivery.
        return this.waitForCapacity(message);
      }
    }
  }

  /** Stops delivery and releases frames on unsubscribe, disconnect, or overflow. */
  public close(): void {
    this.closed = true;
    this.buffer = [];
    this.unacked = [];
    this.resumeCapacity();
  }

  private waitForCapacity(message: SubscriptionMessage): Promise<void> {
    let resume!: () => void;
    const promise = new Promise<void>((resolve): void => {
      resume = resolve;
    });
    const timer = setTimeout((): void => {
      log.warn(`FlowController: timed out waiting for ACKs for subscription ${String(this.subscriptionId)}`);
      this.fail(message, 'SubscriptionBufferTimeout', 'subscription ACKs did not free buffer capacity before the deadline');
    }, MAX_BUFFER_WAIT_MS);
    this.capacityWait = { resume, timer };
    return promise;
  }

  /** Ends stalled delivery and reports its terminal error outside the full ACK window. */
  private fail(message: SubscriptionMessage, code: string, detail: string): void {
    this.close();
    try {
      this.send(createJsonRpcSuccessResponse(this.subscriptionId, {
        subscription: { type: 'error', cursor: message.cursor, error: { code, detail } },
      }));
    } catch (error) {
      log.error('FlowController: unable to send terminal subscription error', error);
    } finally {
      this.onOverflow();
    }
  }

  private resumeCapacity(): void {
    if (this.capacityWait !== undefined) {
      const { resume, timer } = this.capacityWait;
      this.capacityWait = undefined;
      clearTimeout(timer);
      resume();
    }
  }

  /**
   * Process an `rpc.ack` for this subscription. Acknowledges all events up
   * to and including the given cursor, then flushes buffered events into the
   * newly opened window slots.
   */
  public ack(cursor: ProgressToken): void {
    if (this.closed) {
      return;
    }

    // Reject tokens from a different stream/epoch — these indicate a client
    // bug or a stale reconnection with an old token domain.
    if (this.unacked.length > 0) {
      const expected = this.unacked[0];
      if (cursor.streamId !== expected.streamId || cursor.epoch !== expected.epoch) {
        log.debug(
          `FlowController: rejected ack with mismatched token domain for subscription ${String(this.subscriptionId)}: ` +
          `expected streamId=${expected.streamId} epoch=${expected.epoch}, ` +
          `got streamId=${cursor.streamId} epoch=${cursor.epoch}`
        );
        return;
      }
    }

    // Find the matching token. High-water cursors may omit messageCid, so
    // those acknowledgements match by position alone within the stream domain.
    const idx = this.unacked.findIndex(
      (t) => t.position === cursor.position &&
        (cursor.messageCid === undefined || t.messageCid === cursor.messageCid)
    );
    if (idx === -1) {
      // Unknown token — could be a stale or duplicate ack. Ignore silently.
      log.debug(`FlowController: unknown cursor in ack for subscription ${String(this.subscriptionId)}: position=${cursor.position}`);
      return;
    }

    // Remove all entries up to and including the acked token.
    this.unacked.splice(0, idx + 1);

    // Flush buffered messages into the freed window slots.
    while (this.buffer.length > 0 && this.unacked.length < this.maxInFlight) {
      const buffered = this.buffer.shift()!;
      this.sendMessage(buffered);
    }
    if (this.buffer.length < MAX_BUFFER_SIZE) {
      this.resumeCapacity();
    }
  }

  /**
   * Returns the number of events currently in flight (sent but unacknowledged).
   */
  public get inFlightCount(): number {
    return this.unacked.length;
  }

  /**
   * Returns the number of events currently buffered (waiting to be sent).
   */
  public get bufferCount(): number {
    return this.buffer.length;
  }

  /**
   * Sends a single message over the wire and tracks its cursor.
   */
  private sendMessage(message: SubscriptionMessage): void {
    const response = createJsonRpcSuccessResponse(this.subscriptionId, { subscription: message });
    this.send(response);
    this.unacked.push(message.cursor);
  }
}
