import type { WakePublisher, WakeSubscriber } from '@enbox/dwn-sdk-js';

import { EventEmitterWakePublisher } from '@enbox/dwn-sdk-js';

/**
 * Server-level wake bus used by durable event logs.
 *
 * The durable replication log lives in the MessageStore. The bus only nudges
 * other server processes to drain that store from their own cursors.
 */
export interface EventBus extends WakePublisher, WakeSubscriber {
  open(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Single-process event bus for local servers and tests.
 */
export class InMemoryEventBus extends EventEmitterWakePublisher implements EventBus {
  public async open(): Promise<void> {
    // no-op
  }

  public async close(): Promise<void> {
    this.clear();
  }
}
