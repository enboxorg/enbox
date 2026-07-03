import type { DataStore, MessageStore, ResumableTaskStore, WakePublisher } from '../src/index.js';

import { EventEmitterWakePublisher } from '../src/index.js';
import { DataStoreLevel, MessageStoreLevel, ResumableTaskStoreLevel } from '../src/store/level.js';

type WakePublisherAwareStore = {
  setWakePublisher(wakePublisher: WakePublisher | undefined): void;
};

/**
 * Class that manages store implementations for testing.
 * This is intended to be extended as the single point of configuration
 * that allows different store implementations to be swapped in
 * to test compatibility with default/built-in store implementations.
 */
export class TestStores {

  private static messageStore?: MessageStore;
  private static dataStore?: DataStore;
  private static resumableTaskStore?: ResumableTaskStore;
  private static wakePublisher?: EventEmitterWakePublisher;

  /**
   * Overrides test stores with given implementation.
   * If not given, default implementation will be used.
   */
  public static override(overrides?:{
    messageStore?: MessageStore,
    dataStore?: DataStore,
    resumableTaskStore?: ResumableTaskStore,
  }): void {
    TestStores.wakePublisher ??= new EventEmitterWakePublisher();
    TestStores.messageStore = overrides?.messageStore;
    TestStores.dataStore = overrides?.dataStore;
    TestStores.resumableTaskStore = overrides?.resumableTaskStore;
    if (TestStores.messageStore !== undefined) {
      TestStores.setWakePublisherIfSupported(TestStores.messageStore, TestStores.wakePublisher);
    }
  }

  /**
   * Initializes and return the stores used for running the test suite.
   */
  public static get(): {
    messageStore: MessageStore,
    dataStore: DataStore,
    resumableTaskStore: ResumableTaskStore,
    } {
    TestStores.wakePublisher ??= new EventEmitterWakePublisher();

    TestStores.messageStore ??= new MessageStoreLevel({
      location      : 'TEST-MESSAGESTORE',
      wakePublisher : TestStores.wakePublisher,
    });

    TestStores.dataStore ??= new DataStoreLevel({
      blockstoreLocation: 'TEST-DATASTORE'
    });

    TestStores.resumableTaskStore ??= new ResumableTaskStoreLevel({
      location: 'TEST-RESUMABLE-TASK-STORE'
    });

    return {
      messageStore       : TestStores.messageStore,
      dataStore          : TestStores.dataStore,
      resumableTaskStore : TestStores.resumableTaskStore,
    };
  }

  public static getWakePublisher(): EventEmitterWakePublisher {
    TestStores.wakePublisher ??= new EventEmitterWakePublisher();
    return TestStores.wakePublisher;
  }

  private static setWakePublisherIfSupported(store: MessageStore, wakePublisher: WakePublisher): void {
    const maybeStore = store as Partial<WakePublisherAwareStore>;
    if (typeof maybeStore.setWakePublisher === 'function') {
      maybeStore.setWakePublisher(wakePublisher);
    }
  }
}
