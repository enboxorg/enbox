import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DwnError } from '../../src/core/dwn-error.js';
import { validateJsonSchema } from '../../src/schema-validator.js';
import { arbitraryJsonObject, semiValidMessage } from './arbitraries/dwn-message.arbitrary.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

/**
 * Schema names corresponding to the DWN message types validated during processMessage.
 * These are the keys used by Message.validateJsonSchema() (interface + method).
 */
const messageSchemaNames = [
  'RecordsWrite',
  'RecordsQuery',
  'RecordsRead',
  'RecordsDelete',
  'RecordsCount',
  'RecordsSubscribe',
  'ProtocolsConfigure',
  'ProtocolsQuery',
  'MessagesRead',
  'MessagesSubscribe',
  'MessagesSync',
];

/**
 * Additional schema names that are used for internal validation (signature payloads, JWK, permissions).
 */
const internalSchemaNames = [
  'GenericSignaturePayload',
  'RecordsWriteSignaturePayload',
  'JwkVerificationMethod',
  'PermissionGrantData',
  'PermissionRequestData',
  'PermissionRevocationData',
  'Authorization',
  'AuthorizationDelegatedGrant',
  'AuthorizationOwner',
  'GeneralJws',
];

const allSchemaNames = [...messageSchemaNames, ...internalSchemaNames];

describe('Schema validation — fuzz', () => {

  describe('validateJsonSchema — crash resistance with arbitrary JSON objects', () => {
    for (const schemaName of allSchemaNames) {
      it(`should not crash on arbitrary JSON for schema '${schemaName}'`, () => {
        fc.assert(
          fc.property(arbitraryJsonObject(), (payload) => {
            try {
              validateJsonSchema(schemaName, payload);
            } catch (error) {
              // All errors should be DwnError instances, never raw TypeError/RangeError/etc.
              expect(error).toBeInstanceOf(DwnError);
            }
          }),
          { numRuns: Math.min(numRuns, 100) }
        );
      });
    }
  });

  describe('validateJsonSchema — crash resistance with primitive values', () => {
    for (const schemaName of messageSchemaNames) {
      it(`should reject primitives for schema '${schemaName}' without crashing`, () => {
        fc.assert(
          fc.property(
            fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
            (payload) => {
              try {
                validateJsonSchema(schemaName, payload);
              } catch (error) {
                expect(error).toBeInstanceOf(DwnError);
              }
            }
          ),
          { numRuns: Math.min(numRuns, 50) }
        );
      });
    }
  });

  describe('validateJsonSchema — crash resistance with message-shaped objects', () => {
    it('should not crash on semi-valid message structures', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...messageSchemaNames),
          semiValidMessage(),
          (schemaName, message) => {
            try {
              validateJsonSchema(schemaName, message);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('validateJsonSchema — unknown schema name', () => {
    it('should throw DwnError for unknown schema names', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 50 }).filter(
            (s) => !allSchemaNames.includes(s)
          ),
          (schemaName) => {
            try {
              validateJsonSchema(schemaName, {});
              // Should have thrown
              expect(true).toBe(false);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns: Math.min(numRuns, 100) }
      );
    });
  });

  describe('validateJsonSchema — deeply nested objects', () => {
    it('should handle deeply nested structures without stack overflow', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...messageSchemaNames),
          fc.integer({ min: 5, max: 50 }),
          (schemaName, depth) => {
            // Build a deeply nested object
            let obj: Record<string, unknown> = { leaf: 'value' };
            for (let i = 0; i < depth; i++) {
              obj = { nested: obj };
            }
            try {
              validateJsonSchema(schemaName, obj);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns: Math.min(numRuns, 50) }
      );
    });
  });

  describe('validateJsonSchema — objects with many properties', () => {
    it('should handle objects with many additional properties', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...messageSchemaNames),
          fc.dictionary(
            fc.string({ minLength: 1, maxLength: 30 }),
            fc.string({ minLength: 0, maxLength: 50 }),
            { minKeys: 10, maxKeys: 50 },
          ),
          (schemaName, payload) => {
            try {
              validateJsonSchema(schemaName, payload);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns: Math.min(numRuns, 50) }
      );
    });
  });
});
