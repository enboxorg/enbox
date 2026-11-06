import type { GenerateRecordsWriteOutput, Persona } from '../utils/test-data-generator.js';
import type { ModuleDefinition, RecordsSubscribeReply } from '../../src/index.js';
import type { SubscriptionEvent, SubscriptionMessage } from '../../src/types/subscriptions.js';

import { Poller } from '../utils/poller.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventLog } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, DateSort, Dwn, DwnErrorCode, Encoder, Jws, Message, Modules, RecordsDelete, RecordsRead, RecordsSubscribe, RecordsWrite, Time } from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

const coreUri = 'https://example.com/composition-acceptance/core';
const tasksUri = 'https://example.com/composition-acceptance/tasks';
const commentsUri = 'https://example.com/composition-acceptance/comments';

function coreDefinition(): ModuleDefinition {
  return {
    module    : coreUri, published : true, types     : { workspace: {}, member: {}, board: {} },
    structure : { workspace: { member: { $role: true }, board: {} } },
  };
}

function tasksDefinition(): ModuleDefinition {
  return {
    module    : tasksUri, published : true, uses      : { core: coreUri }, types     : { task: {} },
    structure : { board: { $ref: 'core:workspace/board', task: {} } },
  };
}

function commentsDefinition(): ModuleDefinition {
  return {
    module    : commentsUri, published : true, uses      : { tasks: tasksUri, members: coreUri },
    types     : { comment: {}, reaction: {} },
    structure : {
      task: {
        $ref    : 'tasks:board/task',
        comment : { $actions: [{ role: 'members:workspace/member', can: ['read'] }], reaction: {} },
      },
    },
  };
}

/** Exercises composition contracts through signed messages and real injectable DWN stores. */
export function testModuleCompositionAcceptance(): void {
  describe('Composed module acceptance', () => {
    let dwn: Dwn;
    let alice: Persona;
    let bob: Persona;
    let clock: number;

    beforeAll(async () => {
      dwn = await Dwn.create({
        ...TestStores.get(),
        eventLog    : TestEventLog.get(),
        didResolver : new UniversalResolver({ didResolvers: [DidKey] }),
      });
    });

    beforeEach(async () => {
      const stores = TestStores.get();
      await stores.messageStore.clear();
      await stores.dataStore.clear();
      await stores.resumableTaskStore.clear();
      alice = await TestDataGenerator.generateDidKeyPersona();
      bob = await TestDataGenerator.generateDidKeyPersona();
      clock = 0;
    });

    afterAll(async () => { await dwn.close(); });

    function nextTimestamp(): string {
      return Time.createOffsetTimestamp({ seconds: clock++ }, '2025-01-01T00:00:00.000000Z');
    }

    async function configure(definition: ModuleDefinition): Promise<void> {
      const configuration = await TestDataGenerator.generateModulesConfigure({
        author: alice, moduleDefinition: definition, messageTimestamp: nextTimestamp(),
      });
      const reply = await dwn.processMessage(alice.did, configuration.message);
      expect(reply.status.code, reply.status.detail).toBe(202);
    }

    async function write(
      module: string, modulePath: string, parentContextId?: string,
      options: { recipient?: string; squash?: true } = {},
    ): Promise<GenerateRecordsWriteOutput> {
      const timestamp = nextTimestamp();
      const record = await TestDataGenerator.generateRecordsWrite({
        author           : alice, module, modulePath, parentContextId, ...options,
        dateCreated      : timestamp, messageTimestamp : timestamp,
        data             : Encoder.objectToBytes({ ordinal: clock }), dataFormat       : 'application/json',
      });
      const reply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
      expect(reply.status.code, reply.status.detail).toBe(202);
      return record;
    }

    async function recordIds(module: string, modulePath: string, contextId?: string): Promise<string[]> {
      const query = await TestDataGenerator.generateRecordsQuery({
        author: alice, filter: { module, modulePath, contextId }, dateSort: DateSort.CreatedAscending,
      });
      const reply = await dwn.processMessage(alice.did, query.message);
      expect(reply.status.code, reply.status.detail).toBe(200);
      return reply.entries!.map(entry => entry.recordId);
    }

    async function installTaskChain(): Promise<void> {
      for (const definition of [coreDefinition(), tasksDefinition(), commentsDefinition()]) {
        await configure(definition);
      }
    }

    async function taskTree(existingWorkspace?: GenerateRecordsWriteOutput): Promise<{
      workspace: GenerateRecordsWriteOutput;
      board: GenerateRecordsWriteOutput;
      task: GenerateRecordsWriteOutput;
    }> {
      const workspace = existingWorkspace ?? await write(coreUri, 'workspace');
      const board = await write(coreUri, 'workspace/board', workspace.message.contextId);
      const task = await write(tasksUri, 'board/task', board.message.contextId);
      return { workspace, board, task };
    }

    function events(messages: SubscriptionMessage[]): SubscriptionEvent[] {
      return messages.filter((message): message is SubscriptionEvent => message.type === 'event');
    }

    it('subscribes to a deep chained foreign-role context, isolates snapshots and live events, and stops after revocation', async () => {
      await installTaskChain();
      const tree = await taskTree();
      const sibling = await write(tasksUri, 'board/task', tree.board.message.contextId);
      const otherWorkspace = await taskTree();
      const membership = await write(coreUri, 'workspace/member', tree.workspace.message.contextId, { recipient: bob.did });
      const initial = await write(commentsUri, 'task/comment', tree.task.message.contextId);
      await write(commentsUri, 'task/comment', sibling.message.contextId);
      await write(commentsUri, 'task/comment', otherWorkspace.task.message.contextId);

      const moduleRole = 'members:workspace/member';
      const denied = await RecordsSubscribe.create({
        signer : Jws.createSigner(bob), moduleRole,
        filter : { module: commentsUri, modulePath: 'task/comment', contextId: otherWorkspace.task.message.contextId },
      });
      expect((await dwn.processMessage(alice.did, denied.message, { subscriptionHandler: (): void => {} })).status.code).toBe(401);

      const received: SubscriptionMessage[] = [];
      const subscribe = await RecordsSubscribe.create({
        signer : Jws.createSigner(bob), moduleRole,
        filter : { module: commentsUri, modulePath: 'task/comment', contextId: tree.task.message.contextId },
      });
      expect(tree.task.message.contextId.split('/')).toHaveLength(3);
      const reply = await dwn.processMessage(alice.did, subscribe.message, {
        subscriptionHandler: (message): void => { received.push(message); },
      }) as RecordsSubscribeReply;
      expect(reply.status.code, reply.status.detail).toBe(200);
      expect(reply.entries?.map(entry => entry.recordId)).toEqual([initial.message.recordId]);
      expect(reply.subscription).toBeDefined();

      try {
        await write(commentsUri, 'task/comment', sibling.message.contextId);
        const live = await write(commentsUri, 'task/comment', tree.task.message.contextId);
        const updateBytes = Encoder.objectToBytes({ edited: true });
        const update = await RecordsWrite.createFrom({
          recordsWriteMessage : initial.message, signer              : Jws.createSigner(alice),
          data                : updateBytes, messageTimestamp    : nextTimestamp(),
        });
        expect((await dwn.processMessage(alice.did, update.message, { dataStream: DataStream.fromBytes(updateBytes) })).status.code).toBe(202);
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(await Promise.all(events(received).map(entry => Message.getCid(entry.event.message))))
            .toEqual([await Message.getCid(live.message), await Message.getCid(update.message)]);
        });

        const revoke = await RecordsDelete.create({ recordId: membership.message.recordId, signer: Jws.createSigner(alice) });
        expect((await dwn.processMessage(alice.did, revoke.message)).status.code).toBe(202);
        await write(commentsUri, 'task/comment', tree.task.message.contextId);
        await Poller.pollUntilSuccessOrTimeout(async () => {
          expect(received.filter(message => message.type === 'error')).toHaveLength(1);
        });
        expect(received.find(message => message.type === 'error')?.error.code)
          .toBe(DwnErrorCode.RecordsSubscribeDeliveryAuthorizationFailed);
        expect(events(received)).toHaveLength(2);
      } finally {
        await reply.subscription!.close();
      }
    });

    async function keyedRoleChain(): Promise<{ provider: ModuleDefinition; bridge: ModuleDefinition; consumer: ModuleDefinition }> {
      const provider = await Modules.deriveAndInjectPublicEncryptionKeys({
        module: coreUri, published: true, types: { member: {} }, structure: { member: { $role: true } },
      }, TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk));
      const bridge: ModuleDefinition = {
        module    : tasksUri, published : true, uses      : { provider: coreUri }, types     : { receipt: {} },
        structure : { member: { $ref: 'provider:member', receipt: {} } },
      };
      const consumer = await Modules.deriveAndInjectPublicEncryptionKeys({
        module    : commentsUri, published : true, uses      : { bridge: tasksUri }, types     : { note: { encryptionRequired: true } },
        structure : { note: { $actions: [{ role: 'bridge:member', can: ['read'] }] } },
      }, TestDataGenerator.createModulePathKeyDeriver(alice.keyId, alice.encryptionKeyPair.privateJwk));
      for (const definition of [provider, bridge, consumer]) {
        await configure(definition);
      }
      return { provider, bridge, consumer };
    }

    it('rejects an update that breaks a transitive encrypted consumer even when the direct consumer contract remains valid', async () => {
      const { provider, consumer } = await keyedRoleChain();
      expect(Object.values(consumer.uses!)).toEqual([tasksUri]);
      const incompatible = structuredClone(provider);
      delete incompatible.structure.member.$keyAgreement;
      const update = await TestDataGenerator.generateModulesConfigure({
        author: alice, moduleDefinition: incompatible, messageTimestamp: nextTimestamp(),
      });
      const reply = await dwn.processMessage(alice.did, update.message);
      expect(reply.status.code).toBe(400);
      expect(reply.status.detail).toContain(DwnErrorCode.ModulesConfigureIncompatibleContractUpdate);
      expect(reply.status.detail).toContain(commentsUri);
      expect(reply.status.detail).toContain(DwnErrorCode.ModulesConfigureInvalidEncryptedRoleMissingKeyAgreement);
      const query = await TestDataGenerator.generateModulesQuery({ author: alice, filter: { module: coreUri } });
      const current = await dwn.processMessage(alice.did, query.message);
      expect(current.entries?.[0].descriptor.definition).toEqual(provider);
    });

    it('accepts runtime-key-only provider changes through a transitive dependency chain', async () => {
      const { provider, bridge, consumer } = await keyedRoleChain();
      const changedKeys = await Modules.deriveAndInjectPublicEncryptionKeys(
        provider, TestDataGenerator.createModulePathKeyDeriver(bob.keyId, bob.encryptionKeyPair.privateJwk)
      );
      expect(changedKeys.structure.member.$keyAgreement).not.toEqual(provider.structure.member.$keyAgreement);
      await configure(changedKeys);
      for (const definition of [changedKeys, bridge, consumer]) {
        const query = await TestDataGenerator.generateModulesQuery({ author: alice, filter: { module: definition.module } });
        const reply = await dwn.processMessage(alice.did, query.message);
        expect(reply.status.code).toBe(200);
        expect(reply.entries?.[0].descriptor.definition).toEqual(definition);
      }
      await configure(consumer);
    });

    async function lifecycleConsumers(): Promise<{
      workspace: GenerateRecordsWriteOutput;
      firstBoard: GenerateRecordsWriteOutput;
      secondBoard: GenerateRecordsWriteOutput;
    }> {
      await configure(coreDefinition());
      for (const module of [tasksUri, commentsUri]) {
        await configure({
          module, published : true, uses      : { core: coreUri }, types     : { slot: {}, patch: {} },
          structure : {
            board: {
              $ref  : 'core:workspace/board',
              slot  : { $recordLimit: { max: 1 } },
              patch : { $squash: true, $immutable: true },
            },
          },
        });
      }
      const workspace = await write(coreUri, 'workspace');
      const firstBoard = await write(coreUri, 'workspace/board', workspace.message.contextId);
      const secondBoard = await write(coreUri, 'workspace/board', workspace.message.contextId);
      return { workspace, firstBoard, secondBoard };
    }

    it('isolates record-limit populations by consumer and deep physical parent for queries, counts, and snapshots', async () => {
      const { workspace, firstBoard, secondBoard } = await lifecycleConsumers();
      const populations: { module: string; parent: GenerateRecordsWriteOutput; visible: GenerateRecordsWriteOutput }[] = [];
      for (const [module, parent] of [[tasksUri, firstBoard], [commentsUri, firstBoard], [tasksUri, secondBoard]] as const) {
        const visible = await write(module, 'board/slot', parent.message.contextId);
        await write(module, 'board/slot', parent.message.contextId);
        populations.push({ module, parent, visible });
      }
      for (const { module, parent, visible } of populations) {
        const filter = { module, modulePath: 'board/slot', contextId: parent.message.contextId };
        expect(await recordIds(module, filter.modulePath, filter.contextId)).toEqual([visible.message.recordId]);
        // A full physical record context has three segments even though its declared path has two.
        expect(await recordIds(module, filter.modulePath, visible.message.contextId)).toEqual([visible.message.recordId]);
        const count = await TestDataGenerator.generateRecordsCount({ author: alice, filter });
        expect((await dwn.processMessage(alice.did, count.message)).count).toBe(1);
        const subscribe = await RecordsSubscribe.create({ signer: Jws.createSigner(alice), filter });
        const reply = await dwn.processMessage(alice.did, subscribe.message, { subscriptionHandler: (): void => {} }) as RecordsSubscribeReply;
        expect(reply.status.code).toBe(200);
        expect(reply.entries?.map(entry => entry.recordId)).toEqual([visible.message.recordId]);
        await reply.subscription!.close();
      }
      expect(await recordIds(tasksUri, 'board/slot', workspace.message.contextId))
        .toEqual([populations[0].visible.message.recordId, populations[2].visible.message.recordId]);
    });

    it('squashes only the matching consumer, local path, and deep physical parent', async () => {
      const { firstBoard, secondBoard } = await lifecycleConsumers();
      const firstPatch = await write(tasksUri, 'board/patch', firstBoard.message.contextId);
      const secondPatch = await write(tasksUri, 'board/patch', firstBoard.message.contextId);
      const otherConsumer = await write(commentsUri, 'board/patch', firstBoard.message.contextId);
      const otherParent = await write(tasksUri, 'board/patch', secondBoard.message.contextId);
      const otherPath = await write(tasksUri, 'board/slot', firstBoard.message.contextId);
      const snapshot = await write(tasksUri, 'board/patch', firstBoard.message.contextId, { squash: true });

      expect(await recordIds(tasksUri, 'board/patch', firstBoard.message.contextId)).toEqual([snapshot.message.recordId]);
      expect(await recordIds(commentsUri, 'board/patch', firstBoard.message.contextId)).toEqual([otherConsumer.message.recordId]);
      expect(await recordIds(tasksUri, 'board/patch', secondBoard.message.contextId)).toEqual([otherParent.message.recordId]);
      expect(await recordIds(tasksUri, 'board/slot', firstBoard.message.contextId)).toEqual([otherPath.message.recordId]);
      for (const purged of [firstPatch, secondPatch]) {
        const { messages } = await TestStores.get().messageStore.query(alice.did, [{ recordId: purged.message.recordId }]);
        expect(messages).toHaveLength(0);
      }
    });

    it('prunes an A to B to C attachment chain while preserving a sibling physical tree', async () => {
      await installTaskChain();
      const first = await taskTree();
      const second = await taskTree(first.workspace);
      const comment = await write(commentsUri, 'task/comment', first.task.message.contextId);
      const reaction = await write(commentsUri, 'task/comment/reaction', comment.message.contextId);
      const siblingComment = await write(commentsUri, 'task/comment', second.task.message.contextId);
      const prune = await RecordsDelete.create({ recordId: first.board.message.recordId, prune: true, signer: Jws.createSigner(alice) });
      expect((await dwn.processMessage(alice.did, prune.message)).status.code).toBe(202);

      for (const purged of [first.task, comment, reaction]) {
        const { messages } = await TestStores.get().messageStore.query(alice.did, [{ recordId: purged.message.recordId }]);
        expect(messages).toHaveLength(0);
      }
      for (const retained of [first.workspace, second.board, second.task, siblingComment]) {
        const read = await RecordsRead.create({ signer: Jws.createSigner(alice), filter: { recordId: retained.message.recordId } });
        const reply = await dwn.processMessage(alice.did, read.message);
        expect(reply.status.code).toBe(200);
      }
    });
  });
}
