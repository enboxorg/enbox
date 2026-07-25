import type { JsonRpcId, JsonRpcSuccessResponse } from '@enbox/dwn-clients';
import type { ProgressToken, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import log from 'loglevel';

import { createJsonRpcSuccessResponse } from '@enbox/dwn-clients';

/** Default maximum number of unacknowledged events before pausing delivery. */
export const DEFAULT_MAX_IN_FLIGHT = 32;

/** Maximum buffer size before the subscription is force-closed to prevent OOM. */
export const MAX_BUFFER_SIZE = 1000;

/** Validates that a value is a well-formed subscription progress token. */
export function isProgressToken(value: unknown): value is ProgressToken {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const token = value as Record<string, unknown>;
  return typeof token.streamId === 'string' && token.streamId !== '' &&
    typeof token.epoch === 'string' && token.epoch !== '' &&
    typeof token.position === 'string' && token.position !== '' &&
    (token.messageCid === undefined || (typeof token.messageCid === 'string' && token.messageCid !== ''));
}

/**
 * Per-subscription flow controller that enforces a sliding window of
 * unacknowledged events. When the window is full, incoming events are
 * buffered. When the client sends `rpc.ack` with a cursor, events up
 * to that cursor are acknowledged and buffered events are flushed.
 *
 * If the buffer exceeds {@link MAX_BUFFER_SIZE}, the subscription is
 * closed via the provided `onOverflow` callback to prevent unbounded
 * memory growth.
 */
export class FlowController {
  /** Ordered list of progress tokens for events that have been sent but not yet acknowledged. */
  private unacked: ProgressToken[] = [];

  /** Buffer of events waiting to be sent once the window opens. */
  private buffer: SubscriptionMessage[] = [];

  /** Whether the controller has been closed. */
  private closed = false;

  constructor(
    private readonly subscriptionId: JsonRpcId,
    private readonly maxInFlight: number,
    private readonly send: (response: JsonRpcSuccessResponse) => void,
    private readonly onOverflow: () => void,
  ) {}

  /**
   * Accept an incoming {@link SubscriptionMessage} from the EventLog listener.
   * If the window has room, send immediately. Otherwise buffer.
   */
  public push(message: SubscriptionMessage): void {
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
        this.close();
        this.onOverflow();
      }
    }
  }

  /**
   * Process an `rpc.ack` for this subscription. Acknowledges all events up
   * to and including the given cursor, then flushes buffered events into the
   * newly opened window slots.
   */
  public ack(cursor: ProgressToken): void {
    const idx = this.findAcknowledgementIndex(cursor);
    if (idx === -1) {
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
  }

  /** Returns whether an acknowledgement would advance this flow-control window. */
  public canAcknowledge(cursor: ProgressToken): boolean {
    return this.findAcknowledgementIndex(cursor) >= 0;
  }

  /**
   * Stops delivery and releases all buffered flow-control state.
   */
  public close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.buffer = [];
    this.unacked = [];
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

  /** Finds the cumulative ACK boundary within the current progress-token domain. */
  private findAcknowledgementIndex(cursor: ProgressToken): number {
    if (this.closed || this.unacked.length === 0) {
      return -1;
    }

    const expected = this.unacked[0];
    if (cursor.streamId !== expected.streamId || cursor.epoch !== expected.epoch) {
      return -1;
    }

    // High-water cursors may omit messageCid and match by position alone.
    return this.unacked.findIndex(
      (token) => token.position === cursor.position &&
        (cursor.messageCid === undefined || token.messageCid === cursor.messageCid)
    );
  }
}
