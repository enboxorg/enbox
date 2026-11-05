import type { DidResolver } from '@enbox/dids';
import type { EventLog } from '../../src/types/subscriptions.js';
import type { ModuleDefinition } from '../../src/types/modules-types.js';
import type {
  DataStore,
  MessageStore,
  ResumableTaskStore,
} from '../../src/index.js';

import sinon from 'sinon';

import { DwnInterfaceName } from '../../src/enums/dwn-interface-method.js';
import { Message } from '../../src/core/message.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  DataStream,
  Dwn,
  DwnConstant,
  Jws,
  ModulesConfigure,
  RecordsDelete,
  RecordsQuery,
  RecordsRead,
} from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

/**
 * Regression tests for cross-module prune cascade — closes #298.
 *
 * Semantics (decision under #298):
 * A `RecordsDelete` with `prune: true` cascades to every descendant of the
 * pruned record, regardless of which module a descendant declares itself
 * under. `parentContextId` is a structural link — pruning a parent removes
 * the entire subtree it rooted. Cross-module composing children (records
 * in a different module that reference the parent via `$ref` / `uses`)
 * participate in the cascade on equal footing with same-module children.
 *
 * Rationale:
 * - A DWN is tenant-owned storage. The tenant's prune authority extends
 *   across the whole subtree they rooted, so walking the `parentId` chain
 *   unconditionally is the correct semantic.
 * - Preserving cross-module orphans creates a half-alive state — readable
 *   but not updatable, since `validateReferentialIntegrity` in the
 *   `RecordsWrite` handler rejects any write whose parent is missing —
 *   which is worse for callers than cascading.
 * - Same-module descendants at arbitrary depth already cascade via
 *   `parentId` with no module filter; treating a cross-module hop
 *   specially was inconsistent.
 *
 * These tests install multiple modules linked via `uses` + `$ref`, write
 * records across module boundaries, and assert that the entire subtree —
 * same module or cross module, at any depth — is fully purged on prune.
 */
export function testRecordsPruneCrossModule(): void {
  describe('records pruning — cross-module cascade (#298)', () => {
    let didResolver: DidResolver;
    let messageStore: MessageStore;
    let dataStore: DataStore;
    let resumableTaskStore: ResumableTaskStore;
    let eventLog: EventLog;
    let dwn: Dwn;

    // Module A — `threads`: root `thread` type with a nested `participant` role.
    const threadsModule: ModuleDefinition = {
      module    : 'https://threads.example.com',
      published : true,
      types     : {
        thread      : { schema: 'https://threads.example.com/schemas/thread', dataFormats: ['application/json'] },
        participant : { schema: 'https://threads.example.com/schemas/participant', dataFormats: ['application/json'] },
      },
      structure: {
        thread: {
          $actions: [
            { who: 'anyone', can: ['create', 'read', 'prune'] },
          ],
          participant: {
            $role    : true,
            $actions : [
              { who: 'anyone', can: ['read'] },
              { who: 'author', of: 'thread', can: ['create'] },
            ],
          },
        },
      },
    };

    // Module B — `comments` composes `threads:thread` via `$ref`.
    const commentsModule: ModuleDefinition = {
      module    : 'https://comments.example.com',
      published : true,
      uses      : {
        threads: 'https://threads.example.com',
      },
      types: {
        comment: { schema: 'https://comments.example.com/schemas/comment', dataFormats: ['application/json'] },
      },
      structure: {
        thread: {
          $ref    : 'threads:thread',
          comment : {
            $actions: [
              { who: 'anyone', can: ['create', 'read'] },
            ],
          },
        },
      },
    };

    // Module C — `reactions` composes `threads:thread` via `$ref`, nesting
    // `comment` → `reaction`. Used to exercise multi-level cascade through
    // a cross-module hop.
    const reactionsModule: ModuleDefinition = {
      module    : 'https://reactions.example.com',
      published : true,
      uses      : {
        threads: 'https://threads.example.com',
      },
      types: {
        comment  : { schema: 'https://reactions.example.com/schemas/comment', dataFormats: ['application/json'] },
        reaction : { schema: 'https://reactions.example.com/schemas/reaction', dataFormats: ['application/json'] },
      },
      structure: {
        thread: {
          $ref    : 'threads:thread',
          comment : {
            $actions: [
              { who: 'anyone', can: ['create', 'read'] },
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

    it('should cascade-purge a cross-module composing child when the parent is pruned', async () => {
      // Shape:
      //   thread    (threads) ← pruned
      //     comment (comments, cross-module child via $ref)
      //
      // Expected: both records fully purged. A cross-module child participates
      // in the cascade on equal footing with a same-module child.
      const alice = await TestDataGenerator.generateDidKeyPersona();

      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: threadsModule, signer: Jws.createSigner(alice) })).message,
      );
      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: commentsModule, signer: Jws.createSigner(alice) })).message,
      );

      const threadWrite = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        module     : threadsModule.module,
        modulePath : 'thread',
        schema     : 'https://threads.example.com/schemas/thread',
        dataFormat : 'application/json',
      });
      expect(
        (await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream })).status.code,
      ).toBe(202);

      const commentWrite = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : commentsModule.module,
        modulePath      : 'thread/comment',
        schema          : 'https://comments.example.com/schemas/comment',
        dataFormat      : 'application/json',
        parentContextId : threadWrite.message.contextId,
      });
      expect(
        (await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream })).status.code,
      ).toBe(202);

      // Sanity: the comment is readable pre-prune.
      expect(
        (await dwn.processMessage(alice.did, (await RecordsRead.create({
          signer : Jws.createSigner(alice),
          filter : { recordId: commentWrite.message.recordId },
        })).message)).status.code,
      ).toBe(200);

      const threadPrune = await RecordsDelete.create({
        recordId : threadWrite.message.recordId,
        prune    : true,
        signer   : Jws.createSigner(alice),
      });
      expect((await dwn.processMessage(alice.did, threadPrune.message)).status.code).toBe(202);

      // The cross-module comment is purged.
      expect(
        (await dwn.processMessage(alice.did, (await RecordsRead.create({
          signer : Jws.createSigner(alice),
          filter : { recordId: commentWrite.message.recordId },
        })).message)).status.code,
      ).toBe(404);

      // Query confirms no records remain under the comments module.
      const commentsQueryReply = await dwn.processMessage(
        alice.did,
        (await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { module: commentsModule.module },
        })).message,
      );
      expect(commentsQueryReply.status.code).toBe(200);
      expect(commentsQueryReply.entries).toHaveLength(0);

      // Message store has no residual messages for the comment's module.
      const commentsStoreMessages = await messageStore.query(alice.did, [{
        interface : DwnInterfaceName.Records,
        module    : commentsModule.module,
      }]);
      expect(commentsStoreMessages.messages).toHaveLength(0);
    });

    it('should cascade recursively through mixed same-module + cross-module subtrees', async () => {
      // Shape (3 levels, 2 modules, mixed siblings):
      //   thread          (threads) ← pruned
      //     participant   (threads, same-module sibling)
      //     comment       (reactions, cross-module sibling via $ref)
      //       reaction    (reactions, cross-module grandchild)
      //
      // Expected: every descendant purged regardless of module or depth.
      const alice = await TestDataGenerator.generateDidKeyPersona();

      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: threadsModule, signer: Jws.createSigner(alice) })).message,
      );
      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: reactionsModule, signer: Jws.createSigner(alice) })).message,
      );

      const threadWrite = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        module     : threadsModule.module,
        modulePath : 'thread',
        schema     : 'https://threads.example.com/schemas/thread',
        dataFormat : 'application/json',
      });
      await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });

      const participantWrite = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        recipient       : alice.did,
        module          : threadsModule.module,
        modulePath      : 'thread/participant',
        schema          : 'https://threads.example.com/schemas/participant',
        dataFormat      : 'application/json',
        parentContextId : threadWrite.message.contextId,
      });
      await dwn.processMessage(alice.did, participantWrite.message, { dataStream: participantWrite.dataStream });

      const commentWrite = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : reactionsModule.module,
        modulePath      : 'thread/comment',
        schema          : 'https://reactions.example.com/schemas/comment',
        dataFormat      : 'application/json',
        parentContextId : threadWrite.message.contextId,
      });
      await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });

      const reactionWrite = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : reactionsModule.module,
        modulePath      : 'thread/comment/reaction',
        schema          : 'https://reactions.example.com/schemas/reaction',
        dataFormat      : 'application/json',
        parentContextId : commentWrite.message.contextId,
      });
      await dwn.processMessage(alice.did, reactionWrite.message, { dataStream: reactionWrite.dataStream });

      const threadPrune = await RecordsDelete.create({
        recordId : threadWrite.message.recordId,
        prune    : true,
        signer   : Jws.createSigner(alice),
      });
      expect((await dwn.processMessage(alice.did, threadPrune.message)).status.code).toBe(202);

      // Every descendant is purged — same-module participant, cross-module
      // comment, and the grandchild reaction that lives two levels below a
      // cross-module hop.
      for (const record of [participantWrite, commentWrite, reactionWrite]) {
        const reply = await dwn.processMessage(
          alice.did,
          (await RecordsRead.create({
            signer : Jws.createSigner(alice),
            filter : { recordId: record.message.recordId },
          })).message,
        );
        expect(reply.status.code).toBe(404);
      }

      const reactionsQueryReply = await dwn.processMessage(
        alice.did,
        (await RecordsQuery.create({
          signer : Jws.createSigner(alice),
          filter : { module: reactionsModule.module },
        })).message,
      );
      expect(reactionsQueryReply.status.code).toBe(200);
      expect(reactionsQueryReply.entries).toHaveLength(0);
    });

    it('should cascade across multiple sibling modules rooted at the same parent', async () => {
      // Shape:
      //   thread            (threads) ← pruned
      //     commentsChild   (comments, cross-module sibling A)
      //     reactionsChild  (reactions, cross-module sibling B)
      //       reaction      (reactions, grandchild)
      //
      // Two distinct cross-module children of the same parent, each in its own
      // module, plus a grandchild under one of them. All must be purged.
      const alice = await TestDataGenerator.generateDidKeyPersona();

      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: threadsModule, signer: Jws.createSigner(alice) })).message,
      );
      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: commentsModule, signer: Jws.createSigner(alice) })).message,
      );
      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: reactionsModule, signer: Jws.createSigner(alice) })).message,
      );

      const threadWrite = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        module     : threadsModule.module,
        modulePath : 'thread',
        schema     : 'https://threads.example.com/schemas/thread',
        dataFormat : 'application/json',
      });
      await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });

      const commentsChild = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : commentsModule.module,
        modulePath      : 'thread/comment',
        schema          : 'https://comments.example.com/schemas/comment',
        dataFormat      : 'application/json',
        parentContextId : threadWrite.message.contextId,
      });
      await dwn.processMessage(alice.did, commentsChild.message, { dataStream: commentsChild.dataStream });

      const reactionsChild = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : reactionsModule.module,
        modulePath      : 'thread/comment',
        schema          : 'https://reactions.example.com/schemas/comment',
        dataFormat      : 'application/json',
        parentContextId : threadWrite.message.contextId,
      });
      await dwn.processMessage(alice.did, reactionsChild.message, { dataStream: reactionsChild.dataStream });

      const reaction = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : reactionsModule.module,
        modulePath      : 'thread/comment/reaction',
        schema          : 'https://reactions.example.com/schemas/reaction',
        dataFormat      : 'application/json',
        parentContextId : reactionsChild.message.contextId,
      });
      await dwn.processMessage(alice.did, reaction.message, { dataStream: reaction.dataStream });

      await dwn.processMessage(
        alice.did,
        (await RecordsDelete.create({
          recordId : threadWrite.message.recordId,
          prune    : true,
          signer   : Jws.createSigner(alice),
        })).message,
      );

      for (const record of [commentsChild, reactionsChild, reaction]) {
        const reply = await dwn.processMessage(
          alice.did,
          (await RecordsRead.create({
            signer : Jws.createSigner(alice),
            filter : { recordId: record.message.recordId },
          })).message,
        );
        expect(reply.status.code).toBe(404);
      }

      // Both sibling modules are fully empty of records.
      for (const module of [commentsModule.module, reactionsModule.module]) {
        const queryReply = await dwn.processMessage(
          alice.did,
          (await RecordsQuery.create({
            signer : Jws.createSigner(alice),
            filter : { module },
          })).message,
        );
        expect(queryReply.status.code).toBe(200);
        expect(queryReply.entries).toHaveLength(0);
      }
    });

    it('should fully clean up message store, state index, and data store for cross-module descendants', async () => {
      // Hardening guard: after a cross-module prune cascade no trace of any
      // descendant remains in any of the three underlying storage layers.
      const alice = await TestDataGenerator.generateDidKeyPersona();

      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: threadsModule, signer: Jws.createSigner(alice) })).message,
      );
      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: commentsModule, signer: Jws.createSigner(alice) })).message,
      );

      const threadWrite = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        module     : threadsModule.module,
        modulePath : 'thread',
        schema     : 'https://threads.example.com/schemas/thread',
        dataFormat : 'application/json',
      });
      await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });

      // Cross-module child whose payload is large enough to land in the data
      // store (above the encode-with-message threshold). Forces the dataStore
      // cleanup path to be exercised.
      const largeCommentData = TestDataGenerator.randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1);
      const commentWrite = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : commentsModule.module,
        modulePath      : 'thread/comment',
        schema          : 'https://comments.example.com/schemas/comment',
        dataFormat      : 'application/json',
        parentContextId : threadWrite.message.contextId,
        data            : largeCommentData,
      });
      await dwn.processMessage(alice.did, commentWrite.message, { dataStream: DataStream.fromBytes(largeCommentData) });

      // Sanity: the comment's data landed in the data store.
      expect(
        await dataStore.get(alice.did, commentWrite.message.recordId, commentWrite.message.descriptor.dataCid),
      ).toBeDefined();

      await dwn.processMessage(
        alice.did,
        (await RecordsDelete.create({
          recordId : threadWrite.message.recordId,
          prune    : true,
          signer   : Jws.createSigner(alice),
        })).message,
      );

      // Message store: no residual records for the comment's module.
      const commentsStoreMessages = await messageStore.query(alice.did, [{
        interface : DwnInterfaceName.Records,
        module    : commentsModule.module,
      }]);
      expect(commentsStoreMessages.messages).toHaveLength(0);

      // Data store: comment's data is gone.
      expect(
        await dataStore.get(alice.did, commentWrite.message.recordId, commentWrite.message.descriptor.dataCid),
      ).toBeUndefined();

      // Message store: no messageCid for the comment's RecordsWrite remains.
      const commentRecordsWriteCid = await Message.getCid(commentWrite.message);
      expect(await messageStore.get(alice.did, commentRecordsWriteCid)).toBeUndefined();
    });

    it('should leave cross-module composing children untouched on soft delete (prune omitted)', async () => {
      // Negative control: soft-delete does not cascade. A RecordsDelete without
      // `prune: true` only tombstones the parent and leaves descendants intact,
      // cross-module or otherwise. This test guards against a regression
      // where cascade-always inadvertently broadens soft-delete semantics.
      const alice = await TestDataGenerator.generateDidKeyPersona();

      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: threadsModule, signer: Jws.createSigner(alice) })).message,
      );
      await dwn.processMessage(
        alice.did,
        (await ModulesConfigure.create({ definition: commentsModule, signer: Jws.createSigner(alice) })).message,
      );

      const threadWrite = await TestDataGenerator.generateRecordsWrite({
        author     : alice,
        module     : threadsModule.module,
        modulePath : 'thread',
        schema     : 'https://threads.example.com/schemas/thread',
        dataFormat : 'application/json',
      });
      await dwn.processMessage(alice.did, threadWrite.message, { dataStream: threadWrite.dataStream });

      const commentWrite = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        module          : commentsModule.module,
        modulePath      : 'thread/comment',
        schema          : 'https://comments.example.com/schemas/comment',
        dataFormat      : 'application/json',
        parentContextId : threadWrite.message.contextId,
      });
      await dwn.processMessage(alice.did, commentWrite.message, { dataStream: commentWrite.dataStream });

      // Soft delete the thread (prune omitted).
      expect(
        (await dwn.processMessage(alice.did, (await RecordsDelete.create({
          recordId : threadWrite.message.recordId,
          signer   : Jws.createSigner(alice),
        })).message)).status.code,
      ).toBe(202);

      // The cross-module comment is still readable.
      expect(
        (await dwn.processMessage(alice.did, (await RecordsRead.create({
          signer : Jws.createSigner(alice),
          filter : { recordId: commentWrite.message.recordId },
        })).message)).status.code,
      ).toBe(200);
    });
  });
}
