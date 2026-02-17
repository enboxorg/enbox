import { expect } from 'chai';

import { SMTStoreLevel } from '../../src/smt/smt-store-level.js';
import { SMTStoreMemory } from '../../src/smt/smt-store-memory.js';
import { SparseMerkleTree } from '../../src/smt/sparse-merkle-tree.js';
import { hashEquals, initDefaultHashes } from '../../src/smt/smt-utils.js';

let testCounter = 0;
function uniqueLocation(prefix: string): string {
  return `TEST-SMT-LEVEL-${prefix}-${Date.now()}-${testCounter++}`;
}

describe('SMTStoreLevel', () => {
  let store: SMTStoreLevel;
  let smt: SparseMerkleTree;

  beforeEach(async () => {
    store = new SMTStoreLevel({ location: uniqueLocation('main') });
    smt = new SparseMerkleTree(store);
    await smt.initialize();
  });

  afterEach(async () => {
    await smt.clear();
    await smt.close();
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
    const storeA = new SMTStoreLevel({ location: uniqueLocation('order-A') });
    const smtA = new SparseMerkleTree(storeA);
    await smtA.initialize();

    const storeB = new SMTStoreLevel({ location: uniqueLocation('order-B') });
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
    await smtB.clear();
    await smtB.close();
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
});
