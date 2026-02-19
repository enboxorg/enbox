import type { MessageStore } from '../../src/index.js';
import type { CreateLevelDatabaseOptions, LevelDatabase } from '../../src/store/level-wrapper.js';

import { createLevelDatabase } from '../../src/store/level-wrapper.js';
import { MessageStoreLevel } from '../../src/store/message-store-level.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

let messageStore: MessageStore;

describe('MessageStoreLevel Test Suite', () => {
  // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
  // so that different test suites can reuse the same backend store for testing
  beforeAll(async () => {
    messageStore = new MessageStoreLevel({
      blockstoreLocation : 'TEST-MESSAGESTORE',
      indexLocation      : 'TEST-INDEX'
    });
    await messageStore.open();
  });

  beforeEach(async () => {
    await messageStore.clear(); // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
  });

  afterAll(async () => {
    await messageStore.close();
  });

  describe('createLevelDatabase', function () {
    it('should be called if provided', async () => {
      // need to close the message store instance first before creating a new one with the same name below
      await messageStore.close();

      const locations = new Set;

      messageStore = new MessageStoreLevel({
        blockstoreLocation : 'TEST-MESSAGESTORE',
        indexLocation      : 'TEST-INDEX',
        createLevelDatabase<V>(location: string, options?: CreateLevelDatabaseOptions<V>): Promise<LevelDatabase<V>> {
          locations.add(location);
          return createLevelDatabase(location, options);
        }
      });
      await messageStore.open();

      expect(locations).toEqual(new Set([ 'TEST-MESSAGESTORE', 'TEST-INDEX' ]));
    });
  });
});
