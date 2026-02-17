import { expect } from 'chai';

import { SMTStoreLevel } from '../../src/smt/smt-store-level.js';
import { SMTStoreMemory } from '../../src/smt/smt-store-memory.js';
import { SparseMerkleTree } from '../../src/smt/sparse-merkle-tree.js';
import { createLevelDatabase, LevelWrapper } from '../../src/store/level-wrapper.js';
import { hashEquals, initDefaultHashes } from '../../src/smt/smt-utils.js';

let testCounter = 0;
function uniqueLocation(prefix: string): string {
  return `TEST-SMT-LEVEL-${prefix}-${Date.now()}-${testCounter++}`;
}

/** Create an opened LevelWrapper and return a sublevel partition from it. */
async function createSublevel(prefix: string): Promise<{ db: LevelWrapper<string>; sublevel: LevelWrapper<string> }> {
  const db = new LevelWrapper<string>({
    location            : uniqueLocation(prefix),
    createLevelDatabase : createLevelDatabase,
    keyEncoding         : 'utf8',
  });
  await db.open();
  const sublevel = await db.partition('smt');
  return { db, sublevel };
}

describe('SMTStoreLevel', () => {
  let parentDb: LevelWrapper<string>;
  let store: SMTStoreLevel;
  let smt: SparseMerkleTree;

  beforeEach(async () => {
    const { db, sublevel } = await createSublevel('main');
    parentDb = db;
    store = new SMTStoreLevel(sublevel);
    smt = new SparseMerkleTree(store);
    await smt.initialize();
  });

  afterEach(async () => {
    await smt.clear();
    await smt.close();
    await parentDb.close();
  });

  it('should persist root hash across operations', async () => {
    const emptyRoot = await smt.getRoot();

    await smt.insert('bafyreigtest1');
    const root = await smt.getRoot();
    expect(hashEquals(emptyRoot, root)).to.be.false;

    // Root should be retrievable after insertion
    const rootAgain = await smt.getRoot();
    expect(hashEquals(root, rootAgain)).to.be.true;
  });

  it('should handle insert and delete with LevelDB persistence', async () => {
    await smt.insert('bafyreigtest1');
    await smt.insert('bafyreigtest2');
    await smt.insert('bafyreigtest3');

    expect(await smt.has('bafyreigtest1')).to.be.true;
    expect(await smt.has('bafyreigtest2')).to.be.true;
    expect(await smt.has('bafyreigtest3')).to.be.true;

    await smt.delete('bafyreigtest2');
    expect(await smt.has('bafyreigtest1')).to.be.true;
    expect(await smt.has('bafyreigtest2')).to.be.false;
    expect(await smt.has('bafyreigtest3')).to.be.true;
  });

  it('should produce order-independent roots with LevelDB', async () => {
    const helperA = await createSublevel('order-A');
    const storeA = new SMTStoreLevel(helperA.sublevel);
    const smtA = new SparseMerkleTree(storeA);
    await smtA.initialize();

    const helperB = await createSublevel('order-B');
    const storeB = new SMTStoreLevel(helperB.sublevel);
    const smtB = new SparseMerkleTree(storeB);
    await smtB.initialize();

    const cids = ['bafyreiX', 'bafyreiY', 'bafyreiZ'];

    // Insert in order
    for (const cid of cids) {
      await smtA.insert(cid);
    }

    // Insert in reverse
    for (const cid of [...cids].reverse()) {
      await smtB.insert(cid);
    }

    const rootA = await smtA.getRoot();
    const rootB = await smtB.getRoot();
    expect(hashEquals(rootA, rootB)).to.be.true;

    await smtA.clear();
    await smtA.close();
    await helperA.db.close();
    await smtB.clear();
    await smtB.close();
    await helperB.db.close();
  });

  it('should support diff between LevelDB-backed and in-memory trees', async () => {
    // Use an in-memory store for the remote tree to avoid LevelDB cross-contamination
    const storeB = new SMTStoreMemory();
    const smtB = new SparseMerkleTree(storeB);
    await smtB.initialize();

    // Shared
    await smt.insert('bafyreiShared');
    await smtB.insert('bafyreiShared');

    // Unique
    await smt.insert('bafyreiLocalOnly');
    await smtB.insert('bafyreiRemoteOnly');

    const diff = await smt.diff(smtB);
    expect(diff.onlyLocal.sort()).to.deep.equal(['bafyreiLocalOnly']);
    expect(diff.onlyRemote.sort()).to.deep.equal(['bafyreiRemoteOnly']);

    await smtB.close();
  });

  it('should clear all data and return to empty state', async () => {
    const defaultHashes = await initDefaultHashes();

    await smt.insert('bafyreiA');
    await smt.insert('bafyreiB');

    await smt.clear();
    const root = await smt.getRoot();
    expect(hashEquals(root, defaultHashes[0])).to.be.true;
    expect(await smt.has('bafyreiA')).to.be.false;
  });

  it('should throw when calling methods before open()', async () => {
    const { db, sublevel } = await createSublevel('uninit');
    const uninitStore = new SMTStoreLevel(sublevel);

    try {
      await uninitStore.getNode(new Uint8Array(32));
      expect.fail('Expected an error');
    } catch (e: any) {
      expect(e.message).to.include('not initialized');
    }

    await db.close();
  });

  it('should return undefined for a non-existent node hash', async () => {
    // This tests the early-return path at lines 72-74 of smt-store-level.ts
    const randomHash = new Uint8Array(32);
    randomHash[0] = 0xff; // ensure it's not all zeros
    const node = await store.getNode(randomHash);
    expect(node).to.be.undefined;
  });
});
