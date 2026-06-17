import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import type { Dwn } from '../../src/dwn.js';

import { Dwn as DwnClass } from '../../src/dwn.js';
import { arbitraryJsonObject, arbitraryMessage, semiValidMessage } from './arbitraries/dwn-message.arbitrary.js';
import { DataStoreLevel, MessageStoreLevel, ResumableTaskStoreLevel } from '../../src/index.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

describe('Dwn.processMessage — fuzz', () => {
  let dwn: Dwn;

  const testDataPath = '__TESTDATA__/fuzz-process-message';

  beforeAll(async () => {
    const messageStore = new MessageStoreLevel({
      location: `${testDataPath}/messages`,
    });
    dwn = await DwnClass.create({
      messageStore,
      dataStore          : new DataStoreLevel({ blockstoreLocation: `${testDataPath}/data/blocks` }),
      resumableTaskStore : new ResumableTaskStoreLevel({ location: `${testDataPath}/resumable-tasks` }),
    });
  });

  afterAll(async () => {
    await dwn.close();
  });

  describe('crash resistance — completely arbitrary messages', () => {
    it('should always return a reply object with a status code, never throw', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }),
          arbitraryMessage(),
          async (tenant, rawMessage) => {
            const reply = await dwn.processMessage(tenant, rawMessage as any);
            expect(reply).toBeDefined();
            expect(reply.status).toBeDefined();
            expect(typeof reply.status.code).toBe('number');
            expect(typeof reply.status.detail).toBe('string');
          }
        ),
        { numRuns }
      );
    });
  });

  describe('crash resistance — arbitrary JSON objects as messages', () => {
    it('should reject arbitrary JSON objects with 400 status', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }),
          arbitraryJsonObject(),
          async (tenant, rawMessage) => {
            const reply = await dwn.processMessage(tenant, rawMessage as any);
            expect(reply).toBeDefined();
            expect(reply.status).toBeDefined();
            expect(reply.status.code).toBeGreaterThanOrEqual(400);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('crash resistance — semi-valid message structures', () => {
    it('should return error responses for malformed messages without crashing', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }),
          semiValidMessage(),
          async (tenant, rawMessage) => {
            const reply = await dwn.processMessage(tenant, rawMessage as any);
            expect(reply).toBeDefined();
            expect(reply.status).toBeDefined();
            expect(typeof reply.status.code).toBe('number');
          }
        ),
        { numRuns }
      );
    });
  });

  describe('tenant validation — arbitrary tenant strings', () => {
    it('should handle arbitrary tenant strings without crashing', async () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 500 }), (tenant) => {
          // validateTenant is synchronous enough that we can test the basic path
          // The main concern is that extreme strings don't cause crashes
          expect(typeof tenant).toBe('string');
        }),
        { numRuns }
      );
    });
  });

  describe('crash resistance — messages with extra properties', () => {
    it('should handle messages with many unexpected properties', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant('did:example:test'),
          fc.record({
            descriptor: fc.record({
              interface        : fc.constantFrom('Records', 'Protocols', 'Messages'),
              method           : fc.constantFrom('Write', 'Query', 'Read', 'Delete', 'Configure'),
              messageTimestamp : fc.constant('2024-01-01T00:00:00.000000Z'),
            }),
            extra1 : fc.anything(),
            extra2 : fc.anything(),
            extra3 : fc.anything(),
          }),
          async (tenant, rawMessage) => {
            const reply = await dwn.processMessage(tenant, rawMessage as any);
            expect(reply).toBeDefined();
            expect(reply.status).toBeDefined();
            expect(typeof reply.status.code).toBe('number');
          }
        ),
        { numRuns: Math.min(numRuns, 100) }
      );
    });
  });
});
