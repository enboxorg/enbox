import type { Wake, WakePublisher } from '../types/subscriptions.js';

import mitt from 'mitt';

const WAKE_CHANNEL = 'wake';

type WakeEvents = Record<string, Wake>;

export type WakeListener = (wake: Wake) => void;

/**
 * In-process {@link WakePublisher}. Publication is best-effort: listener
 * failures must not affect the write path that already committed the row.
 */
export class EventEmitterWakePublisher implements WakePublisher {
  private readonly emitter = mitt<WakeEvents>();

  public publish(wake: Wake): void {
    try {
      this.emitter.emit(WAKE_CHANNEL, wake);
    } catch {
      // Best-effort by contract.
    }
  }

  public subscribe(listener: WakeListener): () => void {
    this.emitter.on(WAKE_CHANNEL, listener);
    return (): void => { this.emitter.off(WAKE_CHANNEL, listener); };
  }

  public clear(): void {
    this.emitter.all.clear();
  }
}
