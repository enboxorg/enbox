import type { RecordsWrite } from '../../src/interfaces/records-write.js';
import type { RecordsWriteMessage } from '../../src/types/records-types.js';
import type { ProtocolRuleSet, ProtocolTypes } from '../../src/types/protocols-types.js';

import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DwnErrorCode } from '../../src/core/dwn-error.js';
import { getTypeName } from '../../src/utils/protocols.js';
import { verifySizeLimit, verifyType } from '../../src/core/protocol-authorization-validation.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 100;

/**
 * Builds a minimal RecordsWrite stub for verifySizeLimit testing.
 */
function stubRecordsWrite(dataSize: number): RecordsWrite {
  return {
    message: {
      descriptor: { dataSize }
    }
  } as unknown as RecordsWrite;
}

/**
 * Builds a minimal RecordsWriteMessage stub for verifyType testing.
 */
function stubRecordsWriteMessage(opts: {
  protocolPath: string;
  dataFormat: string;
  schema?: string;
}): RecordsWriteMessage {
  return {
    descriptor: {
      protocolPath : opts.protocolPath,
      dataFormat   : opts.dataFormat,
      schema       : opts.schema,
    }
  } as unknown as RecordsWriteMessage;
}

describe('Protocol validation — fuzz', () => {

  describe('verifySizeLimit — boundary behavior', () => {
    it('should accept dataSize within [min, max]', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 10000 }),
          fc.integer({ min: 0, max: 10000 }),
          (minSize, extraMax) => {
            const maxSize = minSize + extraMax; // ensures max >= min
            const dataSize = minSize + Math.floor(extraMax / 2); // dataSize in [min, max]
            const ruleSet: ProtocolRuleSet = { $size: { min: minSize, max: maxSize } };
            // Should NOT throw
            verifySizeLimit(stubRecordsWrite(dataSize), ruleSet);
          }
        ),
        { numRuns }
      );
    });

    it('should reject dataSize below min', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10000 }),
          fc.integer({ min: 0, max: 9999 }),
          (minSize, belowOffset) => {
            const dataSize = Math.max(0, minSize - 1 - (belowOffset % minSize));
            if (dataSize >= minSize) {
              return; // skip if we can't go below min
            }
            const ruleSet: ProtocolRuleSet = { $size: { min: minSize } };
            expect(() => verifySizeLimit(stubRecordsWrite(dataSize), ruleSet)).toThrow(
              DwnErrorCode.ProtocolAuthorizationMinSizeInvalid
            );
          }
        ),
        { numRuns }
      );
    });

    it('should reject dataSize above max', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 10000 }),
          fc.integer({ min: 1, max: 10000 }),
          (maxSize, overAmount) => {
            const dataSize = maxSize + overAmount;
            const ruleSet: ProtocolRuleSet = { $size: { max: maxSize } };
            expect(() => verifySizeLimit(stubRecordsWrite(dataSize), ruleSet)).toThrow(
              DwnErrorCode.ProtocolAuthorizationMaxSizeInvalid
            );
          }
        ),
        { numRuns }
      );
    });

    it('should accept any dataSize when max is undefined (only min enforced)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 1000 }),
          fc.integer({ min: 0, max: 1000000 }),
          (minSize, extra) => {
            const dataSize = minSize + extra; // always >= minSize
            const ruleSet: ProtocolRuleSet = { $size: { min: minSize } };
            // Should NOT throw — no max means no upper bound
            verifySizeLimit(stubRecordsWrite(dataSize), ruleSet);
          }
        ),
        { numRuns }
      );
    });
  });

  describe('verifyType — dataFormats and schema consistency', () => {
    it('should accept when dataFormat matches one of the allowed formats', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 3, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
          fc.nat(),
          (formats, indexSeed) => {
            const chosenFormat = formats[indexSeed % formats.length];
            const typeName = 'testType';
            const protocolTypes: ProtocolTypes = {
              [typeName]: { dataFormats: formats },
            };
            const msg = stubRecordsWriteMessage({
              protocolPath : typeName,
              dataFormat   : chosenFormat,
            });
            // Should NOT throw
            verifyType(msg, protocolTypes);
          }
        ),
        { numRuns }
      );
    });

    it('should reject when dataFormat does not match any allowed format', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 3, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
          fc.string({ minLength: 3, maxLength: 30 }),
          (formats, rogue) => {
            // Skip if rogue happens to be in the formats list
            if (formats.includes(rogue)) {
              return;
            }
            const typeName = 'testType';
            const protocolTypes: ProtocolTypes = {
              [typeName]: { dataFormats: formats },
            };
            const msg = stubRecordsWriteMessage({
              protocolPath : typeName,
              dataFormat   : rogue,
            });
            expect(() => verifyType(msg, protocolTypes)).toThrow(
              DwnErrorCode.ProtocolAuthorizationIncorrectDataFormat
            );
          }
        ),
        { numRuns }
      );
    });

    it('should accept any dataFormat when dataFormats is undefined', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 30 }),
          (dataFormat) => {
            const typeName = 'testType';
            const protocolTypes: ProtocolTypes = {
              [typeName]: {}, // no dataFormats constraint
            };
            const msg = stubRecordsWriteMessage({
              protocolPath: typeName,
              dataFormat,
            });
            // Should NOT throw
            verifyType(msg, protocolTypes);
          }
        ),
        { numRuns }
      );
    });

    it('should reject when schema does not match', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 5, maxLength: 40 }),
          fc.string({ minLength: 5, maxLength: 40 }),
          (requiredSchema, actualSchema) => {
            if (requiredSchema === actualSchema) {
              return; // skip when they match
            }
            const typeName = 'testType';
            const protocolTypes: ProtocolTypes = {
              [typeName]: { schema: requiredSchema },
            };
            const msg = stubRecordsWriteMessage({
              protocolPath : typeName,
              dataFormat   : 'application/json',
              schema       : actualSchema,
            });
            expect(() => verifyType(msg, protocolTypes)).toThrow(
              DwnErrorCode.ProtocolAuthorizationInvalidSchema
            );
          }
        ),
        { numRuns }
      );
    });

    it('should reject when typeName is not in protocolTypes', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.string({ minLength: 1, maxLength: 20 }),
          (declaredType, existingType) => {
            // Skip when the raw strings match OR when getTypeName() resolves
            // declaredType to existingType (e.g. "/~" → "~"), since verifyType
            // extracts the type name from the protocol path before comparing.
            if (declaredType === existingType || getTypeName(declaredType) === existingType) {
              return;
            }
            const protocolTypes: ProtocolTypes = {
              [existingType]: {},
            };
            const msg = stubRecordsWriteMessage({
              protocolPath : declaredType,
              dataFormat   : 'application/json',
            });
            expect(() => verifyType(msg, protocolTypes)).toThrow(
              DwnErrorCode.ProtocolAuthorizationInvalidType
            );
          }
        ),
        { numRuns }
      );
    });
  });
});
