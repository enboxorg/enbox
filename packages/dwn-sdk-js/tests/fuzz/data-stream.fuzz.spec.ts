import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DataStream } from '../../src/utils/data-stream.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('DataStream — fuzz', () => {

  describe('fromBytes/toBytes roundtrip', () => {
    it('should return identical bytes for any Uint8Array', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 0, maxLength: 4096 }),
          async (bytes) => {
            const stream = DataStream.fromBytes(bytes);
            const result = await DataStream.toBytes(stream);
            expect(result).toEqual(bytes);
          }
        ),
        { numRuns: Math.min(numRuns, 50) }
      );
    });
  });

  describe('duplicateDataStream — count invariant', () => {
    it('should return exactly N streams for N >= 1', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 1, maxLength: 256 }),
          fc.integer({ min: 1, max: 5 }),
          async (bytes, count) => {
            const stream = DataStream.fromBytes(bytes);
            const copies = DataStream.duplicateDataStream(stream, count);
            expect(copies).toHaveLength(count);
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });

    it('should return empty array for count < 1', () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 1, maxLength: 64 }),
          fc.integer({ min: -10, max: 0 }),
          (bytes, count) => {
            const stream = DataStream.fromBytes(bytes);
            const copies = DataStream.duplicateDataStream(stream, count);
            expect(copies).toHaveLength(0);
          }
        ),
        { numRuns: Math.min(numRuns, 20) }
      );
    });
  });

  describe('duplicateDataStream — content equality', () => {
    it('should produce identical bytes from each duplicate', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 1, maxLength: 1024 }),
          fc.integer({ min: 2, max: 4 }),
          async (bytes, count) => {
            const stream = DataStream.fromBytes(bytes);
            const copies = DataStream.duplicateDataStream(stream, count);

            const results = await Promise.all(
              copies.map((s) => DataStream.toBytes(s))
            );

            for (const result of results) {
              expect(result).toEqual(bytes);
            }
          }
        ),
        { numRuns: Math.min(numRuns, 20) }
      );
    });
  });
});
