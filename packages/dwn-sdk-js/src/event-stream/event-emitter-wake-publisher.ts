import type { Wake, WakePublisher } from '../types/subscriptions.js';

export type WakeListener = (wake: Wake) => void;

/**
 * In-process {@link WakePublisher}. Publication is best-effort: listener
 * failures must not affect the write path that already committed the row.
 */
export class EventEmitterWakePublisher implements WakePublisher {
  private readonly listeners = new Set<WakeListener>();

  public publish(wake: Wake): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(wake);
      } catch {
        // Best-effort by contract.
      }
    }
  }

  public subscribe(listener: WakeListener): () => void {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  }

  public clear(): void {
    this.listeners.clear();
  }
}
