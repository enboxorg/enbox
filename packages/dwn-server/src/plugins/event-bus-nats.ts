import type { EventBus } from '../event-bus.js';
import type { Wake } from '@enbox/dwn-sdk-js';
import type { NatsConnection, Subscription } from '@nats-io/transport-node';

import log from 'loglevel';

import { connect } from '@nats-io/transport-node';

type NatsEventBusConfig = {
  /** NATS connection URL(s), comma-separated. */
  url : string;
  /** Subject prefix used for durable-log wake notifications. */
  subjectPrefix : string;
};

const DEFAULT_SUBJECT_PREFIX = 'dwn.wakes';

function loadConfig(): NatsEventBusConfig {
  return {
    url           : process.env.NATS_URL || 'nats://localhost:4222',
    subjectPrefix : process.env.NATS_WAKE_SUBJECT_PREFIX || DEFAULT_SUBJECT_PREFIX,
  };
}

type WakeListener = (wake: Wake) => void;

/**
 * NATS-backed {@link EventBus}.
 *
 * This plugin is only a cross-process wake transport. The durable replication
 * log, cursor validation, filtering, and replay all live in the MessageStore.
 */
export default class NatsEventBus implements EventBus {
  readonly #config: NatsEventBusConfig;
  readonly #listeners: Set<WakeListener> = new Set();
  #nc: NatsConnection | undefined;
  #subscription: Subscription | undefined;

  public constructor() {
    this.#config = loadConfig();
  }

  public async open(): Promise<void> {
    if (this.#nc !== undefined) {
      return;
    }

    const servers = this.#config.url.split(',').map((server): string => server.trim());
    this.#nc = await connect({ servers });
    this.#subscription = this.#nc.subscribe(this.#allWakesSubject());
    await this.#nc.flush();
    void this.consumeWakes(this.#subscription);

    log.info(`NatsEventBus: connected to ${servers.join(', ')}, subject '${this.#allWakesSubject()}'`);
  }

  public async close(): Promise<void> {
    this.#subscription?.unsubscribe();
    this.#subscription = undefined;
    this.#listeners.clear();

    if (this.#nc !== undefined) {
      await this.#nc.drain();
      this.#nc = undefined;
    }
  }

  public publish(wake: Wake): void {
    this.notify(wake);

    try {
      this.#nc?.publish(this.#wakeSubject(wake.tenant), encodeWake(wake));
    } catch (error) {
      log.warn('NatsEventBus: failed to publish wake', error);
    }
  }

  public subscribe(listener: WakeListener): () => void {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  }

  async consumeWakes(subscription: Subscription): Promise<void> {
    try {
      for await (const message of subscription) {
        const wake = decodeWake(message.data);
        if (wake === undefined) {
          continue;
        }

        this.notify(wake);
      }
    } catch (error) {
      log.warn('NatsEventBus: wake subscription stopped', error);
    }
  }

  private notify(wake: Wake): void {
    for (const listener of this.#listeners) {
      try {
        listener(wake);
      } catch {
        // Wake publication is best-effort by contract.
      }
    }
  }

  #allWakesSubject(): string {
    return `${this.#config.subjectPrefix}.>`;
  }

  #wakeSubject(tenant: string): string {
    return `${this.#config.subjectPrefix}.${tenantToSubjectToken(tenant)}`;
  }
}

function encodeWake(wake: Wake): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(wake));
}

function decodeWake(data: Uint8Array): Wake | undefined {
  try {
    const wake = JSON.parse(new TextDecoder().decode(data)) as Partial<Wake>;
    if (typeof wake.tenant !== 'string' || wake.tenant === '' ||
      typeof wake.seq !== 'string' || !/^\d+$/.test(wake.seq)) {
      log.warn('NatsEventBus: received malformed wake');
      return undefined;
    }

    return { tenant: wake.tenant, seq: wake.seq };
  } catch {
    log.warn('NatsEventBus: failed to decode wake');
    return undefined;
  }
}

/**
 * Encodes a tenant DID into a NATS-safe subject token by replacing subject
 * wildcard/delimiter characters with URL-safe equivalents.
 */
function tenantToSubjectToken(tenant: string): string {
  return tenant.split('.').join('~').split('>').join('_').split('*').join('-');
}
