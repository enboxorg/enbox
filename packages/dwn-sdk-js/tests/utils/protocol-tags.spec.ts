import type { RecordsWrite } from '../../src/interfaces/records-write.js';
import type { ProtocolDefinition, ProtocolRuleSet } from '../../src/types/protocols-types.js';

import { Jws } from '../../src/utils/jws.js';
import { ProtocolsConfigure } from '../../src/interfaces/protocols-configure.js';
import { TestDataGenerator } from './test-data-generator.js';
import { verifyTagsIfNeeded } from '../../src/core/protocol-authorization-validation.js';
import { describe, expect, it } from 'bun:test';
import { validateProtocolTags, validateProtocolTagSchemaDefinition } from '../../src/utils/protocol-tags.js';

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

function stubRecordsWrite(ruleSetProtocolPath: string, tags: Record<string, unknown>): RecordsWrite {
  return {
    message: {
      descriptor: {
        protocol     : 'https://example.com/protocol',
        protocolPath : ruleSetProtocolPath,
        tags,
      },
    },
  } as unknown as RecordsWrite;
}

describe('protocol tag validation', () => {
  it('validates tag schema definitions without runtime code generation', async () => {
    const schemaError = await withBlockedFunction(() => validateProtocolTagSchemaDefinition(
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
    const schemaError = await withBlockedFunction(() => validateProtocolTags(
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
      'https://example.com/protocol/foo/$tags',
    ));

    expect(schemaError).toContain('https://example.com/protocol/foo/$tags must NOT have additional properties');
    expect(schemaError).toContain('https://example.com/protocol/foo/$tags/status must be equal to one of the allowed values');
  });

  it('allows ProtocolsConfigure.create with tag schemas when unsafe-eval is unavailable', async () => {
    const alice = await TestDataGenerator.generatePersona();
    const protocolDefinition: ProtocolDefinition = {
      protocol  : 'https://example.com/protocol',
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

    const protocolsConfigure = await withBlockedFunction(() => ProtocolsConfigure.create({
      definition : protocolDefinition,
      signer     : Jws.createSigner(alice),
    }));

    expect(protocolsConfigure.message.descriptor.definition).toBeDefined();
  });

  it('allows protocol authorization tag checks when unsafe-eval is unavailable', async () => {
    const ruleSet: ProtocolRuleSet = {
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
    ))).rejects.toThrow('https://example.com/protocol/foo/$tags/score must be <= 100');
  });
});
