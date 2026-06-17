import type { DurableEventLogStore, EventLog } from '../src/index.js';

import { DurableEventLog } from '../src/index.js';
import { TestStores } from './test-stores.js';

/**
 * Class that manages the EventLog implementation for testing.
 * This is the single point of configuration that allows different EventLog
 * implementations to be swapped in to test compatibility.
 */
export class TestEventLog {
  private static eventLog?: EventLog;

  /**
   * Overrides the event log with a given implementation.
   * If not given, the default durable implementation will be used.
   */
  public static override(overrides?: { eventLog?: EventLog }): void {
    TestEventLog.eventLog = overrides?.eventLog;
  }

  /**
   * Initializes and returns the event log used for running the test suite.
   */
  public static get(): EventLog {
    if (TestEventLog.eventLog === undefined) {
      const { messageStore } = TestStores.get();
      TestEventLog.eventLog = new DurableEventLog(
        messageStore as unknown as DurableEventLogStore,
        TestStores.getWakePublisher(),
        { idleRedrainIntervalMs: 0 },
      );
    }
    return TestEventLog.eventLog;
  }
}
