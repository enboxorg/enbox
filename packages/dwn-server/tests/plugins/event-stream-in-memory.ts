import { EventEmitterEventLog } from '@enbox/dwn-sdk-js';
import type { EventLog } from '@enbox/dwn-sdk-js';

/**
 * An example of a plugin that is used for testing.
 * The points to note are:
 * - The class must be a default export.
 * - The constructor must not take any arguments.
 */
export default class EventLogInMemory extends EventEmitterEventLog implements EventLog {
  constructor() {
    super();

    // NOTE: the following line is added purely to test the constructor invocation.
    EventLogInMemory.spyingTheConstructor();
  }

  /**
   * NOTE: This method is introduced purely to indirectly test/spy invocation of the constructor.
   * As I was unable to find an easy way to directly spy the constructor.
   */
  public static spyingTheConstructor(): void {
  }
}
