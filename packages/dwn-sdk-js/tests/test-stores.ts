import type { DataStore, MessageStore, ResumableTaskStore } from '../src/index.js';
import { DataStoreLevel, MessageStoreLevel, ResumableTaskStoreLevel } from '../src/index.js';

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

  /**
   * Overrides test stores with given implementation.
   * If not given, default implementation will be used.
   */
  public static override(overrides?:{
    messageStore?: MessageStore,
    dataStore?: DataStore,
    resumableTaskStore?: ResumableTaskStore,
  }): void {
    TestStores.messageStore = overrides?.messageStore;
    TestStores.dataStore = overrides?.dataStore;
    TestStores.resumableTaskStore = overrides?.resumableTaskStore;
  }

  /**
   * Initializes and return the stores used for running the test suite.
   */
  public static get(): {
    messageStore: MessageStore,
    dataStore: DataStore,
    resumableTaskStore: ResumableTaskStore,
    } {
    TestStores.messageStore ??= new MessageStoreLevel({
      location: 'TEST-MESSAGESTORE'
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
}
