import type { ProtocolRuleSet } from '../../src/types/protocols-types.js';

import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { getRuleSetAtPath } from '../../src/utils/protocols.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

describe('getRuleSetAtPath — fuzz', () => {

  /**
   * Arbitrary for a valid type name segment (no slashes, non-empty, no $ prefix).
   * Deliberately includes Object.prototype names like "toString" and "valueOf"
   * to verify that the function is immune to prototype pollution.
   */
  const arbTypeName = fc.string({ minLength: 1, maxLength: 10 })
    .filter((s) => !s.includes('/') && !s.startsWith('$'));

  describe('single-level path resolution', () => {
    it('should return the rule set for a root-level type', () => {
      fc.assert(
        fc.property(arbTypeName, (typeName) => {
          const ruleSet: ProtocolRuleSet = { $size: { min: 0, max: 100 } };
          const structure = { [typeName]: ruleSet };
          const result = getRuleSetAtPath(typeName, structure);
          expect(result).toBe(ruleSet);
        }),
        { numRuns }
      );
    });
  });

  describe('nested path resolution', () => {
    it('should walk nested structure segments correctly', () => {
      fc.assert(
        fc.property(
          fc.array(arbTypeName, { minLength: 2, maxLength: 4 })
            .filter((segs) => new Set(segs).size === segs.length), // unique segments
          (segments) => {
            // Build a nested structure: segments[0] > segments[1] > ... > leaf
            const leafRuleSet: ProtocolRuleSet = { $role: true };

            let current: { [key: string]: ProtocolRuleSet } = { [segments[segments.length - 1]]: leafRuleSet };
            for (let i = segments.length - 2; i >= 0; i--) {
              current = { [segments[i]]: current as unknown as ProtocolRuleSet };
            }

            const protocolPath = segments.join('/');
            const result = getRuleSetAtPath(protocolPath, current);
            expect(result).toBe(leafRuleSet);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('missing path returns undefined', () => {
    it('should return undefined for a path that does not exist', () => {
      fc.assert(
        fc.property(
          arbTypeName,
          arbTypeName.filter((s) => s !== 'existing'),
          (missingName, _otherName) => {
            const structure = { existing: { $size: { min: 0 } } as ProtocolRuleSet };
            // Only if missingName !== 'existing' will this be undefined
            if (missingName === 'existing') {
              return;
            }
            const result = getRuleSetAtPath(missingName, structure);
            expect(result).toBeUndefined();
          }
        ),
        { numRuns }
      );
    });
  });

  describe('deep missing path returns undefined', () => {
    it('should return undefined when an intermediate segment is missing', () => {
      fc.assert(
        fc.property(
          arbTypeName,
          arbTypeName,
          arbTypeName,
          (seg1, seg2, missing) => {
            // Only test when 'missing' differs from seg2 to guarantee the path doesn't exist
            if (missing === seg2) {
              return;
            }
            const structure = {
              [seg1]: {
                [seg2]: { $role: true } as ProtocolRuleSet,
              } as unknown as ProtocolRuleSet,
            };
            const result = getRuleSetAtPath(`${seg1}/${missing}`, structure);
            expect(result).toBeUndefined();
          }
        ),
        { numRuns }
      );
    });
  });

  describe('prototype pollution immunity', () => {
    it('should return undefined for Object.prototype property names not in the structure', () => {
      const prototypeNames = Object.getOwnPropertyNames(Object.prototype)
        .filter((name) => /^[a-zA-Z]+$/.test(name)); // only names valid as protocolPath segments

      const structure = { message: { $size: { min: 0 } } as ProtocolRuleSet };

      for (const name of prototypeNames) {
        const result = getRuleSetAtPath(name, structure);
        expect(result).toBeUndefined();
      }
    });
  });
});
