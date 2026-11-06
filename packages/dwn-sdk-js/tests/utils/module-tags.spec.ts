import type { RecordsWrite } from '../../src/interfaces/records-write.js';
import type { ModuleDefinition, ModuleRuleSet } from '../../src/types/modules-types.js';

import { Jws } from '../../src/utils/jws.js';
import { ModulesConfigure } from '../../src/interfaces/modules-configure.js';
import { TestDataGenerator } from './test-data-generator.js';
import { verifyTagsIfNeeded } from '../../src/core/module-authorization-validation.js';
import { describe, expect, it } from 'bun:test';
import { validateModuleTags, validateModuleTagSchemaDefinition } from '../../src/utils/module-tags.js';

async function withBlockedFunction<T>(callback: () => T | Promise<T>): Promise<T> {
  const originalFunction = globalThis.Function;
  const mutableGlobal = globalThis as { Function: FunctionConstructor };

  mutableGlobal.Function = function blockedFunction(): never {
    throw new Error('Function constructor blocked by CSP');
  } as unknown as FunctionConstructor;

  try {
    return await callback();
  } finally {
    mutableGlobal.Function = originalFunction;
  }
}

function stubRecordsWrite(ruleSetModulePath: string, tags: Record<string, unknown>): RecordsWrite {
  return {
    message: {
      descriptor: {
        module     : 'https://example.com/module',
        modulePath : ruleSetModulePath,
        tags,
      },
    },
  } as unknown as RecordsWrite;
}

describe('module tag validation', () => {
  it('validates tag schema definitions without runtime code generation', async () => {
    const schemaError = await withBlockedFunction(() => validateModuleTagSchemaDefinition(
      {
        type     : 'array',
        contains : {
          type    : 'number',
          minimum : 'ten',
        },
      },
      'foo/$tags/score',
    ));

    expect(schemaError).toBe('foo/$tags/score/contains/minimum must be number');
  });

  it('validates record tags without runtime code generation', async () => {
    const schemaError = await withBlockedFunction(() => validateModuleTags(
      {
        $requiredTags       : [ 'status' ],
        $allowUndefinedTags : false,
        status              : {
          type : 'string',
          enum : [ 'draft', 'published' ],
        },
      },
      {
        status : 'archived',
        extra  : true,
      },
      'https://example.com/module/foo/$tags',
    ));

    expect(schemaError).toContain('https://example.com/module/foo/$tags must NOT have additional properties');
    expect(schemaError).toContain('https://example.com/module/foo/$tags/status must be equal to one of the allowed values');
  });

  it('allows ModulesConfigure.create with tag schemas when unsafe-eval is unavailable', async () => {
    const alice = await TestDataGenerator.generatePersona();
    const moduleDefinition: ModuleDefinition = {
      module    : 'https://example.com/module',
      published : true,
      types     : {
        foo: {},
      },
      structure: {
        foo: {
          $tags: {
            status: {
              type : 'string',
              enum : [ 'draft', 'published' ],
            },
          },
        },
      },
    };

    const modulesConfigure = await withBlockedFunction(() => ModulesConfigure.create({
      definition : moduleDefinition,
      signer     : Jws.createSigner(alice),
    }));

    expect(modulesConfigure.message.descriptor.definition).toBeDefined();
  });

  it('allows module authorization tag checks when unsafe-eval is unavailable', async () => {
    const ruleSet: ModuleRuleSet = {
      $tags: {
        score: {
          type    : 'number',
          minimum : 0,
          maximum : 100,
        },
      },
    };

    await withBlockedFunction(() => verifyTagsIfNeeded(
      stubRecordsWrite('foo', { score: 42 }),
      ruleSet,
    ));

    await expect(withBlockedFunction(() => verifyTagsIfNeeded(
      stubRecordsWrite('foo', { score: 101 }),
      ruleSet,
    ))).rejects.toThrow('https://example.com/module/foo/$tags/score must be <= 100');
  });
});
