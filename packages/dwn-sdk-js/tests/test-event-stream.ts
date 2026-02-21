import type { EventLog, EventStream } from '../src/index.js';

import { EventEmitterEventLog, EventEmitterStream } from '../src/index.js';

/**
 * Class that manages the EventStream implementation for testing.
 * This is intended to be extended as the single point of configuration
 * that allows different EventStream implementations to be swapped in
 * to test compatibility with default/built-in implementation.
 *
 * @deprecated Use {@link TestEventLog} for new tests.
 */
export class TestEventStream {
  private static eventStream?: EventStream;

  /**
   * Overrides the event stream with a given implementation.
   * If not given, default implementation will be used.
   */
  public static override(overrides?: { eventStream?: EventStream }): void {
    TestEventStream.eventStream = overrides?.eventStream;
  }

  /**
   * Initializes and returns the event stream used for running the test suite.
   */
  public static get(): EventStream {
    TestEventStream.eventStream ??= new EventEmitterStream();
    return TestEventStream.eventStream;
  }
}

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