import type { EventLog } from '../src/index.js';

import { EventEmitterEventLog } from '../src/index.js';

/**
 * Class that manages the EventLog implementation for testing.
 * This is the single point of configuration that allows different EventLog
 * implementations to be swapped in to test compatibility.
 */
export class TestEventLog {
  private static eventLog?: EventLog;

  /**
   * Overrides the event log with a given implementation.
   * If not given, default in-memory implementation will be used.
   */
  public static override(overrides?: { eventLog?: EventLog }): void {
    TestEventLog.eventLog = overrides?.eventLog;
  }

  /**
   * Initializes and returns the event log used for running the test suite.
   */
  public static get(): EventLog {
    TestEventLog.eventLog ??= new EventEmitterEventLog();
    return TestEventLog.eventLog;
  }
}
