import type { DidResolver } from '@enbox/dids';
import type { EventStream } from '../../src/types/subscriptions.js';
import type { ProtocolDefinition } from '../../src/types/protocols-types.js';
import type { DataStore, MessageStore, ResumableTaskStore, StateIndex } from '../../src/index.js';

import { expect } from 'chai';
import sinon from 'sinon';

import { Dwn } from '../../src/dwn.js';
import { Jws } from '../../src/utils/jws.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventStream } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

import { DwnErrorCode, ProtocolsConfigure, RecordsRead } from '../../src/index.js';

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

    before(async () => {
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

    after(async () => {
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

        expect(protocolsConfigure.message.descriptor.definition.uses).to.deep.equal({
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
          expect.fail('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).to.include(DwnErrorCode.ProtocolsConfigureInvalidRefAlias);
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
          expect.fail('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).to.include(DwnErrorCode.ProtocolsConfigureInvalidRefNodeHasDirectives);
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
          expect.fail('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).to.include(DwnErrorCode.ProtocolsConfigureInvalidRefNodeHasDirectives);
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
          expect.fail('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).to.include(DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolRole);
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
          expect.fail('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).to.include(DwnErrorCode.ProtocolsConfigureInvalidUsesProtocolUrl);
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
        expect(protocolsConfigure.message.descriptor.definition.uses).to.exist;
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
        expect(reply.status.code).to.equal(400);
        expect(reply.status.detail).to.include(DwnErrorCode.ProtocolsConfigureComposedProtocolNotInstalled);
      });

      it('should accept composing protocol when `uses` protocol is already installed', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // Install threads protocol first
        const threadsConfigure = await ProtocolsConfigure.create({
          definition : threadsProtocol,
          signer     : Jws.createSigner(alice),
        });
        const threadsReply = await dwn.processMessage(alice.did, threadsConfigure.message);
        expect(threadsReply.status.code).to.equal(202);

        // Now install comments protocol — should succeed
        const commentsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).to.equal(202);
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
        expect(reply.status.code).to.equal(400);
        expect(reply.status.detail).to.include(DwnErrorCode.ProtocolsConfigureInvalidRefProtocolPath);
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
        expect(reply.status.code).to.equal(400);
        expect(reply.status.detail).to.include(DwnErrorCode.ProtocolsConfigureInvalidCrossProtocolRole);
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
        expect(threadReply.status.code).to.equal(202);

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
        expect(commentReply.status.code).to.equal(202);

        // The comment's contextId should chain from the thread's contextId
        expect(commentWrite.message.contextId).to.equal(`${threadContextId}/${commentWrite.message.recordId}`);
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

        // Create thread → comment → reaction chain
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
        expect(reactionReply.status.code).to.equal(202);
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
        expect(threadsReply.status.code).to.equal(202);

        // Install comments protocol on Alice's DWN
        const commentsConfigure = await ProtocolsConfigure.create({
          definition : commentsProtocol,
          signer     : Jws.createSigner(alice),
        });
        const commentsReply = await dwn.processMessage(alice.did, commentsConfigure.message);
        expect(commentsReply.status.code).to.equal(202);

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
        expect(threadReply.status.code).to.equal(202);

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
        expect(participantReply.status.code).to.equal(202);

        // Bob invokes the cross-protocol role to read comments
        // The role 'threads:thread/participant' grants 'read' and 'co-delete' on comments
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
        expect(commentReply.status.code).to.equal(202);

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
        expect(bobReadReply.status.code).to.equal(200);
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
        expect(carolReadReply.status.code).to.equal(401);
        expect(carolReadReply.status.detail).to.include(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
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
        expect(threadReply.status.code).to.equal(202);

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
        expect(commentReply.status.code).to.equal(202);

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
        expect(readReply.status.code).to.equal(200);
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
          expect.fail('Expected an error to be thrown');
        } catch (error: any) {
          // JSON schema enforces `$ref` must match pattern `^[a-zA-Z][a-zA-Z0-9_-]*:.+$`
          expect(error.message).to.include('must match pattern');
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
          expect.fail('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).to.include(DwnErrorCode.ProtocolsConfigureInvalidUsesSelfReference);
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
          expect.fail('Expected an error to be thrown');
        } catch (error: any) {
          // JSON schema enforces minProperties: 1 on `uses`
          expect(error.message).to.include('must NOT have fewer than 1 properties');
        }
      });
    });
  });
}
