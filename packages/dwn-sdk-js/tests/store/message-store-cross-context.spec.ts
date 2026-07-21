import { Message } from '../../src/core/message.js';
import { MessageStoreLevel } from '../../src/store/message-store-level.js';
import { Replication } from '../../src/utils/replication.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { describe, expect, it } from 'bun:test';

const isBrowserRuntime = globalThis.isSecureContext !== undefined;

describe('MessageStoreLevel cross-context writes', () => {
  it.skipIf(!isBrowserRuntime)('serializes tenant commits from two stores sharing one browser database', async () => {
    const location = `MESSAGESTORE-CROSS-CONTEXT-${TestDataGenerator.randomString(10)}`;
    const firstStore = new MessageStoreLevel({ location });
    const secondStore = new MessageStoreLevel({ location });
    const stores = [firstStore, secondStore];
    const tenant = (await TestDataGenerator.generateDidKeyPersona()).did;

    await Promise.all(stores.map((store) => store.open()));
    try {
      await firstStore.clear();
      const writes = await Promise.all(Array.from({ length: 24 }, async () => {
        const generated = await TestDataGenerator.generateRecordsWrite();
        return {
          indexes    : await generated.recordsWrite.constructIndexes(true),
          message    : generated.message,
          messageCid : await Message.getCid(generated.message),
        };
      }));

      const results = await Promise.all(writes.map(({ indexes, message }, index) =>
        stores[index % stores.length].put(tenant, message, indexes)
      ));
      const positions = results.map(({ position }) => Number(position?.position)).sort((a, b) => a - b);
      expect(positions).toEqual(Array.from({ length: writes.length }, (_, index) => index + 1));

      const { events, cursor, drained } = await firstStore.logRead(tenant);
      expect(events).toHaveLength(writes.length);
      expect(new Set(events.map(({ messageCid }) => messageCid)))
        .toEqual(new Set(writes.map(({ messageCid }) => messageCid)));
      expect(cursor?.position).toBe(String(writes.length));
      expect(drained).toBe(true);

      let expectedFingerprint = Replication.emptyFingerprint();
      for (const { messageCid } of writes) {
        expectedFingerprint = Replication.xorFingerprint(
          expectedFingerprint,
          await Replication.hashMessageCid(messageCid),
        );
      }
      expect(await firstStore.fingerprint(tenant, [Replication.globalDomain]))
        .toBe(Replication.fingerprintToHex(expectedFingerprint));
    } finally {
      await firstStore.clear();
      await Promise.all(stores.map((store) => store.close()));
    }
  });
});
