import type { ModuleDefinition, ModuleRuleSet, ModulesConfigureDescriptor, ModulesConfigureMessage } from '../../src/index.js';

import dexModuleDefinition from '../vectors/module-definitions/dex.json' with { type: 'json' };
import { Jws } from '../../src/utils/jws.js';
import { ModuleAction } from '../../src/types/modules-types.js';
import { ModulesConfigure } from '../../src/interfaces/modules-configure.js';
import { ModulesConfigureHandler } from '../../src/handlers/modules-configure.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { Time } from '../../src/utils/time.js';
import { afterEach, describe, expect, it } from 'bun:test';
import { DwnErrorCode, DwnInterfaceName, DwnMethodName, Message, Modules } from '../../src/index.js';

describe('ModulesConfigure', () => {
  describe('parse()', () => {
    it('should throw the record nesting-depth error when the pre-schema walk sees over-deep structure', async () => {
      const definition = {
        published : true,
        module    : 'http://example.com',
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

      // we need to manually created an invalid module definition,
      // because the SDK `create()` method will not allow us to create an invalid definition
      const descriptor: ModulesConfigureDescriptor = {
        interface        : DwnInterfaceName.Modules,
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

      const parsePromise = ModulesConfigure.parse(message);
      await expect(parsePromise).rejects.toThrow(DwnErrorCode.ModulesConfigureRecordNestingDepthExceeded);
    });

    it('should count empty record type names when enforcing the pre-schema nesting-depth guard', async () => {
      const definition = {
        published : true,
        module    : 'http://example.com',
        types     : {
          foo: {},
        },
        structure: { }
      };

      let currentLevel: any = definition.structure;
      for (let i = 0; i < 11; i++) {
        currentLevel[''] = { };
        currentLevel = currentLevel[''];
      }

      const descriptor: ModulesConfigureDescriptor = {
        interface        : DwnInterfaceName.Modules,
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

      const parsePromise = ModulesConfigure.parse(message);
      await expect(parsePromise).rejects.toThrow(DwnErrorCode.ModulesConfigureRecordNestingDepthExceeded);
    });

    it('should throw the record nesting-depth error before walking over-deep encryption control paths', async () => {
      const definition = {
        published : true,
        module    : 'http://example.com',
        types     : {
          foo: {},
        },
        structure: { }
      };

      let currentLevel: any = definition.structure;
      for (let i = 0; i < 11; i++) {
        currentLevel.foo = { };
        currentLevel = currentLevel.foo;
      }
      currentLevel.$encryption = { };

      const descriptor: ModulesConfigureDescriptor = {
        interface        : DwnInterfaceName.Modules,
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

      const parsePromise = ModulesConfigure.parse(message);
      await expect(parsePromise).rejects.toThrow(DwnErrorCode.ModulesConfigureRecordNestingDepthExceeded);
    });

    it('should throw the reserved encryption control error before JSON Schema validation', async () => {
      const definition = {
        published : true,
        module    : 'http://example.com',
        types     : {
          $encryption : {},
          message     : {},
        },
        structure: {
          message: {},
        },
      };

      const descriptor: ModulesConfigureDescriptor = {
        interface        : DwnInterfaceName.Modules,
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

      const parsePromise = ModulesConfigure.parse(message);
      await expect(parsePromise).rejects.toThrow(DwnErrorCode.ModulesConfigureReservedEncryptionControlPath);
    });

    it('should reject a received definition that lets anyone create role assignments', async () => {
      const definition: ModuleDefinition = {
        published : true,
        module    : 'http://example.com',
        types     : {
          member: {},
        },
        structure: {
          member: {
            $role    : true,
            $actions : [{ who: 'anyone', can: [ModuleAction.Create] }],
          },
        },
      };
      const descriptor: ModulesConfigureDescriptor = {
        interface        : DwnInterfaceName.Modules,
        method           : DwnMethodName.Configure,
        messageTimestamp : Time.getCurrentTimestamp(),
        definition,
      };
      const alice = await TestDataGenerator.generatePersona();
      const authorization = await Message.createAuthorization({
        descriptor,
        signer: Jws.createSigner(alice),
      });

      await expect(ModulesConfigure.parse({ descriptor, authorization }))
        .rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidRoleIssuance);
    });

    it('should reject a received definition with a record-limited nested role path', async () => {
      const definition: ModuleDefinition = {
        published : true,
        module    : 'http://example.com',
        types     : {
          group  : {},
          member : {},
        },
        structure: {
          group: {
            member: {
              $recordLimit : { max: 1 },
              $role        : true,
            },
          },
        },
      };
      const descriptor: ModulesConfigureDescriptor = {
        interface        : DwnInterfaceName.Modules,
        method           : DwnMethodName.Configure,
        messageTimestamp : Time.getCurrentTimestamp(),
        definition,
      };
      const alice = await TestDataGenerator.generatePersona();
      const authorization = await Message.createAuthorization({
        descriptor,
        signer: Jws.createSigner(alice),
      });

      await expect(ModulesConfigure.parse({ descriptor, authorization }))
        .rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidRoleRecordLimit);
    });
  });

  describe('create()', () => {
    it('should use `messageTimestamp` as is if given', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const currentTime = Time.getCurrentTimestamp();
      const definition = { ...dexModuleDefinition };
      const modulesConfigure = await ModulesConfigure.create({
        messageTimestamp : currentTime,
        definition,
        signer           : Jws.createSigner(alice),
      });

      expect(modulesConfigure.message.descriptor.messageTimestamp).toBe(currentTime);
    });

    it('should include permissionGrantId in the descriptor when provided', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const grantId = 'grant-module-789';

      const definition = { ...dexModuleDefinition };
      const modulesConfigure = await ModulesConfigure.create({
        definition,
        signer            : Jws.createSigner(alice),
        permissionGrantId : grantId,
      });

      expect(modulesConfigure.message.descriptor.permissionGrantId).toBe(grantId);
    });

    it('should include permissionGrantId in indexes when provided', async () => {
      const alice = await TestDataGenerator.generatePersona();
      const permissionGrantId = await TestDataGenerator.randomCborSha256Cid();

      const definition = { ...dexModuleDefinition };
      const modulesConfigure = await ModulesConfigure.create({
        definition,
        signer: Jws.createSigner(alice),
        permissionGrantId,
      });

      const indexes = ModulesConfigureHandler.constructIndexes(modulesConfigure, true);
      expect(indexes.permissionGrantId).toBe(permissionGrantId);
    });

    it('should not include permissionGrantId in the descriptor when not provided', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const definition = { ...dexModuleDefinition };
      const modulesConfigure = await ModulesConfigure.create({
        definition,
        signer: Jws.createSigner(alice),
      });

      expect(modulesConfigure.message.descriptor.permissionGrantId).toBeUndefined();
    });

    it('should auto-normalize module URI', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const definition = { ...dexModuleDefinition, module: 'example.com/' };
      const options = {
        recipient  : alice.did,
        data       : TestDataGenerator.randomBytes(10),
        dataFormat : 'application/json',
        signer     : Jws.createSigner(alice),
        definition,
      };
      const modulesConfig = await ModulesConfigure.create(options);

      const message = modulesConfig.message as ModulesConfigureMessage;

      expect(message.descriptor.definition.module).toBe('http://example.com');
    });

    it('should auto-normalize schema URIs', async () => {
      const alice = await TestDataGenerator.generatePersona();

      const nonNormalizedDexModule = { ...dexModuleDefinition };
      nonNormalizedDexModule.types.ask.schema = 'ask';

      const options = {
        recipient  : alice.did,
        data       : TestDataGenerator.randomBytes(10),
        dataFormat : 'application/json',
        signer     : Jws.createSigner(alice),
        module     : 'example.com/',
        definition : nonNormalizedDexModule
      };
      const modulesConfig = await ModulesConfigure.create(options);

      const message = modulesConfig.message as ModulesConfigureMessage;
      expect(message.descriptor.definition.types.ask.schema).toBe('http://ask');
    });

    describe('module definition validations', () => {
      it('should allow ten nested records with a role marker on the deepest record', async () => {
        const definition: ModuleDefinition = {
          published : true,
          module    : 'http://example.com',
          types     : {},
          structure : { },
        };

        let currentLevel: ModuleRuleSet = definition.structure;
        for (let i = 1; i <= 10; i++) {
          const recordType = `level${i}`;
          definition.types[recordType] = { };
          currentLevel[recordType] = { };
          currentLevel = currentLevel[recordType] as ModuleRuleSet;
        }
        currentLevel.$role = true;

        const alice = await TestDataGenerator.generatePersona();

        const modulesConfigure = await ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(modulesConfigure.message.descriptor.definition.module).toBe('http://example.com');
        expect(currentLevel.$role).toBe(true);
      });

      it('should reject module definitions with a reserved `$encryption` type', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
          types     : {
            $encryption : {},
            message     : {},
          },
          structure: {
            message: { }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createPromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createPromise).rejects.toThrow(DwnErrorCode.ModulesConfigureReservedEncryptionControlPath);
      });

      it('should reject module definitions with a reserved root `$encryption` structure path', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
          types     : {
            message: {},
          },
          structure: {
            $encryption : { },
            message     : { }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createPromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createPromise).rejects.toThrow(DwnErrorCode.ModulesConfigureReservedEncryptionControlPath);
      });

      it('should reject module definitions with a reserved nested `$encryption` structure path', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
          types     : {
            thread  : {},
            message : {},
          },
          structure: {
            thread: {
              $encryption : { },
              message     : { },
            },
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createPromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createPromise).rejects.toThrow(DwnErrorCode.ModulesConfigureReservedEncryptionControlPath);
      });

      it('should not allow a record in module structure to reference a non-existent record type', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
          types     : {
            record: {},
          },
          structure: {
            undeclaredRecord: { } // non-existent record type
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createPromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createPromise).rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidRuleSetRecordType);
      });

      it('should allow `role` property in an `action` to have module path to a role record.', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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
                  can  : [ModuleAction.Create]
                }]
              }
            },
            firstLevel: {
              $actions: [{
                role : 'rootRole', // valid because 'rootRole` has $role: true
                can  : [ModuleAction.Create]
              }]
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const modulesConfigure = await ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(modulesConfigure.message.descriptor.definition).toBeDefined();
      });

      it('should allow `role` property in an `action` that have module path to a role record.', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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
                  can  : [ModuleAction.Create]
                }]
              }
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const modulesConfigure = await ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(modulesConfigure.message.descriptor.definition).toBeDefined();
      });

      for (const initialWriteAction of [ModuleAction.Create, ModuleAction.Squash]) {
        it(`should reject a role path that allows anyone to ${initialWriteAction} an initial role record`, async () => {
          const definition: ModuleDefinition = {
            published : true,
            module    : 'http://example.com',
            types     : {
              member: {},
            },
            structure: {
              member: {
                $role    : true,
                $actions : [{ who: 'anyone', can: [initialWriteAction] }],
                ...(initialWriteAction === ModuleAction.Squash && { $squash: true }),
              },
            },
          };

          const alice = await TestDataGenerator.generatePersona();

          await expect(ModulesConfigure.create({
            signer: Jws.createSigner(alice),
            definition,
          })).rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidRoleIssuance);
        });
      }

      it('should reject unsafe role issuance at a nested module path', async () => {
        const definition: ModuleDefinition = {
          published : true,
          module    : 'http://example.com',
          types     : {
            member : {},
            thread : {},
          },
          structure: {
            thread: {
              member: {
                $role    : true,
                $actions : [{ who: 'anyone', can: [ModuleAction.Create] }],
              },
            },
          },
        };

        const alice = await TestDataGenerator.generatePersona();

        await expect(ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        })).rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidRoleIssuance);
      });

      it('should reject a record limit on a root role path', async () => {
        const definition: ModuleDefinition = {
          published : true,
          module    : 'http://example.com',
          types     : {
            member: {},
          },
          structure: {
            member: {
              $recordLimit : { max: 1 },
              $role        : true,
            },
          },
        };
        const alice = await TestDataGenerator.generatePersona();

        await expect(ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        })).rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidRoleRecordLimit);
      });

      it('should allow anyone to read a role record assigned by an authorized issuer', async () => {
        const definition: ModuleDefinition = {
          published : true,
          module    : 'http://example.com',
          types     : {
            member: {},
          },
          structure: {
            member: {
              $role    : true,
              $actions : [{ who: 'anyone', can: [ModuleAction.Read] }],
            },
          },
        };

        const alice = await TestDataGenerator.generatePersona();
        const modulesConfigure = await ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        expect(modulesConfigure.message.descriptor.definition).toBeDefined();
      });

      it('should allow a parent author to assign a contextual role', async () => {
        const definition: ModuleDefinition = {
          published : true,
          module    : 'http://example.com',
          types     : {
            member : {},
            thread : {},
          },
          structure: {
            thread: {
              $actions : [{ who: 'anyone', can: [ModuleAction.Create] }],
              member   : {
                $role    : true,
                $actions : [{ who: 'author', of: 'thread', can: [ModuleAction.Create] }],
              },
            },
          },
        };

        const alice = await TestDataGenerator.generatePersona();
        const modulesConfigure = await ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition,
        });

        expect(modulesConfigure.message.descriptor.definition).toBeDefined();
      });

      it('should allow role rules whose role parent depth matches the rule path context depth', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
          types     : {
            thread      : {},
            message     : {},
            participant : {},
          },
          structure: {
            thread: {
              message: {
                participant: {
                  $role: true,
                },
                $actions: [{
                  role : 'thread/message/participant',
                  can  : ['read']
                }]
              },
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const modulesConfigure = await ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(modulesConfigure.message.descriptor.definition).toBeDefined();
      });

      it('rejects module definitions with `role` actions that contain invalid roles', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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

        const createModulesConfigurePromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createModulesConfigurePromise)
          .rejects.toThrow(DwnErrorCode.ModulesConfigureRoleDoesNotExistAtGivenPath);
      });

      it('should reject role rules whose role parent is deeper than the rule path context', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
          types     : {
            thread      : {},
            message     : {},
            participant : {},
          },
          structure: {
            thread: {
              message: {
                participant: {
                  $role: true,
                },
              },
              $actions: [{
                role : 'thread/message/participant',
                can  : ['read']
              }]
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createModulesConfigurePromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createModulesConfigurePromise)
          .rejects.toThrow(DwnErrorCode.ModulesConfigureRoleParentContextDepthExceeded);
      });

      it('should defer cross-module role parent depth to graph resolution', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
          uses      : {
            roles: 'http://example.com/roles',
          },
          types: {
            message: {},
          },
          structure: {
            message: {
              $actions: [{
                role : 'roles:thread/message/participant',
                can  : ['read']
              }]
            }
          }
        };

        const alice = await TestDataGenerator.generatePersona();

        const createModulesConfigurePromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createModulesConfigurePromise)
          .resolves.toBeDefined();
      });

      it('rejects module definitions with actions that contain `of` and  `who` is `anyone`', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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

        const createModulesConfigurePromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createModulesConfigurePromise)
          .rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidActionOfNotAllowed);
      });

      it('rejects module definitions with actions that have direct-recipient-can rules with actions other than delete or update', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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

        const createModulesConfigurePromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createModulesConfigurePromise)
          .rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidRecipientOfAction);
      });

      it('rejects module definitions with actions that don\'t contain `of` and  `who` is `author`', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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

        const createModulesConfigurePromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createModulesConfigurePromise)
          .rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidActionMissingOf);
      });

      it('allows `who`-based rules with `of` that have read action', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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

        const result = await ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(result).toBeDefined();
      });

      it('allows `who`-based rules with `of` that have read action alongside other actions', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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

        const result = await ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(result).toBeDefined();
      });

      it('allows $size min and max to be set on a module path', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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

        const modulesConfigure = await ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(modulesConfigure.message.descriptor.definition).toBeDefined();
      });

      it('allows $size max to be set on a module path (min defaults to 0)', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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

        const modulesConfigure = await ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        expect(modulesConfigure.message.descriptor.definition).toBeDefined();
      });

      it('rejects $size when max is less than min', async () => {
        const definition = {
          published : true,
          module    : 'http://example.com',
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

        const createModulesConfigurePromise = ModulesConfigure.create({
          signer: Jws.createSigner(alice),
          definition
        });

        await expect(createModulesConfigurePromise).rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidSize);
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
            module    : 'http://example.com/encryption-warning',
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
          const encryptedDefinition = await Modules.deriveAndInjectPublicEncryptionKeys(
            definition, TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk)
          );

          await expect(ModulesConfigure.create({
            signer     : Jws.createSigner(alice),
            definition : encryptedDefinition,
          })).rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidEncryptedAnyoneRead);
          expect(capturedWarnings).toHaveLength(0);
        });

        it('should reject nested types with encryptionRequired + anyone-can-read', async () => {
          originalWarn = console.warn;
          console.warn = (...args: unknown[]): void => { capturedWarnings.push(String(args[0])); };

          const definition = {
            published : true,
            module    : 'http://example.com/nested-warning',
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
          const encryptedDefinition = await Modules.deriveAndInjectPublicEncryptionKeys(
            definition, TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk)
          );

          await expect(ModulesConfigure.create({
            signer     : Jws.createSigner(alice),
            definition : encryptedDefinition,
          })).rejects.toThrow(DwnErrorCode.ModulesConfigureInvalidEncryptedAnyoneRead);
          expect(capturedWarnings).toHaveLength(0);
        });

        it('should not warn when encryptionRequired is absent', async () => {
          originalWarn = console.warn;
          console.warn = (...args: unknown[]): void => { capturedWarnings.push(String(args[0])); };

          const definition = {
            published : true,
            module    : 'http://example.com/no-encryption',
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
          const encryptedDefinition = await Modules.deriveAndInjectPublicEncryptionKeys(
            definition, TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk)
          );
          const result = await ModulesConfigure.create({
            signer     : Jws.createSigner(alice),
            definition : encryptedDefinition,
          });

          expect(result).toBeDefined();
          expect(capturedWarnings).toHaveLength(0);
        });

        it('should not warn when encryptionRequired is true but no anyone-can-read rule', async () => {
          originalWarn = console.warn;
          console.warn = (...args: unknown[]): void => { capturedWarnings.push(String(args[0])); };

          const definition = {
            published : true,
            module    : 'http://example.com/encryption-no-anyone',
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
          const encryptedDefinition = await Modules.deriveAndInjectPublicEncryptionKeys(
            definition, TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk)
          );
          const result = await ModulesConfigure.create({
            signer     : Jws.createSigner(alice),
            definition : encryptedDefinition,
          });

          expect(result).toBeDefined();
          expect(capturedWarnings).toHaveLength(0);
        });

        it('should defer foreign encrypted read-role validation until the installed graph is available', async () => {
          originalWarn = console.warn;
          console.warn = (...args: unknown[]): void => { capturedWarnings.push(String(args[0])); };

          const definition = {
            published : true,
            module    : 'http://example.com/encrypted-cross-module-read',
            uses      : {
              roles: 'http://example.com/roles',
            },
            types: {
              secret: {
                dataFormats        : ['application/json'],
                encryptionRequired : true,
              },
            },
            structure: {
              secret: {
                $actions: [
                  { role: 'roles:member', can: ['read'] },
                ],
              },
            },
          };

          const alice = await TestDataGenerator.generatePersona();
          const encryptedDefinition = await Modules.deriveAndInjectPublicEncryptionKeys(
            definition, TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk)
          );

          await expect(ModulesConfigure.create({
            signer     : Jws.createSigner(alice),
            definition : encryptedDefinition,
          })).resolves.toBeDefined();
          expect(capturedWarnings).toHaveLength(0);
        });
      });
    });
  });
});
