import type { ProtocolsConfigureDescriptor, ProtocolsConfigureMessage } from '../../src/index.js';

import dexProtocolDefinition from '../vectors/protocol-definitions/dex.json' with { type: 'json' };
import { Jws } from '../../src/utils/jws.js';
import { ProtocolAction } from '../../src/types/protocols-types.js';
import { ProtocolsConfigure } from '../../src/interfaces/protocols-configure.js';
import { ProtocolsConfigureHandler } from '../../src/handlers/protocols-configure.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { Time } from '../../src/utils/time.js';
import { afterEach, describe, expect, it } from 'bun:test';
import { DwnErrorCode, DwnInterfaceName, DwnMethodName, Message, Protocols } from '../../src/index.js';

describe('ProtocolsConfigure', () => {
  describe('parse()', () => {
    it('should throw if protocol definitions has record nesting more than 10 level deep', async () => {
      const definition = {
        published : true,
        protocol  : 'http://example.com',
        types     : {
          foo: {},
        },
        structure: { }
      };

      // create a record hierarchy with 11 levels of nesting
      let currentLevel: any = definition.structure;
      for (let i = 0; i < 11; i++) {
        currentLevel.foo = { };
        currentLevel = currentLevel.foo;
      }

      // we need to manually created an invalid protocol definition,
      // because the SDK `create()` method will not allow us to create an invalid definition
      const descriptor: ProtocolsConfigureDescriptor = {
        interface        : DwnInterfaceName.Protocols,
        method           : DwnMethodName.Configure,
        messageTimestamp : Time.getCurrentTimestamp(),
        definition
      };

      const alice = await TestDataGenerator.generatePersona();
      const authorization = await Message.createAuthorization({
        descriptor,
        signer: Jws.createSigner(alice)
      });
      const message = { descriptor, authorization };

      const parsePromise = ProtocolsConfigure.parse(message);
      await expect(parsePromise).rejects.toThrow(DwnErrorCode.ProtocolsConfigureRecordNestingDepthExceeded);
    });
  });

  describe('create()', () => {
    it('should use `messageTimestamp` as is if given', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const currentTime = Time.getCurrentTimestamp();
      const definition = { ...dexProtocolDefinition };
      const protocolsConfigure = await ProtocolsConfigure.create({
        messageTimestamp : currentTime,
        definition,
        signer           : Jws.createSigner(alice),
      });

      expect(protocolsConfigure.message.descriptor.messageTimestamp).toBe(currentTime);
    });

    it('should include permissionGrantId in the descriptor when provided', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const grantId = 'grant-proto-789';

      const definition = { ...dexProtocolDefinition };
      const protocolsConfigure = await ProtocolsConfigure.create({
        definition,
        signer            : Jws.createSigner(alice),
        permissionGrantId : grantId,
      });

      expect(protocolsConfigure.message.descriptor.permissionGrantId).toBe(grantId);
    });

    it('should include permissionGrantId in indexes when provided', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const permissionGrantId = await TestDataGenerator.randomCborSha256Cid();

      const definition = { ...dexProtocolDefinition };
      const protocolsConfigure = await ProtocolsConfigure.create({
        definition,
        signer: Jws.createSigner(alice),
        permissionGrantId,
      });

      const indexes = ProtocolsConfigureHandler.constructIndexes(protocolsConfigure, true);
      expect(indexes.permissionGrantId).toBe(permissionGrantId);
    });

    it('should not include permissionGrantId in the descriptor when not provided', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const definition = { ...dexProtocolDefinition };
      const protocolsConfigure = await ProtocolsConfigure.create({
        definition,
        signer: Jws.createSigner(alice),
      });

      expect(protocolsConfigure.message.descriptor.permissionGrantId).toBeUndefined();
    });

    it('should auto-normalize protocol URI', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const definition = { ...dexProtocolDefinition, protocol: 'example.com/' };
      const options = {
        recipient  : alice.did,
        data       : TestDataGenerator.randomBytes(10),
        dataFormat : 'application/json',
        signer     : Jws.createSigner(alice),
        definition,
      };
      const protocolsConfig = await ProtocolsConfigure.create(options);

      const message = protocolsConfig.message as ProtocolsConfigureMessage;

      expect(message.descriptor.definition.protocol).toBe('http://example.com');
    });

    it('should auto-normalize schema URIs', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const nonNormalizedDexProtocol = { ...dexProtocolDefinition };
      nonNormalizedDexProtocol.types.ask.schema = 'ask';

      const options = {
        recipient  : alice.did,
        data       : TestDataGenerator.randomBytes(10),
        dataFormat : 'application/json',
        signer     : Jws.createSigner(alice),
        protocol   : 'example.com/',
        definition : nonNormalizedDexProtocol
      };
      const protocolsConfig = await ProtocolsConfigure.create(options);

      const message = protocolsConfig.message as ProtocolsConfigureMessage;
      expect(message.descriptor.definition.types.ask.schema).toBe('http://ask');
    });

    describe('protocol definition validations', () => {
      it('should not allow a record in protocol structure to reference a non-existent record type', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            record: {},
          },
          structure: {
            undeclaredRecord: { } // non-existent record type
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createPromise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createPromise).rejects.toThrow(DwnErrorCode.ProtocolsConfigureInvalidRuleSetRecordType);
      });

      it('should allow `role` property in an `action` to have protocol path to a role record.', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            rootRole    : {},
            firstLevel  : {},
            secondLevel : {}
          },
          structure: {
            rootRole: {
              $role       : true,
              secondLevel : {
                $actions: [{
                  role : 'rootRole', // valid because 'rootRole` has $role: true
                  can  : [ProtocolAction.Create]
                }]
              }
            },
            firstLevel: {
              $actions: [{
                role : 'rootRole', // valid because 'rootRole` has $role: true
                can  : [ProtocolAction.Create]
              }]
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(protocolsConfigure.message.descriptor.definition).toBeDefined();
      });

      it('should allow `role` property in an `action` that have protocol path to a role record.', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            thread      : {},
            participant : {},
            chat        : {}
          },
          structure: {
            thread: {
              participant: {
                $role: true,
              },
              chat: {
                $actions: [{
                  role : 'thread/participant', // valid because 'thread/participant` has $role: true
                  can  : [ProtocolAction.Create]
                }]
              }
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(protocolsConfigure.message.descriptor.definition).toBeDefined();
      });

      it('rejects protocol definitions with `role` actions that contain invalid roles', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            foo : {},
            bar : {},
          },
          structure: {
            foo: {
              // $role: true // deliberated omitted
            },
            bar: {
              $actions: [{
                role : 'foo', // foo is not a role
                can  : ['read']
              }]
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createProtocolsConfigurePromise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createProtocolsConfigurePromise)
          .rejects.toThrow(DwnErrorCode.ProtocolsConfigureRoleDoesNotExistAtGivenPath);
      });

      it('rejects protocol definitions with actions that contain `of` and  `who` is `anyone`', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            message: {},
          },
          structure: {
            message: {
              $actions: [{
                who : 'anyone',
                of  : 'message', // Not allowed
                can : ['read']
              }]
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createProtocolsConfigurePromise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createProtocolsConfigurePromise)
          .rejects.toThrow(DwnErrorCode.ProtocolsConfigureInvalidActionOfNotAllowed);
      });

      it('rejects protocol definitions with actions that have direct-recipient-can rules with actions other than delete or update', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            message: {},
          },
          structure: {
            message: {
              $actions: [{
                who : 'recipient',
                can : ['read'] // not allowed, should be either delete or update
              }]
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createProtocolsConfigurePromise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createProtocolsConfigurePromise)
          .rejects.toThrow(DwnErrorCode.ProtocolsConfigureInvalidRecipientOfAction);
      });

      it('rejects protocol definitions with actions that don\'t contain `of` and  `who` is `author`', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            message: {},
          },
          structure: {
            message: {
              $actions: [{
                who : 'author',
                // of : 'message', // Intentionally missing
                can : ['read']
              }]
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createProtocolsConfigurePromise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createProtocolsConfigurePromise)
          .rejects.toThrow(DwnErrorCode.ProtocolsConfigureInvalidActionMissingOf);
      });

      it('allows `who`-based rules with `of` that have read action', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            message: {},
          },
          structure: {
            message: {
              $actions: [{
                who : 'recipient',
                of  : 'message',
                can : ['read']
              }]
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const result = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(result).toBeDefined();
      });

      it('allows `who`-based rules with `of` that have read action alongside other actions', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            message: {},
          },
          structure: {
            message: {
              $actions: [{
                who : 'author',
                of  : 'message',
                can : ['create', 'read']
              }]
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const result = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(result).toBeDefined();
      });

      it('allows $size min and max to be set on a protocol path', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            message: {},
          },
          structure: {
            message: {
              $size: {
                min : 1,
                max : 1000
              }
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(protocolsConfigure.message.descriptor.definition).toBeDefined();
      });

      it('allows $size max to be set on a protocol path (min defaults to 0)', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            message: {},
          },
          structure: {
            message: {
              $size: {
                max: 1000
              }
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const protocolsConfigure = await ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(protocolsConfigure.message.descriptor.definition).toBeDefined();
      });

      it('rejects $size when max is less than min', async () => {
        const definition = {
          published : true,
          protocol  : 'http://example.com',
          types     : {
            message: {},
          },
          structure: {
            message: {
              $size: {
                min : 1000,
                max : 1
              }
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createProtocolsConfigurePromise = ProtocolsConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createProtocolsConfigurePromise).rejects.toThrow(DwnErrorCode.ProtocolsConfigureInvalidSize);
      });

      describe('encryptionRequired + anyone-can-read warning', () => {
        const capturedWarnings: string[] = [];
        let originalWarn: typeof console.warn;

        afterEach(() => {
          console.warn = originalWarn;
          capturedWarnings.length = 0;
        });

        it('should reject encryptionRequired: true when anyone can read at the same path', async () => {
          originalWarn = console.warn;
          console.warn = (...args: unknown[]): void => { capturedWarnings.push(String(args[0])); };

          const definition = {
            published : true,
            protocol  : 'http://example.com/encryption-warning',
            types     : {
              secret: {
                dataFormats        : ['application/json'],
                encryptionRequired : true,
              },
            },
            structure: {
              secret: {
                $actions: [
                  { who: 'anyone', can: ['read'] },
                ],
              },
            },
          };

          const alice = await TestDataGenerator.generatePersona();
          const encryptedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
            definition, alice.keyId, alice.encryptionKeyPair.privateJwk
          );

          await expect(ProtocolsConfigure.create({
            signer     : Jws.createSigner(alice),
            definition : encryptedDefinition,
          })).rejects.toThrow(DwnErrorCode.ProtocolsConfigureInvalidEncryptedAnyoneRead);
          expect(capturedWarnings.length).toBe(0);
        });

        it('should reject nested types with encryptionRequired + anyone-can-read', async () => {
          originalWarn = console.warn;
          console.warn = (...args: unknown[]): void => { capturedWarnings.push(String(args[0])); };

          const definition = {
            published : true,
            protocol  : 'http://example.com/nested-warning',
            types     : {
              thread  : { dataFormats: ['application/json'] },
              message : {
                dataFormats        : ['application/json'],
                encryptionRequired : true,
              },
            },
            structure: {
              thread: {
                $actions : [{ who: 'anyone', can: ['create'] }],
                message  : {
                  $actions: [{ who: 'anyone', can: ['create', 'read'] }],
                },
              },
            },
          };

          const alice = await TestDataGenerator.generatePersona();
          const encryptedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
            definition, alice.keyId, alice.encryptionKeyPair.privateJwk
          );

          await expect(ProtocolsConfigure.create({
            signer     : Jws.createSigner(alice),
            definition : encryptedDefinition,
          })).rejects.toThrow(DwnErrorCode.ProtocolsConfigureInvalidEncryptedAnyoneRead);
          expect(capturedWarnings.length).toBe(0);
        });

        it('should not warn when encryptionRequired is absent', async () => {
          originalWarn = console.warn;
          console.warn = (...args: unknown[]): void => { capturedWarnings.push(String(args[0])); };

          const definition = {
            published : true,
            protocol  : 'http://example.com/no-encryption',
            types     : {
              post: { dataFormats: ['application/json'] },
            },
            structure: {
              post: {
                $actions: [{ who: 'anyone', can: ['create', 'read'] }],
              },
            },
          };

          const alice = await TestDataGenerator.generatePersona();
          const encryptedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
            definition, alice.keyId, alice.encryptionKeyPair.privateJwk
          );
          const result = await ProtocolsConfigure.create({
            signer     : Jws.createSigner(alice),
            definition : encryptedDefinition,
          });

          expect(result).toBeDefined();
          expect(capturedWarnings.length).toBe(0);
        });

        it('should not warn when encryptionRequired is true but no anyone-can-read rule', async () => {
          originalWarn = console.warn;
          console.warn = (...args: unknown[]): void => { capturedWarnings.push(String(args[0])); };

          const definition = {
            published : true,
            protocol  : 'http://example.com/encryption-no-anyone',
            types     : {
              secret: {
                dataFormats        : ['application/json'],
                encryptionRequired : true,
              },
              participant: {
                dataFormats: ['application/json'],
              },
            },
            structure: {
              secret: {
                $actions: [
                  { who: 'author', of: 'secret', can: ['create', 'read'] },
                ],
                participant: {
                  $role    : true,
                  $actions : [
                    { who: 'author', of: 'secret', can: ['create', 'delete'] },
                  ],
                },
              },
            },
          };

          const alice = await TestDataGenerator.generatePersona();
          const encryptedDefinition = await Protocols.deriveAndInjectPublicEncryptionKeys(
            definition, alice.keyId, alice.encryptionKeyPair.privateJwk
          );
          const result = await ProtocolsConfigure.create({
            signer     : Jws.createSigner(alice),
            definition : encryptedDefinition,
          });

          expect(result).toBeDefined();
          expect(capturedWarnings.length).toBe(0);
        });
      });
    });
  });
});
