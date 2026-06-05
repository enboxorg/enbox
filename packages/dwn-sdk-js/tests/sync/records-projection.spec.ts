import type { GenerateRecordsWriteOutput, Persona } from '../utils/test-data-generator.js';
import type { GenericMessage, KeyValues, MessageStore, RecordsWriteMessage } from '../../src/index.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { lexicographicalCompare } from '../../src/utils/string.js';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestStores } from '../test-stores.js';
import { getBit, hashKey, hashToHex, Jws, Message, RecordsDelete, RecordsProjection, SMTStoreMemory, SparseMerkleTree } from '../../src/index.js';

export function testRecordsProjection(): void {
  describe('RecordsProjection', () => {
    let messageStore: MessageStore;
    let alice: Persona;

    const tenant = (): string => alice.did;

    beforeAll(async () => {
      messageStore = TestStores.get().messageStore;
      await messageStore.open();
    });

    beforeEach(async () => {
      alice = await TestDataGenerator.generatePersona();
      await messageStore.clear();
    });

    afterAll(async () => {
      await messageStore.close();
    });

    it('normalizes duplicate and covered scopes deterministically', () => {
      const scopes = RecordsProjection.normalizeScopes([
        { protocol: 'https://example.com/b', protocolPath: 'note' },
        { protocol: 'https://example.com/a', contextId: 'root' },
        { protocol: 'https://example.com/b' },
        { protocol: 'https://example.com/b', protocolPath: 'note' },
      ]);

      expect(scopes).toEqual([
        { protocol: 'https://example.com/a', contextId: 'root' },
        { protocol: 'https://example.com/b' },
      ]);
    });

    it('normalizes covered context subtree scopes to the broader context', () => {
      const scopes = RecordsProjection.normalizeScopes([
        { protocol: 'https://example.com/a', contextId: 'root/child' },
        { protocol: 'https://example.com/a', contextId: 'root/child/grandchild' },
        { protocol: 'https://example.com/a', contextId: 'root' },
        { protocol: 'https://example.com/a', contextId: 'rootEVIL' },
        { protocol: 'https://example.com/b', contextId: 'root/child' },
        { protocol: 'https://example.com/b', contextId: 'root' },
      ]);

      expect(scopes).toEqual([
        { protocol: 'https://example.com/a', contextId: 'root' },
        { protocol: 'https://example.com/a', contextId: 'rootEVIL' },
        { protocol: 'https://example.com/b', contextId: 'root' },
      ]);
    });

    it('rejects scopes that specify both protocolPath and contextId', () => {
      expect(() => RecordsProjection.normalizeScopes([
        { protocol: 'https://example.com/a', protocolPath: 'note', contextId: 'root' },
      ])).toThrow('protocolPath and contextId scopes are mutually exclusive');
    });

    it('returns primary message CIDs in bytewise order', async () => {
      const messages: GenericMessage[] = [
        createGenericMessage('2026-06-05T00:00:00.000000Z'),
        createGenericMessage('2026-06-05T00:00:01.000000Z'),
        createGenericMessage('2026-06-05T00:00:02.000000Z'),
      ];
      const cidByMessage = new Map<GenericMessage, string>([
        [messages[0], 'bafyZ'],
        [messages[1], 'bafya'],
        [messages[2], 'bafyB'],
      ]);
      const getCidSpy = spyOn(Message, 'getCid').mockImplementation(async (message: GenericMessage) => cidByMessage.get(message)!);

      try {
        const projectedCids = await RecordsProjection.getPrimaryMessageCids({
          tenant       : tenant(),
          messageStore : createQueryOnlyMessageStore(messages),
          scopes       : [{ protocol: 'https://example.com/chat' }],
        });

        expect(projectedCids).toEqual([...cidByMessage.values()].sort(lexicographicalCompare));
      } finally {
        getCidSpy.mockRestore();
      }
    });

    it('projects protocolPath scopes by exact path, not prefix', async () => {
      const protocol = 'https://example.com/chat';
      const root = await createWrite({ protocol, protocolPath: 'thread' });
      const child = await createWrite({
        protocol,
        protocolPath    : 'thread/message',
        parentContextId : root.message.contextId,
      });
      const siblingType = await createWrite({
        protocol,
        protocolPath    : 'thread/messageAttachment',
        parentContextId : root.message.contextId,
      });

      const rootCid = await putWrite(root);
      const childCid = await putWrite(child);
      await putWrite(siblingType);

      const rootPathCids = await RecordsProjection.getPrimaryMessageCids({
        tenant : tenant(),
        messageStore,
        scopes : [{ protocol, protocolPath: 'thread' }],
      });
      expect(rootPathCids).toEqual([rootCid]);

      const childPathCids = await RecordsProjection.getPrimaryMessageCids({
        tenant : tenant(),
        messageStore,
        scopes : [{ protocol, protocolPath: 'thread/message' }],
      });
      expect(childPathCids).toEqual([childCid]);
    });

    it('projects contextId scopes by context subtree boundary', async () => {
      const protocol = 'https://example.com/chat';
      const root = await createWrite({ protocol, protocolPath: 'thread' });
      const child = await createWrite({
        protocol,
        protocolPath    : 'thread/message',
        parentContextId : root.message.contextId,
      });
      const falsePrefix = await createWrite({ protocol, protocolPath: 'thread' });

      const rootCid = await putWrite(root);
      const childCid = await putWrite(child);
      await putWrite(falsePrefix, true, { contextId: `${root.message.contextId}EVIL` });

      const projectedCids = await RecordsProjection.getPrimaryMessageCids({
        tenant : tenant(),
        messageStore,
        scopes : [{ protocol, contextId: root.message.contextId! }],
      });

      expect(projectedCids).toEqual([childCid, rootCid].sort(lexicographicalCompare));
    });

    it('includes RecordsDelete tombstones by indexed initial-write projection metadata', async () => {
      const protocol = 'https://example.com/chat';
      const write = await createWrite({ protocol, protocolPath: 'thread/message' });
      const deleteRecord = await RecordsDelete.create({
        recordId : write.message.recordId,
        signer   : Jws.createSigner(alice),
      });

      await putWrite(write, false);
      const deleteCid = await putDelete(deleteRecord, write.message);

      const projectedCids = await RecordsProjection.getPrimaryMessageCids({
        tenant : tenant(),
        messageStore,
        scopes : [{ protocol, protocolPath: 'thread/message' }],
      });

      expect(projectedCids).toEqual([deleteCid]);
    });

    it('computes the same SMT root, subtree hash, and leaves as the projected CID set', async () => {
      const protocol = 'https://example.com/chat';
      const root = await createWrite({ protocol, protocolPath: 'thread' });
      const child = await createWrite({
        protocol,
        protocolPath    : 'thread/message',
        parentContextId : root.message.contextId,
      });
      const otherProtocol = await createWrite({
        protocol     : 'https://example.com/notes',
        protocolPath : 'note',
      });

      const rootCid = await putWrite(root);
      const childCid = await putWrite(child);
      await putWrite(otherProtocol);

      const scopes = [{ protocol }] as const;
      const expectedCids = [childCid, rootCid].sort(lexicographicalCompare);
      const prefix = await firstBitPrefix(rootCid);
      const expectedTree = await treeValuesFromCids(expectedCids, prefix);
      const rootHex = await RecordsProjection.getRootHex({
        tenant: tenant(),
        messageStore,
        scopes,
      });
      const subtreeHash = await RecordsProjection.getSubtreeHash({
        tenant: tenant(),
        messageStore,
        scopes,
        prefix,
      });
      const leaves = await RecordsProjection.getLeaves({
        tenant: tenant(),
        messageStore,
        scopes,
        prefix,
      });

      expect(rootHex).toBe(expectedTree.rootHex);
      expect(hashToHex(subtreeHash)).toBe(expectedTree.subtreeHex);
      expect(leaves.sort(lexicographicalCompare)).toEqual(expectedTree.leaves);
    });

    async function createWrite(input: {
      protocol: string;
      protocolPath: string;
      parentContextId?: string;
    }): Promise<GenerateRecordsWriteOutput> {
      return TestDataGenerator.generateRecordsWrite({
        author: alice,
        ...input,
      });
    }

    async function putWrite(
      write: GenerateRecordsWriteOutput,
      isLatestBaseState = true,
      indexOverrides: KeyValues = {},
    ): Promise<string> {
      const indexes = {
        ...await write.recordsWrite.constructIndexes(isLatestBaseState),
        ...indexOverrides,
      };
      await messageStore.put(tenant(), write.message, indexes);
      return Message.getCid(write.message);
    }

    async function putDelete(
      recordsDelete: RecordsDelete,
      initialWrite: RecordsWriteMessage,
    ): Promise<string> {
      await messageStore.put(
        tenant(),
        recordsDelete.message,
        recordsDelete.constructIndexes(initialWrite)
      );
      return Message.getCid(recordsDelete.message);
    }
  });
}

function createGenericMessage(messageTimestamp: string): GenericMessage {
  return {
    descriptor: {
      interface : 'Records',
      method    : 'Write',
      messageTimestamp,
    },
  };
}

function createQueryOnlyMessageStore(messages: GenericMessage[]): MessageStore {
  return {
    clear  : async (): Promise<void> => {},
    close  : async (): Promise<void> => {},
    count  : async (): Promise<number> => messages.length,
    delete : async (): Promise<void> => {},
    get    : async (): Promise<GenericMessage | undefined> => undefined,
    open   : async (): Promise<void> => {},
    put    : async (): Promise<void> => {},
    query  : async (): Promise<{ messages: GenericMessage[] }> => ({ messages }),
  };
}

async function firstBitPrefix(messageCid: string): Promise<boolean[]> {
  const keyHash = await hashKey(messageCid);
  return [getBit(keyHash, 0)];
}

async function treeValuesFromCids(
  messageCids: string[],
  prefix: boolean[],
): Promise<{ rootHex: string; subtreeHex: string; leaves: string[] }> {
  const tree = new SparseMerkleTree(new SMTStoreMemory());
  await tree.initialize();

  try {
    for (const messageCid of messageCids) {
      await tree.insert(messageCid);
    }

    const leaves = await tree.getLeaves(prefix);
    return {
      rootHex    : hashToHex(await tree.getRoot()),
      subtreeHex : hashToHex(await tree.getSubtreeHash(prefix)),
      leaves     : leaves.sort(lexicographicalCompare),
    };
  } finally {
    await tree.close();
  }
}
