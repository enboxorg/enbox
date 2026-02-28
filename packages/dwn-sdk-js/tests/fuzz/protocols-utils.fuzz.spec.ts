import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { getTypeName, isCrossProtocolRef, parseCrossProtocolRef } from '../../src/utils/protocols.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('Protocol utility functions — fuzz', () => {

  describe('parseCrossProtocolRef / isCrossProtocolRef consistency', () => {
    it('should agree on whether a string is a cross-protocol reference', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 50 }),
          (ref) => {
            const parsed = parseCrossProtocolRef(ref);
            const isCross = isCrossProtocolRef(ref);
            expect(isCross).toBe(parsed !== undefined);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('parseCrossProtocolRef — roundtrip reconstruction', () => {
    it('should reconstruct the original string from alias + colon + protocolPath', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 20 }).filter((s) => !s.includes(':')),
          fc.string({ minLength: 0, maxLength: 20 }),
          (alias, path) => {
            const input = `${alias}:${path}`;
            const parsed = parseCrossProtocolRef(input);
            expect(parsed).toBeDefined();
            expect(`${parsed!.alias}:${parsed!.protocolPath}`).toBe(input);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('isCrossProtocolRef — strings without colon are never cross-protocol', () => {
    it('should return false for strings without a colon', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes(':')),
          (ref) => {
            expect(isCrossProtocolRef(ref)).toBe(false);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('getTypeName — last segment of protocol path', () => {
    it('should return the last segment after splitting on /', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !s.includes('/')),
            { minLength: 1, maxLength: 5 },
          ),
          (segments) => {
            const path = segments.join('/');
            expect(getTypeName(path)).toBe(segments[segments.length - 1]);
          }
        ),
        { numRuns }
      );
    });
  });
});
