import type { DerivedPrivateJwk } from '../../src/utils/hd-key.js';
import type { DidResolver } from '@enbox/dids';
import type { EventStream } from '../../src/types/subscriptions.js';
import type { ProtocolDefinition } from '../../src/types/protocols-types.js';
import type { DataStore, MessageStore, RecordsReadReply, ResumableTaskStore, StateIndex } from '../../src/index.js';
import type { PrivateKeyJwk, PublicKeyJwk } from '../../src/types/jose-types.js';

import sinon from 'sinon';

import { DataStream } from '../../src/utils/data-stream.js';
import { Dwn } from '../../src/dwn.js';
import { Encoder } from '../../src/utils/encoder.js';
import { Jws } from '../../src/utils/jws.js';
import { Protocols } from '../../src/utils/protocols.js';
import { Records } from '../../src/utils/records.js';
import { Secp256k1 } from '../../src/utils/secp256k1.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventStream } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnErrorCode, ProtocolsConfigure, RecordsRead } from '../../src/index.js';
import { HdKey, KeyDerivationScheme } from '../../src/utils/hd-key.js';

/**
 * Tests for protocol composition using `uses` + `$ref`.
 */
export function testProtocolComposition(): void {
  describe('Protocol composition', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let stateIndex: StateIndex;
    let eventStream: EventStream;
    let dwn: Dwn;

    beforeAll(async () => {
      didResolver = new UniversalResolver({ didResolvers: [DidKey] });

      const stores = TestStores.get();
      messageStore = stores.messageStore;
      dataStore = stores.dataStore;
      resumableTaskStore = stores.resumableTaskStore;
      stateIndex = stores.stateIndex;
      eventStream = TestEventStream.get();

      dwn = await Dwn.create({ didResolver, messageStore, dataStore, stateIndex, eventStream, resumableTaskStore });
    });

    beforeEach(async () => {
      sinon.restore();
      await messageStore.clear();
      await dataStore.clear();
      await resumableTaskStore.clear();
      await stateIndex.clear();
    });

    afterAll(async () => {
      await dwn.close();
    });

    // =========================================================================
    // Protocol definitions for tests
    // =========================================================================

    const threadsProtocol: ProtocolDefinition = {
      protocol  : 'https://threads.example.com',
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

    const commentsProtocol: ProtocolDefinition = {
      protocol  : 'https://comments.example.com',
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
    // Validation tests (ProtocolsConfigure)
    // =========================================================================

    describe('ProtocolsConfigure validation', () => {
      it('should accept a valid protocol definition with `uses` and `$ref`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const protocolsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });

        expect(protocolsConfigure.message.descriptor.definition.uses).toEqual({
          threads: 'https://threads.example.com',
        });
      });

      it('should reject `$ref` with alias not in `uses`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
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
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ProtocolsConfigureInvalidRefAlias);
        }
      });

      it('should reject `$ref` node with `$actions`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
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
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ProtocolsConfigureInvalidRefNodeHasDirectives);
        }
      });

      it('should reject `$ref` node with `$role`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
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
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ProtocolsConfigureInvalidRefNodeHasDirectives);
        }
      });

      it('should reject cross-protocol `role` with alias not in `uses`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
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
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolRole);
        }
      });

      it('should reject `uses` with invalid protocol URL', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
          published : true,
          uses      : { threads: '::invalid::' },
          types     : {},
          structure : {},
        };

        try {
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ProtocolsConfigureInvalidUsesProtocolUrl);
        }
      });

      it('should not require `$ref` types in local types map', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // 'thread' is NOT in the local `types` — it comes from the $ref
        const definition: ProtocolDefinition = {
          protocol  : 'https://comments.example.com',
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
        const protocolsConfigure = await ProtocolsConfigure.create({
          definition,
          signer: Jws.createSigner(alice),
        });
        expect(protocolsConfigure.message.descriptor.definition.uses).toBeDefined();
      });
    });

    // =========================================================================
    // Install-time validation tests (handler)
    // =========================================================================

    describe('install-time composition dependency validation', () => {
      it('should reject composing protocol if `uses` protocol is not installed', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Try to install comments protocol WITHOUT installing threads first
        const commentsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });

        const reply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureComposedProtocolNotInstalled);
      });

      it('should accept composing protocol when `uses` protocol is already installed', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install threads protocol first
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        const threadsReply = await dwn.processMessage(alice.did, threadsConfigure.message);
        expect(threadsReply.status.code).toBe(202);

        // Now install comments protocol — should succeed
        const commentsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).toBe(202);
      });

      it('should reject composing protocol if `$ref` path does not exist in referenced protocol', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install threads protocol first
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        // Install a composing protocol that references a non-existent type path
        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
          published : true,
          uses      : { threads: 'https://threads.example.com' },
          types     : { comment: {} },
          structure : {
            nonexistent: {
              $ref    : 'threads:nonexistent', // 'nonexistent' doesn't exist in threads protocol
              comment : {
                $actions: [{ who: 'anyone', can: ['create'] }],
              },
            },
          },
        };

        const badConfigure = await ProtocolsConfigure.create({
          definition : badDefinition,
          signer     : Jws.createSigner(alice),
        });
        const reply = await dwn.processMessage(alice.did, badConfigure.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureInvalidRefProtocolPath);
      });

      it('should reject composing protocol if cross-protocol role does not exist in referenced protocol', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install threads protocol first
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        // Install a composing protocol with invalid cross-protocol role
        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
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

        const badConfigure = await ProtocolsConfigure.create({
          definition : badDefinition,
          signer     : Jws.createSigner(alice),
        });
        const reply = await dwn.processMessage(alice.did, badConfigure.message);
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolRole);
      });
    });

    // =========================================================================
    // Runtime cross-protocol record creation tests
    // =========================================================================

    describe('cross-protocol record creation', () => {
      it('should allow creating a child record in a composing protocol under a parent from a different protocol', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install both protocols
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Create a thread record in the threads protocol
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : threadsProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://threads.example.com/schemas/thread',
          dataFormat   : 'application/json',
        });
        const threadReply = await dwn.processMessage(
          alice.did, threadWrite.message, { dataStream: threadWrite.dataStream }
        );
        expect(threadReply.status.code).toBe(202);

        const threadContextId = threadWrite.message.contextId!;

        // Create a comment record in the comments protocol, parented under the thread
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : commentsProtocol.protocol,
          protocolPath    : 'thread/comment',
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

      it('should allow creating a grandchild in the composing protocol under a cross-protocol child', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install both protocols
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Create thread -> comment -> reaction chain
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : threadsProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://threads.example.com/schemas/thread',
          dataFormat   : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });

        const threadContextId = threadWrite.message.contextId!;

        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : commentsProtocol.protocol,
          protocolPath    : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });

        const commentContextId = commentWrite.message.contextId!;

        // Create a reaction under the comment (grandchild, same composing protocol)
        const reactionWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : commentsProtocol.protocol,
          protocolPath    : 'thread/comment/reaction',
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
    // Cross-protocol role invocation tests
    // =========================================================================

    describe('cross-protocol role invocation', () => {
      it('should allow a cross-protocol role holder to perform actions in the composing protocol', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install threads protocol on Alice's DWN
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        const threadsReply = await dwn.processMessage(alice.did, threadsConfigure.message);
        expect(threadsReply.status.code).toBe(202);

        // Install comments protocol on Alice's DWN
        const commentsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).toBe(202);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : threadsProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://threads.example.com/schemas/thread',
          dataFormat   : 'application/json',
        });
        const threadReply = await dwn.processMessage(
          alice.did, threadWrite.message, { dataStream: threadWrite.dataStream }
        );
        expect(threadReply.status.code).toBe(202);

        const threadContextId = threadWrite.message.contextId!;

        // Alice assigns Bob as a participant in the thread (role record in threads protocol)
        const participantWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          recipient       : bob.did,
          protocol        : threadsProtocol.protocol,
          protocolPath    : 'thread/participant',
          schema          : 'https://threads.example.com/schemas/participant',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const participantReply = await dwn.processMessage(
          alice.did, participantWrite.message, { dataStream: participantWrite.dataStream }
        );
        expect(participantReply.status.code).toBe(202);

        // Bob invokes the cross-protocol role to read comments
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : commentsProtocol.protocol,
          protocolPath    : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const commentReply = await dwn.processMessage(
          alice.did, commentWrite.message, { dataStream: commentWrite.dataStream }
        );
        expect(commentReply.status.code).toBe(202);

        // Bob reads the comment using the cross-protocol role
        const bobRead = await RecordsRead.create({
          signer       : Jws.createSigner(bob),
          protocolRole : 'threads:thread/participant',
          filter       : {
            protocol     : commentsProtocol.protocol,
            protocolPath : 'thread/comment',
            contextId    : threadContextId,
          },
        });
        const bobReadReply = await dwn.processMessage(alice.did, bobRead.message);
        expect(bobReadReply.status.code).toBe(200);
      });

      it('should reject a cross-protocol role invocation if the invoker lacks the role record', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // Install both protocols
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Alice creates a thread
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : threadsProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://threads.example.com/schemas/thread',
          dataFormat   : 'application/json',
        });
        await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });

        const threadContextId = threadWrite.message.contextId!;

        // Alice creates a comment
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : commentsProtocol.protocol,
          protocolPath    : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });

        // Carol (who has NO participant role) tries to read the comment using the cross-protocol role
        const carolRead = await RecordsRead.create({
          signer       : Jws.createSigner(carol),
          protocolRole : 'threads:thread/participant',
          filter       : {
            protocol     : commentsProtocol.protocol,
            protocolPath : 'thread/comment',
            contextId    : threadContextId,
          },
        });
        const carolReadReply = await dwn.processMessage(alice.did, carolRead.message);
        expect(carolReadReply.status.code).toBe(401);
        expect(carolReadReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
      });
    });

    // =========================================================================
    // Cross-protocol `who`/`of` actor checks
    // =========================================================================

    describe('cross-protocol `who`/`of` actor checks', () => {
      it('should allow `author` of a cross-protocol parent to perform actions in the composing protocol', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();

        // Install both protocols
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Bob creates a thread (via the 'anyone' can 'create' rule)
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          protocol     : threadsProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://threads.example.com/schemas/thread',
          dataFormat   : 'application/json',
        });
        const threadReply = await dwn.processMessage(
          alice.did, threadWrite.message, { dataStream: threadWrite.dataStream }
        );
        expect(threadReply.status.code).toBe(202);

        const threadContextId = threadWrite.message.contextId!;

        // Anyone can create a comment under the thread (via 'anyone' can 'create' rule)
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : commentsProtocol.protocol,
          protocolPath    : 'thread/comment',
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
            protocol     : commentsProtocol.protocol,
            protocolPath : 'thread/comment',
            contextId    : threadContextId,
          },
        });
        const readReply = await dwn.processMessage(alice.did, readComment.message);
        expect(readReply.status.code).toBe(200);
      });
    });

    // =========================================================================
    // Cross-protocol `of` actor check — happy path
    // =========================================================================

    describe('cross-protocol `of` actor check — happy path', () => {
      it('should allow author of cross-protocol parent to create records via `who: author, of: alias:path` rule', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();
        const bob = await TestDataGenerator.generateDidKeyPersona();
        const carol = await TestDataGenerator.generateDidKeyPersona();

        // A protocol that grants the author of a thread (from the threads protocol) the ability to create moderation actions
        const moderationProtocol: ProtocolDefinition = {
          protocol  : 'https://moderation.example.com',
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

        // Install both protocols on Alice's DWN
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const moderationConfigure = await ProtocolsConfigure.create({
          definition : moderationProtocol,
          signer     : Jws.createSigner(alice),
        });
        const modReply = await dwn.processMessage(alice.did, moderationConfigure.message);
        expect(modReply.status.code).toBe(202);

        // Bob creates a thread (via 'anyone' can 'create' in threadsProtocol)
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author       : bob,
          protocol     : threadsProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://threads.example.com/schemas/thread',
          dataFormat   : 'application/json',
        });
        const threadReply = await dwn.processMessage(
          alice.did, threadWrite.message, { dataStream: threadWrite.dataStream }
        );
        expect(threadReply.status.code).toBe(202);

        const threadContextId = threadWrite.message.contextId!;

        // Bob (as author of the thread) creates a moderation action — should succeed
        const actionWrite = await TestDataGenerator.generateRecordsWrite({
          author          : bob,
          protocol        : moderationProtocol.protocol,
          protocolPath    : 'thread/action',
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
          protocol        : moderationProtocol.protocol,
          protocolPath    : 'thread/action',
          schema          : 'https://moderation.example.com/schemas/action',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
        });
        const carolActionReply = await dwn.processMessage(
          alice.did, carolActionWrite.message, { dataStream: carolActionWrite.dataStream }
        );
        expect(carolActionReply.status.code).toBe(401);
        expect(carolActionReply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationActionNotAllowed);
      });
    });

    // =========================================================================
    // Edge case and error tests
    // =========================================================================

    describe('composition error cases', () => {
      it('should reject `$ref` with malformed format (no colon separator)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
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
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          // JSON schema enforces `$ref` must match pattern `^[a-zA-Z][a-zA-Z0-9_-]*:.+$`
          expect(error.message).toContain('must match pattern');
        }
      });

      it('should reject `$ref` that references own protocol', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://self.example.com',
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
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ProtocolsConfigureInvalidUsesSelfReference);
        }
      });

      it('should reject `uses` with invalid alias name (starts with a number)', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
          published : true,
          uses      : { '123invalid': 'https://foo.example.com' } as any,
          types     : {},
          structure : {},
        };

        try {
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          // JSON schema enforces alias pattern `^[a-zA-Z][a-zA-Z0-9_-]*$` via additionalProperties: false
          expect(error.message).toContain('must NOT have additional properties');
        }
      });

      it('should reject cross-protocol `of` with alias not in `uses`', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
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
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolOf);
        }
      });

      it('should return 400 when cross-protocol parent record does not exist at runtime', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install both protocols
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, threadsConfigure.message);

        const commentsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });
        await dwn.processMessage(alice.did, commentsConfigure.message);

        // Try to create a comment under a non-existent thread (fabricate a contextId)
        const fakeThreadContextId = 'bafybeifake1234567890';
        const commentWrite = await TestDataGenerator.generateRecordsWrite({
          author          : alice,
          protocol        : commentsProtocol.protocol,
          protocolPath    : 'thread/comment',
          schema          : 'https://comments.example.com/schemas/comment',
          dataFormat      : 'application/json',
          parentContextId : fakeThreadContextId,
        });
        const reply = await dwn.processMessage(
          alice.did, commentWrite.message, { dataStream: commentWrite.dataStream }
        );
        expect(reply.status.code).toBe(400);
        expect(reply.status.detail).toContain(DwnErrorCode.ProtocolAuthorizationCrossProtocolParentNotFound);
      });

      it('should reject `$ref` at non-root protocol path', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
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
          await ProtocolsConfigure.create({
            definition : badDefinition,
            signer     : Jws.createSigner(alice),
          });
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(DwnErrorCode.ProtocolsConfigureInvalidRefNotAtRoot);
        }
      });

      it('should reject `uses` with empty alias map', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const badDefinition: ProtocolDefinition = {
          protocol  : 'https://bad.example.com',
          published : true,
          uses      : {},
          types     : {},
          structure : {},
        };

        try {
          await ProtocolsConfigure.create({
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
    // Encryption + composition tests
    // =========================================================================

    describe('encryption with protocol composition', () => {
      let encryptionPrivateJwk: PrivateKeyJwk;
      let encryptionRootKeyId: string;

      beforeAll(async () => {
        const { privateJwk } = await Secp256k1.generateKeyPair();
        encryptionPrivateJwk = privateJwk;
        encryptionRootKeyId = 'did:example:alice#enc';
      });

      it('should skip `$encryption` injection on `$ref` nodes but inject on their children (raw-key path)', async () => {
        const composingProtocol: ProtocolDefinition = {
          protocol  : 'https://comments.example.com',
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

        const result = await Protocols.deriveAndInjectPublicEncryptionKeys(
          composingProtocol, encryptionRootKeyId, encryptionPrivateJwk,
        );

        // $ref node must NOT have $encryption
        expect(result.structure.thread.$encryption).toBeUndefined();

        // Children of $ref node MUST have $encryption
        expect(result.structure.thread.comment.$encryption).toBeDefined();
        expect(result.structure.thread.comment.$encryption!.rootKeyId).toBe(encryptionRootKeyId);
        expect(result.structure.thread.comment.$encryption!.publicKeyJwk).toBeDefined();

        // Grandchild of $ref node
        expect(result.structure.thread.comment.reaction.$encryption).toBeDefined();
        expect(result.structure.thread.comment.reaction.$encryption!.rootKeyId).toBe(encryptionRootKeyId);
      });

      it('should skip `$encryption` injection on `$ref` nodes but inject on their children (callback path)', async () => {
        const composingProtocol: ProtocolDefinition = {
          protocol  : 'https://comments.example.com',
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
          derivationScheme : KeyDerivationScheme.ProtocolPath,
          derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
            calledPaths.push([...fullDerivationPath]);
            const privateKeyBytes = Secp256k1.privateJwkToBytes(encryptionPrivateJwk);
            const derivedPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, fullDerivationPath);
            const derivedPublicKeyBytes = await Secp256k1.getPublicKey(derivedPrivateKeyBytes);
            return Secp256k1.publicKeyToJwk(derivedPublicKeyBytes);
          },
        };

        const result = await Protocols.deriveAndInjectPublicEncryptionKeys(
          composingProtocol, keyDeriver,
        );

        // $ref node must NOT have $encryption
        expect(result.structure.thread.$encryption).toBeUndefined();

        // Children of $ref node MUST have $encryption
        expect(result.structure.thread.comment.$encryption).toBeDefined();
        expect(result.structure.thread.comment.reaction.$encryption).toBeDefined();

        // derivePublicKey should NOT have been called for the $ref node itself
        const threadPath = [KeyDerivationScheme.ProtocolPath, 'https://comments.example.com', 'thread'];
        expect(calledPaths).not.toContainEqual(threadPath);

        // derivePublicKey SHOULD have been called for children
        const commentPath = [KeyDerivationScheme.ProtocolPath, 'https://comments.example.com', 'thread', 'comment'];
        const reactionPath = [KeyDerivationScheme.ProtocolPath, 'https://comments.example.com', 'thread', 'comment', 'reaction'];
        expect(calledPaths).toContainEqual(commentPath);
        expect(calledPaths).toContainEqual(reactionPath);
      });

      it('should produce identical $encryption for children across both overloads', async () => {
        const composingProtocol: ProtocolDefinition = {
          protocol  : 'https://comments.example.com',
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

        // Raw-key path
        const resultA = await Protocols.deriveAndInjectPublicEncryptionKeys(
          composingProtocol, encryptionRootKeyId, encryptionPrivateJwk,
        );

        // Callback path
        const keyDeriver = {
          rootKeyId        : encryptionRootKeyId,
          derivationScheme : KeyDerivationScheme.ProtocolPath,
          derivePublicKey  : async (fullDerivationPath: string[]): Promise<PublicKeyJwk> => {
            const privateKeyBytes = Secp256k1.privateJwkToBytes(encryptionPrivateJwk);
            const derivedPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, fullDerivationPath);
            const derivedPublicKeyBytes = await Secp256k1.getPublicKey(derivedPrivateKeyBytes);
            return Secp256k1.publicKeyToJwk(derivedPublicKeyBytes);
          },
        };

        const resultB = await Protocols.deriveAndInjectPublicEncryptionKeys(
          composingProtocol, keyDeriver,
        );

        // Both paths must skip $ref
        expect(resultA.structure.thread.$encryption).toBeUndefined();
        expect(resultB.structure.thread.$encryption).toBeUndefined();

        // Both paths must produce identical $encryption on children
        expect(resultA.structure.thread.comment.$encryption!.publicKeyJwk).toEqual(
          resultB.structure.thread.comment.$encryption!.publicKeyJwk,
        );
        expect(resultA.structure.thread.comment.$encryption!.rootKeyId).toBe(
          resultB.structure.thread.comment.$encryption!.rootKeyId,
        );
      });

      it('should successfully install a composing protocol with encryption after $ref skip', async () => {
        // This test verifies the full pipeline: inject encryption keys → ProtocolsConfigure.create()
        // → validateRefNode() passes because $ref node has no $encryption.
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        // Install the threads protocol first (required dependency)
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        const threadsInstallReply = await dwn.processMessage(alice.did, threadsConfigure.message);
        expect(threadsInstallReply.status.code).toBe(202);

        // Inject encryption keys into the composing protocol
        const encryptedComments = await Protocols.deriveAndInjectPublicEncryptionKeys(
          commentsProtocol, alice.keyId, alice.keyPair.privateJwk,
        );

        // $ref node should not have $encryption
        expect(encryptedComments.structure.thread.$encryption).toBeUndefined();
        // Children should have $encryption
        expect(encryptedComments.structure.thread.comment.$encryption).toBeDefined();

        // ProtocolsConfigure.create() should NOT throw — validateRefNode() will pass
        // because $ref node has no forbidden directives
        const commentsConfigure = await ProtocolsConfigure.create({
          definition : encryptedComments,
          signer     : Jws.createSigner(alice),
        });

        // Install should succeed
        const commentsInstallReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsInstallReply.status.code).toBe(202);
      });

      it('should encrypt and decrypt a child record written under a `$ref` parent', async () => {
        // Full round-trip: install both protocols → write parent → write encrypted child → read and decrypt
        const alice = await TestDataGenerator.generatePersona();
        TestStubGenerator.stubDidResolver(didResolver, [alice]);

        // 1. Install the threads protocol (parent)
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        const threadsReply = await dwn.processMessage(alice.did, threadsConfigure.message);
        expect(threadsReply.status.code).toBe(202);

        // 2. Install the comments protocol with encryption keys
        const encryptedComments = await Protocols.deriveAndInjectPublicEncryptionKeys(
          commentsProtocol, alice.keyId, alice.keyPair.privateJwk,
        );
        const commentsConfigure = await ProtocolsConfigure.create({
          definition : encryptedComments,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).toBe(202);

        // 3. Write a thread record (in the threads protocol — the $ref parent)
        const threadWrite = await TestDataGenerator.generateRecordsWrite({
          author       : alice,
          protocol     : threadsProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://threads.example.com/schemas/thread',
          dataFormat   : 'application/json',
        });
        const threadWriteReply = await dwn.processMessage(
          alice.did, threadWrite.message, { dataStream: threadWrite.dataStream },
        );
        expect(threadWriteReply.status.code).toBe(202);

        const threadContextId = threadWrite.message.contextId!;

        // 4. Write an encrypted comment (child of $ref parent, in the comments protocol)
        const plaintext = 'This is a secret comment';
        const plaintextBytes = Encoder.stringToBytes(plaintext);

        const encryptedComment = await TestDataGenerator.generateProtocolEncryptedRecordsWrite({
          plaintextBytes,
          author                                           : alice,
          protocolDefinition                               : encryptedComments,
          protocolPath                                     : 'thread/comment',
          protocolParentContextId                          : threadContextId,
          encryptSymmetricKeyWithProtocolPathDerivedKey    : true,
          encryptSymmetricKeyWithProtocolContextDerivedKey : false,
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

        // 6. Decrypt using the composing protocol's key hierarchy.
        //    The key derivation path is [protocolPath, commentsProtocol.protocol, 'thread', 'comment']
        //    — note this uses the COMPOSING protocol's URI, not the threads protocol's URI,
        //    because the comment record's descriptor.protocol is the comments protocol.
        const rootKey: DerivedPrivateJwk = {
          rootKeyId         : alice.keyId,
          derivationScheme  : KeyDerivationScheme.ProtocolPath,
          derivedPrivateKey : alice.keyPair.privateJwk,
        };
        const decryptedStream = await Records.decrypt(
          readReply.entry!.recordsWrite!, rootKey, readReply.entry!.data!,
        );
        const decryptedBytes = await DataStream.toBytes(decryptedStream);
        expect(Encoder.bytesToString(decryptedBytes)).toBe(plaintext);
      });

      it('should not inject `$encryption` on the original protocol definition (immutability)', async () => {
        const composingProtocol: ProtocolDefinition = {
          protocol  : 'https://comments.example.com',
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

        await Protocols.deriveAndInjectPublicEncryptionKeys(
          composingProtocol, encryptionRootKeyId, encryptionPrivateJwk,
        );

        // Original must be unmodified
        expect(composingProtocol.structure.thread.$encryption).toBeUndefined();
        expect(composingProtocol.structure.thread.comment.$encryption).toBeUndefined();
      });
    });
  });
}
