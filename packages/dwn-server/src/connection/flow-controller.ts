import type { SubscriptionMessage } from '@enbox/dwn-sdk-js';
import type { JsonRpcId, JsonRpcSuccessResponse } from '@enbox/dwn-clients';

import log from 'loglevel';

import { createJsonRpcSuccessResponse } from '@enbox/dwn-clients';

/** Default maximum number of unacknowledged events before pausing delivery. */
export const DEFAULT_MAX_IN_FLIGHT = 32;

/** Maximum buffer size before the subscription is force-closed to prevent OOM. */
export const MAX_BUFFER_SIZE = 1000;

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
  /** Ordered list of cursors for events that have been sent but not yet acknowledged. */
  private unacked: string[] = [];

  /** Buffer of events waiting to be sent once the window opens. */
  private buffer: SubscriptionMessage[] = [];

  /** Whether the controller has been closed due to overflow. */
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
        this.closed = true;
        this.buffer = [];
        this.unacked = [];
        this.onOverflow();
      }
    }
  }

  /**
   * Process an `rpc.ack` for this subscription. Acknowledges all events up
   * to and including the given cursor, then flushes buffered events into the
   * newly opened window slots.
   */
  public ack(cursor: string): void {
    if (this.closed) {
      return;
    }

    const idx = this.unacked.lastIndexOf(cursor);
    if (idx === -1) {
      // Unknown cursor — could be a stale or duplicate ack. Ignore silently.
      log.debug(`FlowController: unknown cursor in ack for subscription ${String(this.subscriptionId)}: ${cursor}`);
      return;
    }

    // Remove all entries up to and including the acked cursor.
    this.unacked.splice(0, idx + 1);

    // Flush buffered messages into the freed window slots.
    while (this.buffer.length > 0 && this.unacked.length < this.maxInFlight) {
      const buffered = this.buffer.shift()!;
      this.sendMessage(buffered);
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
