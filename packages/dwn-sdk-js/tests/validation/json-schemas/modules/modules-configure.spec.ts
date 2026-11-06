import { ModuleAction, type ModuleDefinition, type ModuleRuleSet, type ModulesConfigureMessage } from '../../../../src/types/modules-types.js';

import { Message } from '../../../../src/core/message.js';
import { Modules } from '../../../../src/utils/modules.js';
import { TestDataGenerator } from '../../../utils/test-data-generator.js';
import { validateJsonSchema } from '../../../../src/schema-validator.js';
import { describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName } from '../../../../src/index.js';

describe('ModulesConfigure schema definition', () => {
  it('should reject reserved top-level structure keys', () => {
    const moduleDefinition: ModuleDefinition = {
      module    : 'reserved-structure',
      published : true,
      types     : {
        record: {
          dataFormats : ['text/plain'],
          schema      : 'record',
        }
      },
      structure: {
        $encryption: {
          $actions: [
            {
              can : [ModuleAction.Create],
              who : 'anyone',
            }
          ]
        },
        record: {
          $actions: [
            {
              can : [ModuleAction.Create],
              who : 'anyone',
            }
          ]
        }
      }
    };

    expect(() => {
      validateJsonSchema('ModuleDefinition', moduleDefinition);
    }).toThrow();
  });

  it('should reject nested reserved structure keys', () => {
    const moduleDefinition: ModuleDefinition = {
      module    : 'reserved-nested-structure',
      published : true,
      types     : {
        child: {
          dataFormats : ['text/plain'],
          schema      : 'child',
        },
        record: {
          dataFormats : ['text/plain'],
          schema      : 'record',
        }
      },
      structure: {
        record: {
          $actions: [
            {
              can : [ModuleAction.Create],
              who : 'anyone',
            }
          ],
          $encryption: {
            $actions: [
              {
                can : [ModuleAction.Create],
                who : 'anyone',
              }
            ]
          },
          child: {
            $actions: [
              {
                can : [ModuleAction.Create],
                who : 'anyone',
              }
            ]
          }
        }
      }
    };

    expect(() => {
      validateJsonSchema('ModuleDefinition', moduleDefinition);
    }).toThrow();
  });

  it('should reject reserved type names', () => {
    const moduleDefinition: ModuleDefinition = {
      module    : 'reserved-types',
      published : true,
      types     : {
        $encryption: {
          dataFormats : ['application/json'],
          schema      : 'encryption',
        },
        record: {
          dataFormats : ['text/plain'],
          schema      : 'record',
        }
      },
      structure: {
        record: {
          $actions: [
            {
              can : [ModuleAction.Create],
              who : 'anyone',
            }
          ]
        }
      }
    };

    expect(() => {
      validateJsonSchema('ModuleDefinition', moduleDefinition);
    }).toThrow();
  });

  it('should allow encrypted module definitions after public key injection', async () => {
    const alice = await TestDataGenerator.generatePersona();
    const moduleDefinition: ModuleDefinition = {
      module    : 'encrypted-module',
      published : true,
      types     : {
        message: {
          dataFormats        : ['application/json'],
          encryptionRequired : true,
          schema             : 'message',
        },
        reply: {
          dataFormats        : ['text/plain'],
          encryptionRequired : true,
          schema             : 'reply',
        },
      },
      structure: {
        message: {
          $actions: [
            {
              can : [ModuleAction.Create],
              who : 'anyone',
            }
          ],
          reply: {
            $actions: [
              {
                can : [ModuleAction.Create],
                who : 'anyone',
              }
            ],
          },
        },
      },
    };

    const hydratedDefinition = await Modules.deriveAndInjectPublicEncryptionKeys(
      moduleDefinition,
      TestDataGenerator.createModulePathKeyDeriver('root-key-id', alice.encryptionKeyPair.privateJwk),
    );

    const messageRuleSet = hydratedDefinition.structure.message;
    const replyRuleSet = messageRuleSet.reply as ModuleRuleSet;

    expect(hydratedDefinition.$keyAgreement?.publicKeyJwk).toBeDefined();
    expect(messageRuleSet.$keyAgreement?.publicKeyJwk).toBeDefined();
    expect(replyRuleSet.$keyAgreement?.publicKeyJwk).toBeDefined();
    validateJsonSchema('ModuleDefinition', hydratedDefinition);
  });

  it('should throw if unknown actor is encountered in action rule', async () => {
    const moduleDefinition: ModuleDefinition = {
      module    : 'email',
      published : true,
      types     : {
        email: {
          schema      : 'email',
          dataFormats : ['text/plain']
        }
      },
      structure: {
        email: {
          $actions: [
            {
              who : 'unknown' as any, // intentionally invalid to test JSON Schema validation
              can : [ModuleAction.Create]
            }
          ]
        }
      }
    };

    const message: ModulesConfigureMessage = {
      descriptor: {
        interface        : DwnInterfaceName.Modules,
        method           : DwnMethodName.Configure,
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        definition       : moduleDefinition
      },
      authorization: TestDataGenerator.generateAuthorization()
    };

    expect(() => {
      Message.validateJsonSchema(message);
    }).toThrow('/$actions/0');
  });

  describe('rule-set tests', () => {
    it('#183 - should throw if required `can` is missing in rule-set', async () => {
      const invalidRuleSet1 = {
        $actions: [{
          who : 'author',
          of  : 'thread',
          // can: ['read']  // intentionally missing
        }]
      };

      const invalidRuleSet2 = {
        $actions: [{
          who : 'recipient',
          of  : 'thread',
          // can: ['read']  // intentionally missing
        }]
      };

      for (const ruleSet of [invalidRuleSet1, invalidRuleSet2]) {
        expect(() => {
          validateJsonSchema('ModuleRuleSet', ruleSet);
        }).toThrow('/$actions/0');
      }
    });
  });
});
