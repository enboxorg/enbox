import type { WakeListener } from './event-emitter-wake-publisher.js';
import type { Wake, WakePublisher, WakeSubscriber } from '../types/subscriptions.js';

import { EventEmitterWakePublisher } from './event-emitter-wake-publisher.js';

/**
 * Cross-context {@link WakePublisher} + {@link WakeSubscriber}: fans each wake
 * out to in-process listeners AND mirrors it over a named `BroadcastChannel`,
 * so sibling execution contexts sharing the same underlying store (browser
 * tabs, workers, a SharedWorker over one IndexedDB) observe each other's
 * commits immediately instead of waiting for their event log's idle re-drain.
 *
 * Wakes received from the channel are delivered to in-process listeners only
 * and never re-posted, so wakes cannot loop between contexts. Environments
 * without `BroadcastChannel` degrade to in-process-only delivery, and
 * publication stays best-effort by contract: channel failures must not affect
 * the write path that already committed the row.
 */
export class BroadcastChannelWakePublisher implements WakePublisher, WakeSubscriber {
  private readonly local = new EventEmitterWakePublisher();
  private readonly channel?: BroadcastChannel;

  /**
   * @param channelName - Channel identity. Contexts sharing one physical
   * store must use the same name; derive it from the store location so
   * distinct stores on the same origin do not cross-wake.
   */
  public constructor(channelName: string) {
    if (typeof BroadcastChannel === 'undefined') {
      return;
    }

    this.channel = new BroadcastChannel(channelName);
    // Node's channel keeps the event loop alive unless unreferenced; the
    // browser implementation has no `unref` and needs none.
    (this.channel as { unref?: () => void }).unref?.();
    this.channel.onmessage = (event: MessageEvent): void => {
      const wake = event.data as Wake | undefined;
      if (typeof wake?.tenant !== 'string' || typeof wake?.seq !== 'string') {
        return; // not a wake — ignore foreign traffic on the channel
      }
      this.local.publish(wake);
    };
  }

  public publish(wake: Wake): void {
    this.local.publish(wake);
    try {
      this.channel?.postMessage(wake);
    } catch {
      // Best-effort by contract — e.g. a closed channel.
    }
  }

  public subscribe(listener: WakeListener): () => void {
    return this.local.subscribe(listener);
  }

  public clear(): void {
    this.local.clear();
  }

  /** Releases the underlying channel. In-process delivery keeps working. */
  public close(): void {
    this.channel?.close();
  }
}
