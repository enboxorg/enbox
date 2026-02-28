import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DwnError } from '../../src/core/dwn-error.js';
import { validateJsonSchema } from '../../src/schema-validator.js';
import { adversarialProtocolDefinition, protocolDefinition } from './arbitraries/protocol-definition.arbitrary.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

describe('Protocol definition validation — fuzz', () => {

  describe('ProtocolDefinition schema — crash resistance with plausible definitions', () => {
    it('should not crash on generated protocol definitions', () => {
      fc.assert(
        fc.property(protocolDefinition(), (definition) => {
          try {
            validateJsonSchema('ProtocolDefinition', definition);
          } catch (error) {
            // Schema validation errors should always be DwnError
            expect(error).toBeInstanceOf(DwnError);
          }
        }),
        { numRuns }
      );
    });
  });

  describe('ProtocolDefinition schema — crash resistance with adversarial definitions', () => {
    it('should not crash on adversarial protocol definitions', () => {
      fc.assert(
        fc.property(adversarialProtocolDefinition(), (definition) => {
          try {
            validateJsonSchema('ProtocolDefinition', definition);
          } catch (error) {
            expect(error).toBeInstanceOf(DwnError);
          }
        }),
        { numRuns }
      );
    });
  });

  describe('ProtocolRuleSet schema — crash resistance', () => {
    it('should not crash on arbitrary objects validated as ProtocolRuleSet', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.dictionary(
              fc.string({ minLength: 1, maxLength: 20 }),
              fc.anything(),
              { minKeys: 0, maxKeys: 10 },
            ),
            fc.constant({}),
            fc.constant({ $actions: [] }),
          ),
          (ruleSet) => {
            try {
              validateJsonSchema('ProtocolRuleSet', ruleSet);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('ProtocolsConfigure schema — crash resistance with full message structures', () => {
    it('should not crash on objects shaped like ProtocolsConfigure messages', () => {
      fc.assert(
        fc.property(
          protocolDefinition(),
          fc.string({ minLength: 10, maxLength: 50 }),
          (definition, timestamp) => {
            const message = {
              descriptor: {
                interface        : 'Protocols',
                method           : 'Configure',
                messageTimestamp : timestamp,
                definition       : definition,
              },
            };
            try {
              validateJsonSchema('ProtocolsConfigure', message);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('Protocol definition — deeply nested structure trees', () => {
    it('should handle deeply nested protocol structures without stack overflow', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 50 }),
          (depth) => {
            // Build a deeply nested structure
            let structure: Record<string, unknown> = {
              $actions: [{ who: 'anyone', can: ['create'] }],
            };
            for (let i = 0; i < depth; i++) {
              structure = { [`level${i}`]: structure };
            }

            const definition = {
              protocol  : 'https://example.com/deep-protocol',
              published : false,
              types     : { level0: {} },
              structure : structure,
            };

            try {
              validateJsonSchema('ProtocolDefinition', definition);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('Protocol definition — wide structure trees', () => {
    it('should handle protocol definitions with many types and structure entries', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10, max: 50 }),
          (width) => {
            const types: Record<string, object> = {};
            const structure: Record<string, object> = {};

            for (let i = 0; i < width; i++) {
              types[`type${i}`] = {};
              structure[`type${i}`] = {
                $actions: [{ who: 'anyone', can: ['create', 'read'] }],
              };
            }

            const definition = {
              protocol  : 'https://example.com/wide-protocol',
              published : true,
              types     : types,
              structure : structure,
            };

            try {
              validateJsonSchema('ProtocolDefinition', definition);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('Protocol definition — random action rule combinations', () => {
    it('should handle protocol definitions with varied action rules', () => {
      const actors = ['anyone', 'author', 'recipient', 'unknown_actor'];
      const actions = ['create', 'read', 'update', 'delete', 'co-update', 'co-delete', 'prune', 'co-prune', 'squash', 'invalid_action'];

      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              who : fc.constantFrom(...actors),
              of  : fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
              can : fc.array(fc.constantFrom(...actions), { minLength: 1, maxLength: 5 }),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (actionRules) => {
            const definition = {
              protocol  : 'https://example.com/action-test',
              published : false,
              types     : { post: {} },
              structure : {
                post: {
                  $actions: actionRules,
                },
              },
            };

            try {
              validateJsonSchema('ProtocolDefinition', definition);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns }
      );
    });
  });
});
