import type { DerivedPrivateJwk } from '../../src/utils/hd-key.js';
import type { DidResolver } from '@enbox/dids';
import type { DataStore, MessageStore, RecordsCountReply, RecordsReadReply, RecordsSubscribeReply, ResumableTaskStore } from '../../src/index.js';
import type { EventLog, SubscriptionMessage } from '../../src/types/subscriptions.js';
import type { ModuleDefinition, ModuleRuleSet } from '../../src/types/modules-types.js';
import type { PrivateKeyJwk, PublicKeyJwk } from '../../src/types/jose-types.js';

import sinon from 'sinon';

import { DataStream } from '../../src/utils/data-stream.js';
import { Dwn } from '../../src/dwn.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Jws } from '../../src/utils/jws.js';
import { Modules } from '../../src/utils/modules.js';
import { Poller } from '../utils/poller.js';
import { Records } from '../../src/utils/records.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { X25519 } from '@enbox/crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnErrorCode, Message, ModulesConfigure, RecordsCount, RecordsDelete, RecordsQuery, RecordsRead, RecordsSubscribe, Time } from '../../src/index.js';
import { HdKey, KeyDerivationScheme } from '../../src/utils/hd-key.js';

/**
 * Tests for module composition using `uses` + `$ref`.
 */
export function testModuleComposition(): void {
  describe('Module composition', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    beforeAll(async () => {
      didResolver = new UniversalResolver({ didResolvers: [DidKey] });

      const stores = TestStores.get();
      messageStore = stores.messageStore;
      dataStore = stores.dataStore;
      resumableTaskStore = stores.resumableTaskStore;
      eventLog = TestEventLog.get();

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, eventLog, resumableTaskStore });
    });

    beforeEach(async () => {
      sinon.restore();
      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();
    });

    afterAll(async () => {
      await dwn.close();
    });

    // =========================================================================
    // Module definitions for tests
    // =========================================================================

    const threadsModule: ModuleDefinition = {
      module    : 'https://threads.example.com',
      published : true,
      types     : {
        thread      : { schema: 'https://threads.example.com/schemas/thread', dataFormats: ['application/json'] },
        participant : { schema: 'https://threads.example.com/schemas/participant', dataFormats: ['application/json'] },
        message     : { schema: 'https://threads.example.com/schemas/message', dataFormats: ['application/json'] },
      },
      structure: {
        thread: {
          $actions: [
            { who: 'anyone', can: ['create', 'read'] }
          ],
          participant: {
            $role    : true,
            $actions : [
              { who: 'anyone', can: ['read'] },
              { who: 'author', of: 'thread', can: ['create'] },
            ],
          },
          message: {
            $actions: [
              { role: 'thread/participant', can: ['create', 'read'] },
            ],
          },
        },
      },
    };

    const commentsModule: ModuleDefinition = {
      module    : 'https://comments.example.com',
      published : true,
      uses      : {
        threads: 'https://threads.example.com',
      },
      types: {
        comment  : { schema: 'https://comments.example.com/schemas/comment', dataFormats: ['application/json'] },
        reaction : { schema: 'https://comments.example.com/schemas/reaction', dataFormats: ['application/json'] },
      },
      structure: {
        thread: {
          $ref    : 'threads:thread',
          comment : {
            $actions: [
              { who: 'anyone', can: ['create', 'read'] },
              { role: 'threads:thread/participant', can: ['read', 'co-delete'] },
            ],
            reaction: {
              $actions: [
                { who: 'anyone', can: ['create', 'read'] },
              ],
            },
          },
        },
      },
    };

    // =========================================================================
    // Validation tests (ModulesConfigure)
    // =========================================================================

    describe('ModulesConfigure validation', () => {
      it('should accept a valid module definition with `uses` and `$ref`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const modulesConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });

        expect(modulesConfigure.message.descriptor.definition.uses).toEqual({
          threads: 'https://threads.example.com',
        });
      });

      it('should reject `uses` alias that does not match naming pattern (bypassing JSON schema)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // The JSON schema enforces alias naming via `patternProperties` + `additionalProperties: false`,
        // which means invalid aliases like '123invalid' are caught by JSON schema before the code-level
        // `validateUses()` check. To exercise the code-level `ModulesConfigureInvalidUsesAlias` error,
        // we must stub `Message.validateJsonSchema` to bypass JSON schema validation.
        sinon.stub(Message, 'validateJsonSchema');

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { '123invalid': 'https://foo.example.com' } as any,
          types     : {},
          structure : {},
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ModulesConfigureInvalidUsesAlias);
        }
      });

      it('should reject `$ref` with alias not in `uses`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : {
            foo: 'https://foo.example.com',
          },
          types     : { comment: {} },
          structure : {
            thread: {
              $ref    : 'nonexistent:thread', // alias 'nonexistent' not in uses
              comment : {
                $actions: [{ who: 'anyone', can: ['create'] }],
              },
            },
          },
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ModulesConfigureInvalidRefAlias);
        }
      });

      it('should reject `$ref` node with `$actions`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : { comment: {} },
          structure : {
            thread: {
              $ref     : 'threads:thread',
              $actions : [{ who: 'anyone', can: ['read'] }], // not allowed on $ref node
              comment  : {
                $actions: [{ who: 'anyone', can: ['create'] }],
              },
            },
          },
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ModulesConfigureInvalidRefNodeHasDirectives);
        }
      });

      it('should reject `$ref` node with `$role`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {},
          structure : {
            thread: {
              $ref  : 'threads:thread',
              $role : true, // not allowed on $ref node
            },
          },
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ModulesConfigureInvalidRefNodeHasDirectives);
        }
      });

      it('should reject cross-module `role` with alias not in `uses`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : { comment: {} },
          structure : {
            thread: {
              $ref    : 'threads:thread',
              comment : {
                $actions: [
                  { role: 'nonexistent:thread/participant', can: ['read'] }, // alias 'nonexistent' not in uses
                ],
              },
            },
          },
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ModulesConfigureInvalidCrossModuleRole);
        }
      });

      it('should reject `uses` with invalid module URL', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { threads: '::invalid::' },
          types     : {},
          structure : {},
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ModulesConfigureInvalidUsesModuleUrl);
        }
      });

      it('should accept `$ref` referencing a multi-segment path in the referenced module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // The root-only constraint means `$ref` must appear at the root of the composing structure,
        // but the REFERENCED path can be multi-segment (e.g., 'thread/participant').
        const definition: ModuleDefinition = {
          module    : 'https://deep-ref.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            note: { schema: 'https://deep-ref.example.com/schemas/note', dataFormats: ['application/json'] },
          },
          structure: {
            participant: {
              $ref : 'threads:thread/participant', // multi-segment referenced path
              note : {
                $actions: [{ who: 'anyone', can: ['create', 'read'] }],
              },
            },
          },
        };

        // ModulesConfigure.create() should succeed — the $ref is at root level
        const modulesConfigure = await ModulesConfigure.create({
          definition,
          signer: Jws.createSigner(alice),
        });
        expect(modulesConfigure.message.descriptor.definition.uses).toBeDefined();

        // Install-time validation should also succeed when the referenced module is installed
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const installReply = await dwn.processMessage(alice.did, modulesConfigure.message);
        expect(installReply.status.code).toBe(202);
      });

      it('should not require `$ref` types in local types map', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // 'thread' is NOT in the local `types` — it comes from the $ref
        const definition: ModuleDefinition = {
          module    : 'https://comments.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : { comment: {} }, // no 'thread' type
          structure : {
            thread: {
              $ref    : 'threads:thread',
              comment : {
                $actions: [{ who: 'anyone', can: ['create'] }],
              },
            },
          },
        };

        // should succeed without error
        const modulesConfigure = await ModulesConfigure.create({
          definition,
          signer: Jws.createSigner(alice),
        });
        expect(modulesConfigure.message.descriptor.definition.uses).toBeDefined();
      });
    });

    // =========================================================================
    // Install-time validation tests (handler)
    // =========================================================================

    describe('install-time composition dependency validation', () => {
      it('should reject composing module if `uses` module is not installed', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Try to install comments module WITHOUT installing threads first
        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });

        const reply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ModulesConfigureComposedModuleNotInstalled);
      });

      it('should accept composing module when `uses` module is already installed', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install threads module first
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        const threadsReply = await dwn.processMessage(alice.did, threadsConfigure.message);
        expect(threadsReply.status.code).toBe(202);

        // Now install comments module — should succeed
        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).toBe(202);
      });

      it('should reject composing module if `$ref` path does not exist in referenced module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install threads module first
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        // Install a composing module that references a non-existent type path
        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : { comment: {} },
          structure : {
            nonexistent: {
              $ref    : 'threads:nonexistent', // 'nonexistent' doesn't exist in threads module
              comment : {
                $actions: [{ who: 'anyone', can: ['create'] }],
              },
            },
          },
        };

        const badConfigure = await ModulesConfigure.create({
          definition : badDefinition,
          signer     : Jws.createSigner(alice),
        });
        const reply = await dwn.processMessage(alice.did, badConfigure.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ModulesConfigureInvalidRefModulePath);
      });

      it('should reject composing module if cross-module `of` path does not exist in referenced module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install threads module first
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        // Install a composing module with an `of` reference to a non-existent path
        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : { action: {} },
          structure : {
            thread: {
              $ref   : 'threads:thread',
              action : {
                $actions: [
                  { who: 'author', of: 'threads:nonexistent', can: ['create'] },
                ],
              },
            },
          },
        };

        const badConfigure = await ModulesConfigure.create({
          definition : badDefinition,
          signer     : Jws.createSigner(alice),
        });
        const reply = await dwn.processMessage(alice.did, badConfigure.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ModulesConfigureInvalidCrossModuleOf);
      });

      it('should reject composing module if cross-module role does not exist in referenced module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install threads module first
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        // Install a composing module with invalid cross-module role
        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : { comment: {} },
          structure : {
            thread: {
              $ref    : 'threads:thread',
              comment : {
                $actions: [
                  { who: 'anyone', can: ['create'] },
                  { role: 'threads:thread/nonexistent', can: ['read'] }, // path exists but not a role
                ],
              },
            },
          },
        };

        const badConfigure = await ModulesConfigure.create({
          definition : badDefinition,
          signer     : Jws.createSigner(alice),
        });
        const reply = await dwn.processMessage(alice.did, badConfigure.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ModulesConfigureInvalidCrossModuleRole);
      });
    });

    // =========================================================================
    // Runtime cross-module record creation tests
    // =========================================================================

    describe('cross-module record creation', () => {
      it('should allow creating a child record in a composing module under a parent from a different module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Create a thread record in the threads module
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        const threadReply = await dwn.processMessage(
          alice.did, threadWrite.message, { dataStream: threadWrite.dataStream }
        );
        expect(threadReply.status.code).toBe(202);

        const threadContextId = threadWrite.message.contextId!;

        // Create a comment record in the comments module, parented under the thread
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const commentReply = await dwn.processMessage(
          alice.did, commentWrite.message, { dataStream: commentWrite.dataStream }
        );
        expect(commentReply.status.code).toBe(202);

        // The comment's contextId should chain from the thread's contextId
        expect(commentWrite.message.contextId).toBe(`${threadContextId}/${commentWrite.message.recordId}`);
      });

      it('should allow creating a grandchild in the composing module under a cross-module child', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Create thread -> comment -> reaction chain
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });

        const threadContextId = threadWrite.message.contextId!;

        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });

        const commentContextId = commentWrite.message.contextId!;

        // Create a reaction under the comment (grandchild, same composing module)
        const reactionWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment/reaction',
          schema          : 'https://comments.example.com/schemas/reaction',
          dataFormat      : 'application/json',
          parentContextId : commentContextId,
        });
        const reactionReply = await dwn.processMessage(
          alice.did, reactionWrite.message, { dataStream: reactionWrite.dataStream }
        );
        expect(reactionReply.status.code).toBe(202);
      });
    });

    // =========================================================================
    // Writing at the $ref position
    // =========================================================================

    describe('writing at the $ref position', () => {
      it('should reject a non-tenant writing at the `$ref` position because `$ref` nodes have no `$actions`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules on Alice's DWN
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Bob tries to write a record at the `$ref` position (modulePath: 'thread')
        // through the composing module. The `$ref` node has no `$actions`, so this should
        // be rejected for any non-tenant author.
        const threadWriteAtRef = await TestDataGenerator.generateRecordsWrite({
          author     : bob,
          module     : commentsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        const reply = await dwn.processMessage(
          alice.did, threadWriteAtRef.message, { dataStream: threadWriteAtRef.dataStream }
        );
        expect(reply.status.code).toBe(401);
        expect(reply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationActionRulesNotFound);
      });

      it('should resolve type from the referenced module for records at the `$ref` position', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules on Alice's DWN
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Alice (tenant) writes at the `$ref` position using the WRONG schema.
        // The type at position 'thread' should resolve from the threads module, which expects
        // schema 'https://threads.example.com/schemas/thread'. Using a different schema should fail.
        const wrongSchemaWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : commentsModule.module,
          modulePath : 'thread',
          schema     : 'https://comments.example.com/schemas/comment', // wrong schema
          dataFormat : 'application/json',
        });
        const reply = await dwn.processMessage(
          alice.did, wrongSchemaWrite.message, { dataStream: wrongSchemaWrite.dataStream }
        );
        expect(reply.status.code).toBe(400);
        // Type verification should fail because the schema doesn't match the referenced module's type
      });
    });

    // =========================================================================
    // Cross-module role invocation tests
    // =========================================================================

    describe('cross-module role invocation', () => {
      it('should allow a cross-module role holder to perform actions in the composing module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install threads module on Alice's DWN
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        const threadsReply = await dwn.processMessage(alice.did, threadsConfigure.message);
        expect(threadsReply.status.code).toBe(202);

        // Install comments module on Alice's DWN
        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).toBe(202);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        const threadReply = await dwn.processMessage(
          alice.did, threadWrite.message, { dataStream: threadWrite.dataStream }
        );
        expect(threadReply.status.code).toBe(202);

        const threadContextId = threadWrite.message.contextId!;

        // Alice assigns Bob as a participant in the thread (role record in threads module)
        const participantWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          module          : threadsModule.module,
          modulePath      : 'thread/participant',
          schema          : 'https://threads.example.com/schemas/participant',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const participantReply = await dwn.processMessage(
          alice.did, participantWrite.message, { dataStream: participantWrite.dataStream }
        );
        expect(participantReply.status.code).toBe(202);

        // Bob invokes the cross-module role to read comments
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const commentReply = await dwn.processMessage(
          alice.did, commentWrite.message, { dataStream: commentWrite.dataStream }
        );
        expect(commentReply.status.code).toBe(202);

        // Bob reads the comment using the cross-module role
        const bobRead = await RecordsRead.create({
          signer     : Jws.createSigner(bob),
          moduleRole : 'threads:thread/participant',
          filter     : {
            module     : commentsModule.module,
            modulePath : 'thread/comment',
            contextId  : threadContextId,
          },
        });
        const bobReadReply = await dwn.processMessage(alice.did, bobRead.message);
        expect(bobReadReply.status.code).toBe(200);
      });

      it('should allow a cross-module role holder to query records in the composing module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules on Alice's DWN
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        // Alice assigns Bob as a participant
        const participantWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          module          : threadsModule.module,
          modulePath      : 'thread/participant',
          schema          : 'https://threads.example.com/schemas/participant',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, participantWrite.message, { dataStream: participantWrite.dataStream });

        // Alice creates two comments
        const comment1 = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, comment1.message, { dataStream: comment1.dataStream });

        const comment2 = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, comment2.message, { dataStream: comment2.dataStream });

        // Bob queries comments using the cross-module role
        const bobQuery = await RecordsQuery.create({
          signer     : Jws.createSigner(bob),
          moduleRole : 'threads:thread/participant',
          filter     : {
            module     : commentsModule.module,
            modulePath : 'thread/comment',
            contextId  : threadContextId,
          },
        });
        const bobQueryReply = await dwn.processMessage(alice.did, bobQuery.message);
        expect(bobQueryReply.status.code).toBe(200);
        expect(bobQueryReply.entries).toHaveLength(2);
      });

      it('should allow a cross-module role holder to co-delete records in the composing module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules on Alice's DWN
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        // Alice assigns Bob as a participant (role record)
        const participantWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          module          : threadsModule.module,
          modulePath      : 'thread/participant',
          schema          : 'https://threads.example.com/schemas/participant',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, participantWrite.message, { dataStream: participantWrite.dataStream });

        // Carol creates a comment (via 'anyone' can 'create')
        const carolComment = await TestDataGenerator.generateRecordsWrite({
          author          : carol,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, carolComment.message, { dataStream: carolComment.dataStream });

        // Bob (participant) co-deletes Carol's comment using the cross-module role
        // The commentsModule grants 'threads:thread/participant' the 'co-delete' action on comments
        const bobDelete = await RecordsDelete.create({
          moduleRole : 'threads:thread/participant',
          recordId   : carolComment.message.recordId,
          signer     : Jws.createSigner(bob),
        });
        const deleteReply = await dwn.processMessage(alice.did, bobDelete.message);
        expect(deleteReply.status.code).toBe(202);
      });

      it('should deny cross-module role access when the role record has been deleted (revocation)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules on Alice's DWN
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        // Alice assigns Bob as a participant
        const participantWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          module          : threadsModule.module,
          modulePath      : 'thread/participant',
          schema          : 'https://threads.example.com/schemas/participant',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, participantWrite.message, { dataStream: participantWrite.dataStream });

        // Alice creates a comment
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });

        // Verify Bob CAN read the comment (role is active)
        const bobRead = await RecordsRead.create({
          signer     : Jws.createSigner(bob),
          moduleRole : 'threads:thread/participant',
          filter     : {
            module     : commentsModule.module,
            modulePath : 'thread/comment',
            contextId  : threadContextId,
          },
        });
        const bobReadReply = await dwn.processMessage(alice.did, bobRead.message);
        expect(bobReadReply.status.code).toBe(200);

        // Alice deletes Bob's participant role record (revocation)
        const deleteRole = await RecordsDelete.create({
          recordId : participantWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });
        const deleteRoleReply = await dwn.processMessage(alice.did, deleteRole.message);
        expect(deleteRoleReply.status.code).toBe(202);

        // Bob tries to read the comment again — denied because the role was deleted.
        // A broad read selects top-1 from the readable population, so the hidden
        // comment is indistinguishable from a missing one.
        const bobRead2 = await RecordsRead.create({
          signer     : Jws.createSigner(bob),
          moduleRole : 'threads:thread/participant',
          filter     : {
            module     : commentsModule.module,
            modulePath : 'thread/comment',
            contextId  : threadContextId,
          },
        });
        const bobRead2Reply = await dwn.processMessage(alice.did, bobRead2.message);
        expect(bobRead2Reply.status.code).toBe(404);
        expect(bobRead2Reply.entry).toBeUndefined();
      });

      it('should reject a cross-module role invocation if the invoker lacks the role record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });

        const threadContextId = threadWrite.message.contextId!;

        // Alice creates a comment
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });

        // Carol (who has NO participant role) tries to read the comment using the cross-module role.
        // A broad read selects top-1 from the readable population, so the hidden
        // comment is indistinguishable from a missing one.
        const carolRead = await RecordsRead.create({
          signer     : Jws.createSigner(carol),
          moduleRole : 'threads:thread/participant',
          filter     : {
            module     : commentsModule.module,
            modulePath : 'thread/comment',
            contextId  : threadContextId,
          },
        });
        const carolReadReply = await dwn.processMessage(alice.did, carolRead.message);
        expect(carolReadReply.status.code).toBe(404);
        expect(carolReadReply.entry).toBeUndefined();
      });
    });

    // =========================================================================
    // Cross-module `who`/`of` actor checks
    // =========================================================================

    describe('cross-module `who`/`of` actor checks', () => {
      it('should allow `author` of a cross-module parent to perform actions in the composing module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Bob creates a thread (via the 'anyone' can 'create' rule)
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : bob,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        const threadReply = await dwn.processMessage(
          alice.did, threadWrite.message, { dataStream: threadWrite.dataStream }
        );
        expect(threadReply.status.code).toBe(202);

        const threadContextId = threadWrite.message.contextId!;

        // Anyone can create a comment under the thread (via 'anyone' can 'create' rule)
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const commentReply = await dwn.processMessage(
          alice.did, commentWrite.message, { dataStream: commentWrite.dataStream }
        );
        expect(commentReply.status.code).toBe(202);

        // Anyone can also read (via 'anyone' can 'read' rule)
        const readComment = await RecordsRead.create({
          signer : Jws.createSigner(bob),
          filter : {
            module     : commentsModule.module,
            modulePath : 'thread/comment',
            contextId  : threadContextId,
          },
        });
        const readReply = await dwn.processMessage(alice.did, readComment.message);
        expect(readReply.status.code).toBe(200);
      });
    });

    // =========================================================================
    // Cross-module `of` actor check — happy path
    // =========================================================================

    describe('cross-module `of` actor check — happy path', () => {
      it('should allow author of cross-module parent to create records via `who: author, of: alias:path` rule', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // A module that grants the author of a thread (from the threads module) the ability to create moderation actions
        const moderationModule: ModuleDefinition = {
          module    : 'https://moderation.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            action: { schema: 'https://moderation.example.com/schemas/action', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref   : 'threads:thread',
              action : {
                $actions: [
                  { who: 'author', of: 'threads:thread', can: ['create'] },
                  { who: 'anyone', can: ['read'] },
                ],
              },
            },
          },
        };

        // Install both modules on Alice's DWN
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const moderationConfigure = await ModulesConfigure.create({
          definition : moderationModule,
          signer     : Jws.createSigner(alice),
        });
        const modReply = await dwn.processMessage(alice.did, moderationConfigure.message);
        expect(modReply.status.code).toBe(202);

        // Bob creates a thread (via 'anyone' can 'create' in threadsModule)
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : bob,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        const threadReply = await dwn.processMessage(
          alice.did, threadWrite.message, { dataStream: threadWrite.dataStream }
        );
        expect(threadReply.status.code).toBe(202);

        const threadContextId = threadWrite.message.contextId!;

        // Bob (as author of the thread) creates a moderation action — should succeed
        const actionWrite = await TestDataGenerator.generateRecordsWrite({
          author          : bob,
          module          : moderationModule.module,
          modulePath      : 'thread/action',
          schema          : 'https://moderation.example.com/schemas/action',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const actionReply = await dwn.processMessage(
          alice.did, actionWrite.message, { dataStream: actionWrite.dataStream }
        );
        expect(actionReply.status.code).toBe(202);

        // Carol (NOT author of the thread, NOT the tenant) tries to create a moderation action — should fail
        const carolActionWrite = await TestDataGenerator.generateRecordsWrite({
          author          : carol,
          module          : moderationModule.module,
          modulePath      : 'thread/action',
          schema          : 'https://moderation.example.com/schemas/action',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const carolActionReply = await dwn.processMessage(
          alice.did, carolActionWrite.message, { dataStream: carolActionWrite.dataStream }
        );
        expect(carolActionReply.status.code).toBe(401);
        expect(carolActionReply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationActionNotAllowed);
      });
    });

    // =========================================================================
    // Edge case and error tests
    // =========================================================================

    describe('composition error cases', () => {
      it('should reject `$ref` with malformed format (no colon separator)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : { comment: {} },
          structure : {
            thread: {
              $ref    : 'threadsthread', // missing colon — rejected by JSON schema pattern
              comment : {
                $actions: [{ who: 'anyone', can: ['create'] }],
              },
            },
          },
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          // JSON schema enforces `$ref` must match pattern `^[a-zA-Z][a-zA-Z0-9_-]*:.+$`
          expect(error.message).toContain('must match pattern');
        }
      });

      it('should reject `$ref` that references own module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://self.example.com',
          published : true,
          uses      : { self: 'https://self.example.com' },
          types     : { comment: {} },
          structure : {
            thread: {
              $ref    : 'self:thread',
              comment : {
                $actions: [{ who: 'anyone', can: ['create'] }],
              },
            },
          },
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ModulesConfigureInvalidUsesSelfReference);
        }
      });

      it('should reject `uses` with invalid alias name (starts with a number)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { '123invalid': 'https://foo.example.com' } as any,
          types     : {},
          structure : {},
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          // JSON schema enforces alias pattern `^[a-zA-Z][a-zA-Z0-9_-]*$` via additionalProperties: false
          expect(error.message).toContain('must NOT have additional properties');
        }
      });

      it('should reject cross-module `of` with alias not in `uses`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : { action: {} },
          structure : {
            thread: {
              $ref   : 'threads:thread',
              action : {
                $actions: [
                  { who: 'author', of: 'nonexistent:thread', can: ['create'] }, // alias 'nonexistent' not in uses
                ],
              },
            },
          },
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ModulesConfigureInvalidCrossModuleOf);
        }
      });

      for (const prune of [false, true]) {
        it(`should use retained cross-module ancestry with prune=${prune}`, async () => {
          const alice = await TestDataGenerator.generateDidKeyPersona();
          for (const definition of [threadsModule, commentsModule]) {
            const configure = await ModulesConfigure.create({ definition, signer: Jws.createSigner(alice) });
            expect((await dwn.processMessage(alice.did, configure.message)).status.code).toBe(202);
          }
          const thread = await TestDataGenerator.generateRecordsWrite({
            author     : alice,
            module     : threadsModule.module,
            modulePath : 'thread',
            schema     : threadsModule.types.thread.schema,
            dataFormat : 'application/json',
          });
          expect((await dwn.processMessage(alice.did, thread.message, { dataStream: thread.dataStream })).status.code).toBe(202);
          const deletion = await RecordsDelete.create({ recordId: thread.message.recordId, prune, signer: Jws.createSigner(alice) });
          expect((await dwn.processMessage(alice.did, deletion.message)).status.code).toBe(202);
          const comment = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            module          : commentsModule.module,
            modulePath      : 'thread/comment',
            schema          : commentsModule.types.comment.schema,
            dataFormat      : 'application/json',
            parentContextId : thread.message.contextId,
          });
          const result = await dwn.applyReplicatedMessage(alice.did, comment.message, { dataStream: comment.dataStream });
          expect(result.kind).toBe(prune ? 'Superseded' : 'Applied');
        });
      }

      it('should return 400 when cross-module parent record does not exist at runtime', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Try to create a comment under a non-existent thread (fabricate a contextId)
        const fakeThreadContextId = 'bafybeifake1234567890';
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : fakeThreadContextId,
        });
        const reply = await dwn.processMessage(
          alice.did, commentWrite.message, { dataStream: commentWrite.dataStream }
        );
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ModuleAuthorizationCrossModuleParentNotFound);
      });

      it('should reject `$ref` at non-root module path', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : { wrapper: {}, nested: {} },
          structure : {
            wrapper: {
              nested: {
                $ref: 'threads:thread', // $ref at depth > 1 — not allowed
              },
            },
          },
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ModulesConfigureInvalidRefNotAtRoot);
        }
      });

      it('should reject `uses` with empty alias map', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ModuleDefinition = {
          module    : 'https://bad.example.com',
          published : true,
          uses      : {},
          types     : {},
          structure : {},
        };

        try {
          await ModulesConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          // JSON schema enforces minProperties: 1 on `uses`
          expect(error.message).toContain('must NOT have fewer than 1 properties');
        }
      });
    });

    // =========================================================================
    // Multi-level composition rejection (#299)
    // =========================================================================

    describe('multi-level composition rejection', () => {
      it('should reject `$ref` that targets a node which is itself a `$ref` composition point', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Module B uses Module A (threads)
        const moduleB: ModuleDefinition = {
          module    : 'https://module-b.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            annotation: { schema: 'https://module-b.example.com/schemas/annotation', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref       : 'threads:thread',
              annotation : {
                $actions: [{ who: 'anyone', can: ['create', 'read'] }],
              },
            },
          },
        };

        // Module C uses Module B — attempts to $ref through B's $ref node
        const moduleC: ModuleDefinition = {
          module    : 'https://module-c.example.com',
          published : true,
          uses      : { b: 'https://module-b.example.com' },
          types     : {
            tag: { schema: 'https://module-c.example.com/schemas/tag', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref : 'b:thread', // 'thread' in module B IS a $ref node — multi-level, should be rejected
              tag  : {
                $actions: [{ who: 'anyone', can: ['create', 'read'] }],
              },
            },
          },
        };

        // Install threads module (module A)
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        // Install module B (depends on threads)
        const bConfigure = await ModulesConfigure.create({
          definition : moduleB,
          signer     : Jws.createSigner(alice),
        });
        const bReply = await dwn.processMessage(alice.did, bConfigure.message);
        expect(bReply.status.code).toBe(202);

        // Install module C (depends on B) — should be REJECTED
        const cConfigure = await ModulesConfigure.create({
          definition : moduleC,
          signer     : Jws.createSigner(alice),
        });
        const cReply = await dwn.processMessage(alice.did, cConfigure.message);
        expect(cReply.status.code).toBe(400);
        expect(cReply.status.detail).toContain(DwnErrorCode.ModulesConfigureInvalidRefTargetThroughRef);
      });

      it('should reject `$ref` that targets a multi-segment path traversing through an intermediate `$ref` node', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Module B uses threads — has $ref at 'thread' and local children under it
        const moduleB: ModuleDefinition = {
          module    : 'https://module-b.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            annotation: { schema: 'https://module-b.example.com/schemas/annotation', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref       : 'threads:thread',
              annotation : {
                $actions: [{ who: 'anyone', can: ['create', 'read'] }],
              },
            },
          },
        };

        // Module C references a path that traverses through B's $ref node: 'thread/annotation'
        // 'thread' is a $ref node in module B, so this should be rejected even though 'annotation' is a real node
        const moduleC: ModuleDefinition = {
          module    : 'https://module-c.example.com',
          published : true,
          uses      : { b: 'https://module-b.example.com' },
          types     : {
            tag: { schema: 'https://module-c.example.com/schemas/tag', dataFormats: ['application/json'] },
          },
          structure: {
            annotation: {
              $ref : 'b:thread/annotation', // traverses through 'thread' which is a $ref node
              tag  : {
                $actions: [{ who: 'anyone', can: ['create', 'read'] }],
              },
            },
          },
        };

        // Install threads module
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        // Install module B
        const bConfigure = await ModulesConfigure.create({
          definition : moduleB,
          signer     : Jws.createSigner(alice),
        });
        const bReply = await dwn.processMessage(alice.did, bConfigure.message);
        expect(bReply.status.code).toBe(202);

        // Install module C — should be REJECTED because 'thread' (intermediate) is a $ref node
        const cConfigure = await ModulesConfigure.create({
          definition : moduleC,
          signer     : Jws.createSigner(alice),
        });
        const cReply = await dwn.processMessage(alice.did, cConfigure.message);
        expect(cReply.status.code).toBe(400);
        expect(cReply.status.detail).toContain(DwnErrorCode.ModulesConfigureInvalidRefTargetThroughRef);
      });

      it('should accept `$ref` to a node that does NOT have a `$ref` directive', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Module B has a normal (non-$ref) 'item' type with children
        const moduleB: ModuleDefinition = {
          module    : 'https://module-b.example.com',
          published : true,
          types     : {
            item : { schema: 'https://module-b.example.com/schemas/item', dataFormats: ['application/json'] },
            sub  : { schema: 'https://module-b.example.com/schemas/sub', dataFormats: ['application/json'] },
          },
          structure: {
            item: {
              $actions : [{ who: 'anyone', can: ['create', 'read'] }],
              sub      : {
                $actions: [{ who: 'anyone', can: ['create', 'read'] }],
              },
            },
          },
        };

        // Module C references 'item' in B — this is single-level composition (no $ref in target), should succeed
        const moduleC: ModuleDefinition = {
          module    : 'https://module-c.example.com',
          published : true,
          uses      : { b: 'https://module-b.example.com' },
          types     : {
            extra: { schema: 'https://module-c.example.com/schemas/extra', dataFormats: ['application/json'] },
          },
          structure: {
            item: {
              $ref  : 'b:item',
              extra : {
                $actions: [{ who: 'anyone', can: ['create', 'read'] }],
              },
            },
          },
        };

        // Install module B
        const bConfigure = await ModulesConfigure.create({
          definition : moduleB,
          signer     : Jws.createSigner(alice),
        });
        const bReply = await dwn.processMessage(alice.did, bConfigure.message);
        expect(bReply.status.code).toBe(202);

        // Install module C — should SUCCEED
        const cConfigure = await ModulesConfigure.create({
          definition : moduleC,
          signer     : Jws.createSigner(alice),
        });
        const cReply = await dwn.processMessage(alice.did, cConfigure.message);
        expect(cReply.status.code).toBe(202);
      });
    });

    // =========================================================================
    // RecordsSubscribe with cross-module role
    // =========================================================================

    describe('cross-module RecordsSubscribe', () => {
      it('should stop a cross-module role subscription when the referenced role is deleted', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules on Alice's DWN
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        // Alice assigns Bob as a participant
        const participantWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          module          : threadsModule.module,
          modulePath      : 'thread/participant',
          schema          : 'https://threads.example.com/schemas/participant',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, participantWrite.message, { dataStream: participantWrite.dataStream });

        // Bob subscribes to comments using the cross-module role
        const received: SubscriptionMessage[] = [];
        const bobSubscribe = await RecordsSubscribe.create({
          signer     : Jws.createSigner(bob),
          moduleRole : 'threads:thread/participant',
          filter     : {
            module     : commentsModule.module,
            modulePath : 'thread/comment',
            contextId  : threadContextId,
          },
        });
        const subReply = await dwn.processMessage(
          alice.did,
          bobSubscribe.message,
          { subscriptionHandler: (message): void => { received.push(message); } }
        ) as RecordsSubscribeReply;
        expect(subReply.status.code).toBe(200);
        expect(subReply.subscription).toBeDefined();

        const createComment = async (): Promise<void> => {
          const commentWrite = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            module          : commentsModule.module,
            modulePath      : 'thread/comment',
            schema          : 'https://comments.example.com/schemas/comment',
            dataFormat      : 'application/json',
            parentContextId : threadContextId,
          });
          expect((await dwn.processMessage(
            alice.did,
            commentWrite.message,
            { dataStream: commentWrite.dataStream }
          )).status.code).toBe(202);
        };

        await createComment();
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(received.filter(message => message.type === 'event')).toHaveLength(1);
        });

        const deleteRole = await RecordsDelete.create({
          recordId : participantWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        });
        expect((await dwn.processMessage(alice.did, deleteRole.message)).status.code).toBe(202);
        await createComment();

        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(received.filter(message => message.type === 'error')).toHaveLength(1);
        });
        expect(received.find(message => message.type === 'error')?.error.code)
          .toBe(DwnErrorCode.RecordsSubscribeDeliveryAuthorizationFailed);
        expect(received.filter(message => message.type === 'event')).toHaveLength(1);
      });
    });

    // =========================================================================
    // RecordsCount with cross-module role
    // =========================================================================

    describe('cross-module RecordsCount', () => {
      it('should allow a cross-module role holder to count records in the composing module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules on Alice's DWN
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        // Alice assigns Bob as a participant
        const participantWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          module          : threadsModule.module,
          modulePath      : 'thread/participant',
          schema          : 'https://threads.example.com/schemas/participant',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, participantWrite.message, { dataStream: participantWrite.dataStream });

        // Alice creates 3 comments
        for (let i = 0; i < 3; i++) {
          const commentWrite = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            module          : commentsModule.module,
            modulePath      : 'thread/comment',
            schema          : 'https://comments.example.com/schemas/comment',
            dataFormat      : 'application/json',
            parentContextId : threadContextId,
          });
          await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });
        }

        // Bob counts comments using the cross-module role
        const bobCount = await RecordsCount.create({
          signer     : Jws.createSigner(bob),
          moduleRole : 'threads:thread/participant',
          filter     : {
            module     : commentsModule.module,
            modulePath : 'thread/comment',
            contextId  : threadContextId,
          },
        });
        const countReply = await dwn.processMessage(alice.did, bobCount.message) as RecordsCountReply;
        expect(countReply.status.code).toBe(200);
        expect(countReply.count).toBe(3);
      });
    });

    // =========================================================================
    // Cross-module co-update via role
    // =========================================================================

    describe('cross-module co-update via role', () => {
      it('should allow a cross-module role holder to co-update records in the composing module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // A variant of the comments module where participants can also co-update
        const commentsCoUpdateModule: ModuleDefinition = {
          module    : 'https://comments-coupdate.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            comment: { schema: 'https://comments-coupdate.example.com/schemas/comment', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref    : 'threads:thread',
              comment : {
                $actions: [
                  { who: 'anyone', can: ['create', 'read'] },
                  { role: 'threads:thread/participant', can: ['co-update'] },
                ],
              },
            },
          },
        };

        // Install both modules on Alice's DWN
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsCoUpdateModule,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).toBe(202);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        // Alice assigns Bob as a participant
        const participantWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          module          : threadsModule.module,
          modulePath      : 'thread/participant',
          schema          : 'https://threads.example.com/schemas/participant',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, participantWrite.message, { dataStream: participantWrite.dataStream });

        // Alice creates a comment (via 'anyone' can 'create')
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsCoUpdateModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments-coupdate.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });

        // Bob (participant) co-updates Alice's comment using the cross-module role
        const bobUpdate = await TestDataGenerator.generateFromRecordsWrite({
          author        : bob,
          existingWrite : commentWrite.recordsWrite,
          moduleRole    : 'threads:thread/participant',
        });
        const updateReply = await dwn.processMessage(alice.did, bobUpdate.message, { dataStream: bobUpdate.dataStream });
        expect(updateReply.status.code).toBe(202);
      });
    });

    // =========================================================================
    // Query isolation — subscribing to referenced module does NOT yield composing module events
    // =========================================================================

    describe('query isolation between modules', () => {
      it('should not return composing module records when querying the referenced module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install both modules
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Alice creates a thread in the threads module
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        // Alice creates comments in the composing module
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });

        // Query the THREADS module for all records — should NOT include the comment
        const threadsQuery = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : {
            module: threadsModule.module,
          },
        });
        const threadsQueryReply = await dwn.processMessage(alice.did, threadsQuery.message);
        expect(threadsQueryReply.status.code).toBe(200);

        // Only the thread record itself should be returned
        const threadsRecordIds = threadsQueryReply.entries!.map((e: any) => e.recordId);
        expect(threadsRecordIds).toContain(threadWrite.message.recordId);
        expect(threadsRecordIds).not.toContain(commentWrite.message.recordId);

        // Query the COMMENTS module — should include the comment
        const commentsQuery = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : {
            module: commentsModule.module,
          },
        });
        const commentsQueryReply = await dwn.processMessage(alice.did, commentsQuery.message);
        expect(commentsQueryReply.status.code).toBe(200);

        const commentsRecordIds = commentsQueryReply.entries!.map((e: any) => e.recordId);
        expect(commentsRecordIds).toContain(commentWrite.message.recordId);
        expect(commentsRecordIds).not.toContain(threadWrite.message.recordId);
      });
    });

    // =========================================================================
    // Multiple composing modules on the same $ref target
    // =========================================================================

    describe('multiple composing modules on the same $ref target', () => {
      it('should allow two different composing modules to independently reference the same type in a base module', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // commentsModule already references threads:thread
        // Create a second composing module that also references threads:thread
        const ratingsModule: ModuleDefinition = {
          module    : 'https://ratings.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            rating: { schema: 'https://ratings.example.com/schemas/rating', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref   : 'threads:thread',
              rating : {
                $actions: [
                  { who: 'anyone', can: ['create', 'read'] },
                ],
              },
            },
          },
        };

        // Install threads (base), comments, and ratings
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsModule,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).toBe(202);

        const ratingsConfigure = await ModulesConfigure.create({
          definition : ratingsModule,
          signer     : Jws.createSigner(alice),
        });
        const ratingsReply = await dwn.processMessage(alice.did, ratingsConfigure.message);
        expect(ratingsReply.status.code).toBe(202);

        // Create a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        // Create a comment under the thread via comments module
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsModule.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const commentReply = await dwn.processMessage(
          alice.did, commentWrite.message, { dataStream: commentWrite.dataStream }
        );
        expect(commentReply.status.code).toBe(202);

        // Create a rating under the same thread via ratings module
        const ratingWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : ratingsModule.module,
          modulePath      : 'thread/rating',
          schema          : 'https://ratings.example.com/schemas/rating',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const ratingReply = await dwn.processMessage(
          alice.did, ratingWrite.message, { dataStream: ratingWrite.dataStream }
        );
        expect(ratingReply.status.code).toBe(202);

        // Each module's records are isolated — querying comments returns only comments
        const commentsQuery = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { module: commentsModule.module },
        });
        const commentsQueryReply = await dwn.processMessage(alice.did, commentsQuery.message);
        expect(commentsQueryReply.entries!).toHaveLength(1);
        expect(commentsQueryReply.entries![0].recordId).toBe(commentWrite.message.recordId);

        // Querying ratings returns only ratings
        const ratingsQuery = await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { module: ratingsModule.module },
        });
        const ratingsQueryReply = await dwn.processMessage(alice.did, ratingsQuery.message);
        expect(ratingsQueryReply.entries!).toHaveLength(1);
        expect(ratingsQueryReply.entries![0].recordId).toBe(ratingWrite.message.recordId);
      });
    });

    // =========================================================================
    // Composing module definition upgrade (adding children under $ref in V2)
    // =========================================================================

    describe('composing module definition upgrade', () => {
      it('should allow upgrading a composing module to add new child types under a `$ref` node', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install threads module
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        // Comments V1 — only has 'comment' under 'thread'
        const commentsV1: ModuleDefinition = {
          module    : 'https://comments-upgrade.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            comment: { schema: 'https://comments-upgrade.example.com/schemas/comment', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref    : 'threads:thread',
              comment : {
                $actions: [{ who: 'anyone', can: ['create', 'read'] }],
              },
            },
          },
        };

        const v1Configure = await ModulesConfigure.create({
          definition : commentsV1,
          signer     : Jws.createSigner(alice),
        });
        const v1Reply = await dwn.processMessage(alice.did, v1Configure.message);
        expect(v1Reply.status.code).toBe(202);

        // Create a thread and a V1 comment
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsV1.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments-upgrade.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const commentReply = await dwn.processMessage(
          alice.did, commentWrite.message, { dataStream: commentWrite.dataStream }
        );
        expect(commentReply.status.code).toBe(202);

        // Wait to ensure V2 gets a later timestamp
        await Time.minimalSleep();

        // Comments V2 — adds 'reaction' type under 'thread/comment'
        const commentsV2: ModuleDefinition = {
          module    : 'https://comments-upgrade.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            comment  : { schema: 'https://comments-upgrade.example.com/schemas/comment', dataFormats: ['application/json'] },
            reaction : { schema: 'https://comments-upgrade.example.com/schemas/reaction', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref    : 'threads:thread',
              comment : {
                $actions : [{ who: 'anyone', can: ['create', 'read'] }],
                reaction : {
                  $actions: [{ who: 'anyone', can: ['create', 'read'] }],
                },
              },
            },
          },
        };

        const v2Configure = await ModulesConfigure.create({
          definition : commentsV2,
          signer     : Jws.createSigner(alice),
        });
        const v2Reply = await dwn.processMessage(alice.did, v2Configure.message);
        expect(v2Reply.status.code).toBe(202);

        // Now create a reaction under the comment using V2's structure
        const commentContextId = commentWrite.message.contextId!;
        const reactionWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsV2.module,
          modulePath      : 'thread/comment/reaction',
          schema          : 'https://comments-upgrade.example.com/schemas/reaction',
          dataFormat      : 'application/json',
          parentContextId : commentContextId,
        });
        const reactionReply = await dwn.processMessage(
          alice.did, reactionWrite.message, { dataStream: reactionWrite.dataStream }
        );
        expect(reactionReply.status.code).toBe(202);
      });
    });

    // =========================================================================
    // Timestamp correctness — incoming timestamp for cross-module lookups
    // =========================================================================

    describe('temporal correctness — incoming message timestamp', () => {
      it('should use the incoming message timestamp when fetching the referenced module for role verification', async () => {
        // Scenario:
        // 1. Install threads V1 (participant has $role: true)
        // 2. Install comments module (uses threads, references threads:thread/participant role)
        // 3. Create thread, assign Bob as participant, create comment — all under V1
        // 4. Update threads to V2 where participant is no longer a role ($role removed)
        // 5. Bob reads the comment using the cross-module role
        //    → should fail because the read's message timestamp resolves threads V2

        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // threads V1: participant is a role
        const threadsV1: ModuleDefinition = {
          module    : 'https://threads-versioned.example.com',
          published : true,
          types     : {
            thread      : { schema: 'https://threads-versioned.example.com/schemas/thread', dataFormats: ['application/json'] },
            participant : { schema: 'https://threads-versioned.example.com/schemas/participant', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $actions    : [{ who: 'anyone', can: ['create', 'read'] }],
              participant : {
                $role    : true,
                $actions : [
                  { who: 'anyone', can: ['read'] },
                  { who: 'author', of: 'thread', can: ['create'] },
                ],
              },
            },
          },
        };

        // comments module: references threads-versioned
        const commentsVersioned: ModuleDefinition = {
          module    : 'https://comments-versioned.example.com',
          published : true,
          uses      : { threads: 'https://threads-versioned.example.com' },
          types     : {
            comment: { schema: 'https://comments-versioned.example.com/schemas/comment', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref    : 'threads:thread',
              comment : {
                $actions: [
                  { who: 'anyone', can: ['create'] },
                  { role: 'threads:thread/participant', can: ['read'] },
                ],
              },
            },
          },
        };

        // Install threads V1
        const threadsV1Configure = await ModulesConfigure.create({
          definition : threadsV1,
          signer     : Jws.createSigner(alice),
        });
        const threadsV1Reply = await dwn.processMessage(alice.did, threadsV1Configure.message);
        expect(threadsV1Reply.status.code).toBe(202);

        // Install comments module (depends on threads)
        const commentsConfigure = await ModulesConfigure.create({
          definition : commentsVersioned,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).toBe(202);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsV1.module,
          modulePath : 'thread',
          schema     : 'https://threads-versioned.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });
        const threadContextId = threadWrite.message.contextId!;

        // Alice assigns Bob as participant (role record in threads V1)
        const participantWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          module          : threadsV1.module,
          modulePath      : 'thread/participant',
          schema          : 'https://threads-versioned.example.com/schemas/participant',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, participantWrite.message, { dataStream: participantWrite.dataStream });

        // Alice creates a comment (under V1)
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          module          : commentsVersioned.module,
          modulePath      : 'thread/comment',
          schema          : 'https://comments-versioned.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });

        // Wait to ensure V2 gets a later timestamp
        await Time.minimalSleep();

        // threads V2: participant is NO LONGER a role ($role removed)
        const threadsV2: ModuleDefinition = {
          module    : 'https://threads-versioned.example.com',
          published : true,
          types     : {
            thread      : { schema: 'https://threads-versioned.example.com/schemas/thread', dataFormats: ['application/json'] },
            participant : { schema: 'https://threads-versioned.example.com/schemas/participant', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $actions    : [{ who: 'anyone', can: ['create', 'read'] }],
              participant : {
                // $role is removed — participant is no longer a role in V2
                $actions: [
                  { who: 'anyone', can: ['read'] },
                  { who: 'author', of: 'thread', can: ['create'] },
                ],
              },
            },
          },
        };

        const threadsV2Configure = await ModulesConfigure.create({
          definition : threadsV2,
          signer     : Jws.createSigner(alice),
        });
        const threadsV2Reply = await dwn.processMessage(alice.did, threadsV2Configure.message);
        expect(threadsV2Reply.status.code).toBe(202);

        // Bob reads the comment using the cross-module role.
        // The read is authored after V2, where participant is no longer a valid role,
        // so the comment is hidden from him. A broad read selects top-1 from the
        // readable population, making the hidden comment indistinguishable from a missing one.
        const bobRead = await RecordsRead.create({
          signer     : Jws.createSigner(bob),
          moduleRole : 'threads:thread/participant',
          filter     : {
            module     : commentsVersioned.module,
            modulePath : 'thread/comment',
            contextId  : threadContextId,
          },
        });
        const bobReadReply = await dwn.processMessage(alice.did, bobRead.message);
        expect(bobReadReply.status.code).toBe(404);
        expect(bobReadReply.entry).toBeUndefined();
      });
    });

    // =========================================================================
    // Encryption + composition tests
    // =========================================================================

    describe('encryption with module composition', () => {
      let encryptionPrivateJwk: PrivateKeyJwk;
      let encryptionRootKeyId: string;

      beforeAll(async () => {
        const privateKey = await X25519.generateKey();
        encryptionPrivateJwk = privateKey as PrivateKeyJwk;
        encryptionRootKeyId = 'did:example:alice#enc';
      });

      it('should skip `$keyAgreement` injection on `$ref` nodes but inject on their children', async () => {
        const composingModule: ModuleDefinition = {
          module    : 'https://comments.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            comment  : { schema: 'https://comments.example.com/schemas/comment', dataFormats: ['application/json'] },
            reaction : { schema: 'https://comments.example.com/schemas/reaction', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref    : 'threads:thread',
              comment : {
                $actions : [{ who: 'anyone', can: ['create', 'read'] }],
                reaction : {
                  $actions: [{ who: 'anyone', can: ['create', 'read'] }],
                },
              },
            },
          },
        };

        const calledPaths: string[][] = [];
        const keyDeriver = {
          rootKeyId        : encryptionRootKeyId,
          derivationScheme : KeyDerivationScheme.ModulePath,
          derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
            calledPaths.push([...fullDerivationPath]);
            const privateKeyBytes = await X25519.privateKeyToBytes({ privateKey: encryptionPrivateJwk });
            const derivedPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, fullDerivationPath);
            const derivedPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: derivedPrivateKeyBytes });
            return await X25519.getPublicKey({ key: derivedPrivateKeyJwk }) as PublicKeyJwk;
          },
        };

        const result = await Modules.deriveAndInjectPublicEncryptionKeys(
          composingModule, keyDeriver,
        );

        expect(result.$keyAgreement).toBeDefined();

        // $ref node must NOT have $keyAgreement
        expect(result.structure.thread.$keyAgreement).toBeUndefined();

        // Children of $ref node MUST have $keyAgreement
        const commentRuleSet = result.structure.thread.comment as ModuleRuleSet;
        expect(commentRuleSet.$keyAgreement).toBeDefined();
        expect((commentRuleSet.reaction as ModuleRuleSet).$keyAgreement).toBeDefined();

        // derivePublicKey should NOT have been called for the $ref node itself
        const threadPath = [KeyDerivationScheme.ModulePath, 'https://comments.example.com', 'thread'];
        expect(calledPaths).not.toContainEqual(threadPath);

        // derivePublicKey SHOULD have been called for children
        const commentPath = [KeyDerivationScheme.ModulePath, 'https://comments.example.com', 'thread', 'comment'];
        const reactionPath = [KeyDerivationScheme.ModulePath, 'https://comments.example.com', 'thread', 'comment', 'reaction'];
        expect(calledPaths).toContainEqual(commentPath);
        expect(calledPaths).toContainEqual(reactionPath);
      });

      it('should inject child `$keyAgreement` keys derived under the composing module URI', async () => {
        const composingModule: ModuleDefinition = {
          module    : 'https://comments.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            comment: { schema: 'https://comments.example.com/schemas/comment', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref    : 'threads:thread',
              comment : {},
            },
          },
        };

        const keyDeriver = TestDataGenerator.createModulePathKeyDeriver(encryptionRootKeyId, encryptionPrivateJwk);
        const result = await Modules.deriveAndInjectPublicEncryptionKeys(
          composingModule, keyDeriver,
        );

        // The $ref node must be skipped
        expect(result.structure.thread.$keyAgreement).toBeUndefined();

        // Children of the $ref node must carry a key derived under the COMPOSING module's URI,
        // not the referenced module's URI
        const expectedCommentPublicKey = await keyDeriver.derivePublicKey(
          [KeyDerivationScheme.ModulePath, 'https://comments.example.com', 'thread', 'comment'],
        );
        const comment = result.structure.thread.comment as ModuleRuleSet;
        expect(comment.$keyAgreement!.publicKeyJwk).toEqual(expectedCommentPublicKey);
      });

      it('should successfully install a composing module with encryption after $ref skip', async () => {
        // This test verifies the full pipeline: inject encryption keys -> ModulesConfigure.create()
        // -> validateRefNode() passes because $ref node has no $keyAgreement.
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        // Install the threads module first (required dependency)
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        const threadsInstallReply = await dwn.processMessage(alice.did, threadsConfigure.message);
        expect(threadsInstallReply.status.code).toBe(202);

        // Inject encryption keys into the composing module
        const encryptedComments = await Modules.deriveAndInjectPublicEncryptionKeys(
          commentsModule,
          TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk),
        );

        // $ref node should not have $keyAgreement
        expect(encryptedComments.structure.thread.$keyAgreement).toBeUndefined();
        // Children should have $keyAgreement
        expect((encryptedComments.structure.thread.comment as ModuleRuleSet).$keyAgreement).toBeDefined();

        // ModulesConfigure.create() should NOT throw — validateRefNode() will pass
        // because $ref node has no forbidden directives
        const commentsConfigure = await ModulesConfigure.create({
          definition : encryptedComments,
          signer     : Jws.createSigner(alice),
        });

        // Install should succeed
        const commentsInstallReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsInstallReply.status.code).toBe(202);
      });

      it('should encrypt and decrypt a child record written under a `$ref` parent', async () => {
        // Full round-trip: install both modules → write parent → write encrypted child → read and decrypt
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        // 1. Install the threads module (parent)
        const threadsConfigure = await ModulesConfigure.create({
          definition : threadsModule,
          signer     : Jws.createSigner(alice),
        });
        const threadsReply = await dwn.processMessage(alice.did, threadsConfigure.message);
        expect(threadsReply.status.code).toBe(202);

        const encryptionRequiredComments = structuredClone(commentsModule);
        encryptionRequiredComments.types.comment.encryptionRequired = true;
        const commentRuleSet = encryptionRequiredComments.structure.thread.comment as ModuleRuleSet;
        commentRuleSet.$actions = [{ who: 'anyone', can: ['create'] }];

        // 2. Install the comments module with encryption keys
        const encryptedComments = await Modules.deriveAndInjectPublicEncryptionKeys(
          encryptionRequiredComments,
          TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk),
        );
        const commentsConfigure = await ModulesConfigure.create({
          definition : encryptedComments,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).toBe(202);

        // 3. Write a thread record (in the threads module — the $ref parent)
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author     : alice,
          module     : threadsModule.module,
          modulePath : 'thread',
          schema     : 'https://threads.example.com/schemas/thread',
          dataFormat : 'application/json',
        });
        const threadWriteReply = await dwn.processMessage(
          alice.did, threadWrite.message, { dataStream: threadWrite.dataStream },
        );
        expect(threadWriteReply.status.code).toBe(202);

        const threadContextId = threadWrite.message.contextId!;

        // 4. Write an encrypted comment (child of $ref parent, in the comments module)
        const plaintext = 'This is a secret comment';
        const plaintextBytes = Encoder.stringToBytes(plaintext);

        const encryptedComment = await TestDataGenerator.generateModuleEncryptedRecordsWrite({
          plaintextBytes,
          author                                      : alice,
          moduleDefinition                            : encryptedComments,
          modulePath                                  : 'thread/comment',
          moduleParentContextId                       : threadContextId,
          encryptSymmetricKeyWithModulePathDerivedKey : true,
        });

        const commentWriteReply = await dwn.processMessage(
          alice.did, encryptedComment.message, { dataStream: DataStream.fromBytes(encryptedComment.encryptedDataBytes) },
        );
        expect(commentWriteReply.status.code).toBe(202);

        // 5. Read the encrypted comment back
        const readMessage = await RecordsRead.create({
          signer : Jws.createSigner(alice),
          filter : { recordId: encryptedComment.message.recordId },
        });
        const readReply = await dwn.processMessage(alice.did, readMessage.message) as RecordsReadReply;
        expect(readReply.status.code).toBe(200);

        // 6. Decrypt using the composing module's key hierarchy.
        //    The key derivation path is [modulePath, commentsModule.module, 'thread', 'comment']
        //    — note this uses the COMPOSING module's URI, not the threads module's URI,
        //    because the comment record's descriptor.module is the comments module.
        const rootKey: DerivedPrivateJwk = {
          rootKeyId         : alice.keyId,
          derivationScheme  : KeyDerivationScheme.ModulePath,
          derivedPrivateKey : alice.encryptionKeyPair.privateJwk,
        };
        const decryptedStream = await Records.decrypt(
          readReply.entry!.recordsWrite!, TestDataGenerator.createKeyDecrypter(rootKey), readReply.entry!.data!,
        );
        const decryptedBytes = await DataStream.toBytes(decryptedStream);
        expect(Encoder.bytesToString(decryptedBytes)).toBe(plaintext);
      });

      it('should not inject `$keyAgreement` on the original module definition (immutability)', async () => {
        const composingModule: ModuleDefinition = {
          module    : 'https://comments.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : {
            comment: { schema: 'https://comments.example.com/schemas/comment', dataFormats: ['application/json'] },
          },
          structure: {
            thread: {
              $ref    : 'threads:thread',
              comment : {},
            },
          },
        };

        await Modules.deriveAndInjectPublicEncryptionKeys(
          composingModule, TestDataGenerator.createModulePathKeyDeriver(encryptionRootKeyId, encryptionPrivateJwk),
        );

        // Original must be unmodified
        expect(composingModule.$keyAgreement).toBeUndefined();
        expect(composingModule.structure.thread.$keyAgreement).toBeUndefined();
        expect((composingModule.structure.thread.comment as ModuleRuleSet).$keyAgreement).toBeUndefined();
      });
    });
  });
}
