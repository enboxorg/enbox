import type { RecordsWriteMessage } from '../../src/types/records-types.js';

import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { verifyEqualityOfImmutableProperties } from '../../src/interfaces/records-write-query.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

/** The properties that verifyEqualityOfImmutableProperties treats as mutable. */
const mutableProps = ['dataCid', 'dataSize', 'dataFormat', 'datePublished', 'published', 'messageTimestamp', 'tags'];

/** Generates a minimal RecordsWrite descriptor with all immutable and mutable fields. */
function recordsWriteDescriptor(): fc.Arbitrary<Record<string, unknown>> {
  return fc.record({
    // Immutable fields
    interface        : fc.constant('Records'),
    method           : fc.constant('Write'),
    protocol         : fc.string({ minLength: 5, maxLength: 30 }),
    protocolPath     : fc.string({ minLength: 3, maxLength: 20 }),
    schema           : fc.string({ minLength: 5, maxLength: 30 }),
    dateCreated      : fc.constant('2024-01-01T00:00:00.000000Z'),
    // Mutable fields
    dataCid          : fc.string({ minLength: 10, maxLength: 40 }),
    dataSize         : fc.integer({ min: 0, max: 100000 }),
    dataFormat       : fc.string({ minLength: 3, maxLength: 20 }),
    messageTimestamp : fc.constant('2024-06-01T00:00:00.000000Z'),
  });
}

/** Wraps a descriptor in a minimal RecordsWriteMessage shape. */
function wrapMessage(descriptor: Record<string, unknown>): RecordsWriteMessage {
  return { descriptor } as unknown as RecordsWriteMessage;
}

describe('verifyEqualityOfImmutableProperties — fuzz', () => {

  describe('reflexivity', () => {
    it('should never throw when comparing a message with itself', () => {
      fc.assert(
        fc.property(
          recordsWriteDescriptor(),
          (descriptor) => {
            const msg = wrapMessage(descriptor);
            expect(verifyEqualityOfImmutableProperties(msg, msg)).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('symmetry', () => {
    it('should succeed in both directions when only mutable fields differ', () => {
      fc.assert(
        fc.property(
          recordsWriteDescriptor(),
          recordsWriteDescriptor(),
          (desc1, desc2) => {
            // Copy immutable fields from desc1 to desc2 so only mutable fields differ
            for (const key of Object.keys(desc1)) {
              if (!mutableProps.includes(key)) {
                desc2[key] = desc1[key];
              }
            }

            const msg1 = wrapMessage(desc1);
            const msg2 = wrapMessage(desc2);

            expect(verifyEqualityOfImmutableProperties(msg1, msg2)).toBe(true);
            expect(verifyEqualityOfImmutableProperties(msg2, msg1)).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('mutable properties are free', () => {
    it('should not throw when only mutable properties are changed', () => {
      fc.assert(
        fc.property(
          recordsWriteDescriptor(),
          fc.string({ minLength: 5, maxLength: 40 }),
          fc.integer({ min: 0, max: 100000 }),
          fc.string({ minLength: 3, maxLength: 20 }),
          (descriptor, newDataCid, newDataSize, newDataFormat) => {
            const modified = {
              ...descriptor,
              dataCid          : newDataCid,
              dataSize         : newDataSize,
              dataFormat       : newDataFormat,
              messageTimestamp : '2025-01-01T00:00:00.000000Z',
            };

            const msg1 = wrapMessage(descriptor);
            const msg2 = wrapMessage(modified);

            expect(verifyEqualityOfImmutableProperties(msg1, msg2)).toBe(true);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('immutable properties are strict', () => {
    it('should throw when any immutable property is changed', () => {
      const immutableProps = ['interface', 'method', 'protocol', 'protocolPath', 'schema', 'dateCreated'];

      fc.assert(
        fc.property(
          recordsWriteDescriptor(),
          fc.constantFrom(...immutableProps),
          fc.string({ minLength: 1, maxLength: 10 }),
          (descriptor, propToChange, newValue) => {
            // Ensure the new value is actually different
            if (descriptor[propToChange] === newValue) { return; }

            const modified = { ...descriptor, [propToChange]: newValue };

            const msg1 = wrapMessage(descriptor);
            const msg2 = wrapMessage(modified);

            expect(() => verifyEqualityOfImmutableProperties(msg1, msg2)).toThrow(
              DwnErrorCode.RecordsWriteImmutablePropertyChanged
            );
          }
        ),
        { numRuns }
      );
    });
  });
});
