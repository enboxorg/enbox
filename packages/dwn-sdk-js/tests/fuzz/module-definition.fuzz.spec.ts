import { describe, expect, it } from 'bun:test';

import fc from 'fast-check';

import { DwnError } from '../../src/core/dwn-error.js';
import { validateJsonSchema } from '../../src/schema-validator.js';
import { adversarialModuleDefinition, moduleDefinition } from './arbitraries/module-definition.arbitrary.js';

const numRuns = Number(process.env.FAST_CHECK_NUM_RUNS) || 200;

describe('Module definition validation — fuzz', () => {

  describe('ModuleDefinition schema — crash resistance with plausible definitions', () => {
    it('should not crash on generated module definitions', () => {
      fc.assert(
        fc.property(moduleDefinition(), (definition) => {
          try {
            validateJsonSchema('ModuleDefinition', definition);
          } catch (error) {
            // Schema validation errors should always be DwnError
            expect(error).toBeInstanceOf(DwnError);
          }
        }),
        { numRuns }
      );
    });
  });

  describe('ModuleDefinition schema — crash resistance with adversarial definitions', () => {
    it('should not crash on adversarial module definitions', () => {
      fc.assert(
        fc.property(adversarialModuleDefinition(), (definition) => {
          try {
            validateJsonSchema('ModuleDefinition', definition);
          } catch (error) {
            expect(error).toBeInstanceOf(DwnError);
          }
        }),
        { numRuns }
      );
    });
  });

  describe('ModuleRuleSet schema — crash resistance', () => {
    it('should not crash on arbitrary objects validated as ModuleRuleSet', () => {
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
              validateJsonSchema('ModuleRuleSet', ruleSet);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('ModulesConfigure schema — crash resistance with full message structures', () => {
    it('should not crash on objects shaped like ModulesConfigure messages', () => {
      fc.assert(
        fc.property(
          moduleDefinition(),
          fc.string({ minLength: 10, maxLength: 50 }),
          (definition, timestamp) => {
            const message = {
              descriptor: {
                interface        : 'Modules',
                method           : 'Configure',
                messageTimestamp : timestamp,
                definition       : definition,
              },
            };
            try {
              validateJsonSchema('ModulesConfigure', message);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns }
      );
    });
  });

  describe('Module definition — deeply nested structure trees', () => {
    it('should handle deeply nested module structures without stack overflow', () => {
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
              module    : 'https://example.com/deep-module',
              published : false,
              types     : { level0: {} },
              structure : structure,
            };

            try {
              validateJsonSchema('ModuleDefinition', definition);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('Module definition — wide structure trees', () => {
    it('should handle module definitions with many types and structure entries', () => {
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
              module    : 'https://example.com/wide-module',
              published : true,
              types     : types,
              structure : structure,
            };

            try {
              validateJsonSchema('ModuleDefinition', definition);
            } catch (error) {
              expect(error).toBeInstanceOf(DwnError);
            }
          }
        ),
        { numRuns: Math.min(numRuns, 30) }
      );
    });
  });

  describe('Module definition — random action rule combinations', () => {
    it('should handle module definitions with varied action rules', () => {
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
              module    : 'https://example.com/action-test',
              published : false,
              types     : { post: {} },
              structure : {
                post: {
                  $actions: actionRules,
                },
              },
            };

            try {
              validateJsonSchema('ModuleDefinition', definition);
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
