import type { KeyValues } from '../types/query-types.js';
import type { EventListener, EventStream, EventSubscription, MessageEvent } from '../types/subscriptions.js';

import mitt from 'mitt';

import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

const EVENTS_LISTENER_CHANNEL = 'events';

/**
 * Payload shape used internally by mitt. We bundle the three EventListener
 * arguments into a single object because mitt emits one value per event.
 */
type EmitterPayload = { tenant: string; event: MessageEvent; indexes: KeyValues };

/**
 * mitt event map — every channel name maps to an `EmitterPayload`.
 * Using `Record<string, EmitterPayload>` lets us create channels dynamically.
 */
type EmitterEvents = Record<string, EmitterPayload>;

export interface EventEmitterStreamConfig {
  /**
   * An optional error handler in order to be able to react to any errors or warnings.
   * By default we log errors with `console.error`.
   */
  errorHandler?: (error: any) => void;
};

export class EventEmitterStream implements EventStream {
  private emitter = mitt<EmitterEvents>();
  private isOpen: boolean = false;
  private errorHandler: (error: any) => void = (error): void => { console.error('event emitter error', error); };

  constructor(config: EventEmitterStreamConfig = {}) {
    if (config.errorHandler) {
      this.errorHandler = config.errorHandler;
    }
  }

  public async subscribe(tenant: string, id: string, listener: EventListener): Promise<EventSubscription> {
    const channel = `${tenant}_${EVENTS_LISTENER_CHANNEL}`;

    // Wrap the three-arg EventListener into a single-arg mitt handler.
    const handler = (payload: EmitterPayload): void => {
      listener(payload.tenant, payload.event, payload.indexes);
    };

    this.emitter.on(channel, handler);

    return {
      id,
      close: async (): Promise<void> => { this.emitter.off(channel, handler); }
    };
  }

  public async open(): Promise<void> {
    this.isOpen = true;
  }

  public async close(): Promise<void> {
    this.isOpen = false;
    this.emitter.all.clear();
  }

  public emit(tenant: string, event: MessageEvent, indexes: KeyValues): void {
    if (!this.isOpen) {
      this.errorHandler(new DwnError(
        DwnErrorCode.EventEmitterStreamNotOpenError,
        'a message emitted when EventEmitterStream is closed'
      ));
      return;
    }
    this.emitter.emit(`${tenant}_${EVENTS_LISTENER_CHANNEL}`, { tenant, event, indexes });
  }
}
