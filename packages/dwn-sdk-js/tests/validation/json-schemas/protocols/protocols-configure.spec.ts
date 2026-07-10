import { ProtocolAction, type ProtocolDefinition, type ProtocolRuleSet, type ProtocolsConfigureMessage } from '../../../../src/types/protocols-types.js';

import { Message } from '../../../../src/core/message.js';
import { Protocols } from '../../../../src/utils/protocols.js';
import { TestDataGenerator } from '../../../utils/test-data-generator.js';
import { validateJsonSchema } from '../../../../src/schema-validator.js';
import { describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName } from '../../../../src/index.js';

describe('ProtocolsConfigure schema definition', () => {
  it('should reject reserved top-level structure keys', () => {
    const protocolDefinition: ProtocolDefinition = {
      protocol  : 'reserved-structure',
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
              can : [ProtocolAction.Create],
              who : 'anyone',
            }
          ]
        },
        record: {
          $actions: [
            {
              can : [ProtocolAction.Create],
              who : 'anyone',
            }
          ]
        }
      }
    };

    expect(() => {
      validateJsonSchema('ProtocolDefinition', protocolDefinition);
    }).toThrow();
  });

  it('should reject nested reserved structure keys', () => {
    const protocolDefinition: ProtocolDefinition = {
      protocol  : 'reserved-nested-structure',
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
              can : [ProtocolAction.Create],
              who : 'anyone',
            }
          ],
          $encryption: {
            $actions: [
              {
                can : [ProtocolAction.Create],
                who : 'anyone',
              }
            ]
          },
          child: {
            $actions: [
              {
                can : [ProtocolAction.Create],
                who : 'anyone',
              }
            ]
          }
        }
      }
    };

    expect(() => {
      validateJsonSchema('ProtocolDefinition', protocolDefinition);
    }).toThrow();
  });

  it('should reject reserved type names', () => {
    const protocolDefinition: ProtocolDefinition = {
      protocol  : 'reserved-types',
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
              can : [ProtocolAction.Create],
              who : 'anyone',
            }
          ]
        }
      }
    };

    expect(() => {
      validateJsonSchema('ProtocolDefinition', protocolDefinition);
    }).toThrow();
  });

  it('should allow encrypted protocol definitions after public key injection', async () => {
    const alice = await TestDataGenerator.generatePersona();
    const protocolDefinition: ProtocolDefinition = {
      protocol  : 'encrypted-protocol',
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
              can : [ProtocolAction.Create],
              who : 'anyone',
            }
          ],
          reply: {
            $actions: [
              {
                can : [ProtocolAction.Create],
                who : 'anyone',
              }
            ],
          },
        },
      },
    };

    const hydratedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
      protocolDefinition,
      TestDataGenerator.createProtocolPathKeyDeriver('root-key-id', alice.encryptionKeyPair.privateJwk),
    );

    const messageRuleSet = hydratedDefinition.structure.message;
    const replyRuleSet = messageRuleSet.reply as ProtocolRuleSet;

    expect(hydratedDefinition.$keyAgreement?.publicKeyJwk).toBeDefined();
    expect(messageRuleSet.$keyAgreement?.publicKeyJwk).toBeDefined();
    expect(replyRuleSet.$keyAgreement?.publicKeyJwk).toBeDefined();
    validateJsonSchema('ProtocolDefinition', hydratedDefinition);
  });

  it('should throw if unknown actor is encountered in action rule', async () => {
    const protocolDefinition: ProtocolDefinition = {
      protocol  : 'email',
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
              can : [ProtocolAction.Create]
            }
          ]
        }
      }
    };

    const message: ProtocolsConfigureMessage = {
      descriptor: {
        interface        : DwnInterfaceName.Protocols,
        method           : DwnMethodName.Configure,
        messageTimestamp : '2022-10-14T10:20:30.405060Z',
        definition       : protocolDefinition
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
          validateJsonSchema('ProtocolRuleSet', ruleSet);
        }).toThrow('/$actions/0');
      }
    });
  });
});
