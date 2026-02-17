import { expect } from 'chai';

import type { Hash, SMTNodeStore } from '../../src/types/smt-types.js';

import { SMTStoreMemory } from '../../src/smt/smt-store-memory.js';
import { SparseMerkleTree } from '../../src/smt/sparse-merkle-tree.js';
import { getBit, getDefaultHashes, hashEquals, hashKey, hashLeaf, initDefaultHashes, SMT_DEPTH, ZERO_HASH } from '../../src/smt/smt-utils.js';

describe('SparseMerkleTree', () => {
  let store: SMTStoreMemory;
  let smt: SparseMerkleTree;

  beforeEach(async () => {
    store = new SMTStoreMemory();
    smt = new SparseMerkleTree(store);
    await smt.initialize();
  });

  afterEach(async () => {
    await smt.close();
  });

  describe('initialization', () => {
    it('should return the default empty root for a new tree', async () => {
      const root = await smt.getRoot();
      const defaultHashes = await initDefaultHashes();
      expect(hashEquals(root, defaultHashes[0])).to.be.true;
    });

    it('should precompute default hashes for all 256 levels + leaf level', async () => {
      const defaultHashes = await initDefaultHashes();
      expect(defaultHashes.length).to.equal(SMT_DEPTH + 1);
      // Leaf level should be zero hash
      expect(hashEquals(defaultHashes[SMT_DEPTH], ZERO_HASH)).to.be.true;
      // Each level should be different from its neighbor
      for (let i = 0; i < SMT_DEPTH; i++) {
        expect(hashEquals(defaultHashes[i], defaultHashes[i + 1])).to.be.false;
      }
    });
  });

  describe('insert', () => {
    it('should change the root hash after inserting a single element', async () => {
      const emptyRoot = await smt.getRoot();
      await smt.insert('bafyreigtest1');
      const newRoot = await smt.getRoot();
      expect(hashEquals(emptyRoot, newRoot)).to.be.false;
    });

    it('should produce different roots for different values', async () => {
      const storeA = new SMTStoreMemory();
      const smtA = new SparseMerkleTree(storeA);
      await smtA.initialize();

      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      await smtA.insert('bafyreigaaa');
      await smtB.insert('bafyreigbbb');

      const rootA = await smtA.getRoot();
      const rootB = await smtB.getRoot();
      expect(hashEquals(rootA, rootB)).to.be.false;

      await smtA.close();
      await smtB.close();
    });

    it('should produce the same root regardless of insertion order', async () => {
      const cids = ['bafyreiA', 'bafyreiB', 'bafyreiC', 'bafyreiD', 'bafyreiE'];

      // Insert in forward order
      const storeA = new SMTStoreMemory();
      const smtA = new SparseMerkleTree(storeA);
      await smtA.initialize();
      for (const cid of cids) {
        await smtA.insert(cid);
      }

      // Insert in reverse order
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();
      for (const cid of [...cids].reverse()) {
        await smtB.insert(cid);
      }

      const rootA = await smtA.getRoot();
      const rootB = await smtB.getRoot();
      expect(hashEquals(rootA, rootB)).to.be.true;

      await smtA.close();
      await smtB.close();
    });

    it('should handle inserting many elements', async () => {
      const cids: string[] = [];
      for (let i = 0; i < 100; i++) {
        cids.push(`bafyreig-test-${i.toString().padStart(4, '0')}`);
      }

      for (const cid of cids) {
        await smt.insert(cid);
      }

      // Verify all exist
      for (const cid of cids) {
        expect(await smt.has(cid)).to.be.true;
      }
    });

    it('should handle re-inserting the same value (idempotent for same key)', async () => {
      await smt.insert('bafyreigtest1');
      const rootAfterFirst = await smt.getRoot();

      await smt.insert('bafyreigtest1');
      const rootAfterSecond = await smt.getRoot();

      expect(hashEquals(rootAfterFirst, rootAfterSecond)).to.be.true;
    });
  });

  describe('has', () => {
    it('should return false for an empty tree', async () => {
      expect(await smt.has('bafyreigtest1')).to.be.false;
    });

    it('should return true for an inserted element', async () => {
      await smt.insert('bafyreigtest1');
      expect(await smt.has('bafyreigtest1')).to.be.true;
    });

    it('should return false for an element not in the tree', async () => {
      await smt.insert('bafyreigtest1');
      expect(await smt.has('bafyreigtest2')).to.be.false;
    });

    it('should return false after deletion', async () => {
      await smt.insert('bafyreigtest1');
      expect(await smt.has('bafyreigtest1')).to.be.true;

      await smt.delete('bafyreigtest1');
      expect(await smt.has('bafyreigtest1')).to.be.false;
    });
  });

  describe('delete', () => {
    it('should return to empty root after inserting and deleting a single element', async () => {
      const emptyRoot = await smt.getRoot();

      await smt.insert('bafyreigtest1');
      const nonEmptyRoot = await smt.getRoot();
      expect(hashEquals(emptyRoot, nonEmptyRoot)).to.be.false;

      await smt.delete('bafyreigtest1');
      const rootAfterDelete = await smt.getRoot();
      expect(hashEquals(emptyRoot, rootAfterDelete)).to.be.true;
    });

    it('should not change the root when deleting a non-existent element', async () => {
      await smt.insert('bafyreigtest1');
      const rootBefore = await smt.getRoot();

      await smt.delete('bafyreigtest2');
      const rootAfter = await smt.getRoot();

      expect(hashEquals(rootBefore, rootAfter)).to.be.true;
    });

    it('should produce the same root regardless of insert-delete order', async () => {
      // Insert A, B, C then delete B
      const storeA = new SMTStoreMemory();
      const smtA = new SparseMerkleTree(storeA);
      await smtA.initialize();
      await smtA.insert('bafyreiA');
      await smtA.insert('bafyreiB');
      await smtA.insert('bafyreiC');
      await smtA.delete('bafyreiB');

      // Insert A, C only (never insert B)
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();
      await smtB.insert('bafyreiA');
      await smtB.insert('bafyreiC');

      const rootA = await smtA.getRoot();
      const rootB = await smtB.getRoot();
      expect(hashEquals(rootA, rootB)).to.be.true;

      await smtA.close();
      await smtB.close();
    });

    it('should handle deleting all elements to return to empty state', async () => {
      const emptyRoot = await smt.getRoot();
      const cids = ['bafyreiA', 'bafyreiB', 'bafyreiC'];

      for (const cid of cids) {
        await smt.insert(cid);
      }

      for (const cid of cids) {
        await smt.delete(cid);
      }

      const rootAfter = await smt.getRoot();
      expect(hashEquals(emptyRoot, rootAfter)).to.be.true;
    });

    it('should handle interleaved inserts and deletes', async () => {
      await smt.insert('bafyreiA');
      await smt.insert('bafyreiB');
      await smt.delete('bafyreiA');
      await smt.insert('bafyreiC');
      await smt.delete('bafyreiB');
      await smt.insert('bafyreiD');

      // Should have C and D
      expect(await smt.has('bafyreiA')).to.be.false;
      expect(await smt.has('bafyreiB')).to.be.false;
      expect(await smt.has('bafyreiC')).to.be.true;
      expect(await smt.has('bafyreiD')).to.be.true;
    });
  });

  describe('proof', () => {
    it('should generate a proof for an existing element (inclusion)', async () => {
      await smt.insert('bafyreigtest1');
      const proof = await smt.getProof('bafyreigtest1');

      expect(proof.leafNode).to.not.be.undefined;
      expect(proof.leafNode!.valueCid).to.equal('bafyreigtest1');
      expect(proof.leafNode!.type).to.equal('leaf');
    });

    it('should generate a proof for a non-existent element (non-inclusion)', async () => {
      await smt.insert('bafyreigtest1');
      const proof = await smt.getProof('bafyreigtest2');

      // Either the leaf is undefined (empty slot) or it's a different key
      if (proof.leafNode !== undefined) {
        // The proof terminates at a leaf with a different key
        const expectedKeyHash = await hashKey('bafyreigtest2');
        expect(hashEquals(proof.leafNode.keyHash, expectedKeyHash)).to.be.false;
      }
    });

    it('should generate an empty proof for an empty tree', async () => {
      const proof = await smt.getProof('bafyreigtest1');
      expect(proof.leafNode).to.be.undefined;
      expect(proof.siblings.length).to.equal(0);
    });
  });

  describe('getSubtreeHash', () => {
    it('should return default hash for empty subtree', async () => {
      const defaultHashes = await initDefaultHashes();
      const subtreeHash = await smt.getSubtreeHash([false]); // left child of root
      expect(hashEquals(subtreeHash, defaultHashes[1])).to.be.true;
    });

    it('should return different hashes for subtrees with different contents', async () => {
      await smt.insert('bafyreigtest1');
      await smt.insert('bafyreigtest2');

      const leftHash = await smt.getSubtreeHash([false]);
      const rightHash = await smt.getSubtreeHash([true]);

      // At least one should be non-default (elements distributed by hash)
      const defaultHashes = await initDefaultHashes();
      const leftIsDefault = hashEquals(leftHash, defaultHashes[1]);
      const rightIsDefault = hashEquals(rightHash, defaultHashes[1]);
      expect(leftIsDefault && rightIsDefault).to.be.false;
    });
  });

  describe('getLeaves', () => {
    it('should return empty array for empty tree', async () => {
      const leaves = await smt.getLeaves([]);
      expect(leaves).to.deep.equal([]);
    });

    it('should return all leaves for empty prefix', async () => {
      const cids = ['bafyreiA', 'bafyreiB', 'bafyreiC'];
      for (const cid of cids) {
        await smt.insert(cid);
      }

      const leaves = await smt.getLeaves([]);
      expect(leaves.sort()).to.deep.equal([...cids].sort());
    });

    it('should return only leaves under the specified prefix', async () => {
      // Insert multiple elements and verify prefix filtering works
      const cids: string[] = [];
      for (let i = 0; i < 20; i++) {
        cids.push(`bafyreig-prefix-test-${i}`);
      }
      for (const cid of cids) {
        await smt.insert(cid);
      }

      // Get leaves under left and right subtrees
      const leftLeaves = await smt.getLeaves([false]);
      const rightLeaves = await smt.getLeaves([true]);

      // Together they should contain all CIDs
      const allLeaves = [...leftLeaves, ...rightLeaves].sort();
      expect(allLeaves).to.deep.equal([...cids].sort());

      // Neither should be empty (with 20 random-ish hashes, both sides should have elements)
      // (This is probabilistic but 20 elements should reliably split)
      expect(leftLeaves.length).to.be.greaterThan(0);
      expect(rightLeaves.length).to.be.greaterThan(0);
    });
  });

  describe('diff', () => {
    it('should return empty diff for identical trees', async () => {
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      const cids = ['bafyreiA', 'bafyreiB', 'bafyreiC'];
      for (const cid of cids) {
        await smt.insert(cid);
        await smtB.insert(cid);
      }

      const diff = await smt.diff(smtB);
      expect(diff.onlyLocal).to.deep.equal([]);
      expect(diff.onlyRemote).to.deep.equal([]);

      await smtB.close();
    });

    it('should return empty diff for two empty trees', async () => {
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      const diff = await smt.diff(smtB);
      expect(diff.onlyLocal).to.deep.equal([]);
      expect(diff.onlyRemote).to.deep.equal([]);

      await smtB.close();
    });

    it('should detect elements only in the local tree', async () => {
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      await smt.insert('bafyreiA');
      await smt.insert('bafyreiB');
      await smtB.insert('bafyreiA');

      const diff = await smt.diff(smtB);
      expect(diff.onlyLocal.sort()).to.deep.equal(['bafyreiB']);
      expect(diff.onlyRemote).to.deep.equal([]);

      await smtB.close();
    });

    it('should detect elements only in the remote tree', async () => {
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      await smt.insert('bafyreiA');
      await smtB.insert('bafyreiA');
      await smtB.insert('bafyreiB');

      const diff = await smt.diff(smtB);
      expect(diff.onlyLocal).to.deep.equal([]);
      expect(diff.onlyRemote.sort()).to.deep.equal(['bafyreiB']);

      await smtB.close();
    });

    it('should detect elements unique to each tree', async () => {
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      // Shared
      await smt.insert('bafyreiShared1');
      await smtB.insert('bafyreiShared1');
      await smt.insert('bafyreiShared2');
      await smtB.insert('bafyreiShared2');

      // Only local
      await smt.insert('bafyreiLocalOnly1');
      await smt.insert('bafyreiLocalOnly2');

      // Only remote
      await smtB.insert('bafyreiRemoteOnly1');
      await smtB.insert('bafyreiRemoteOnly2');
      await smtB.insert('bafyreiRemoteOnly3');

      const diff = await smt.diff(smtB);
      expect(diff.onlyLocal.sort()).to.deep.equal(['bafyreiLocalOnly1', 'bafyreiLocalOnly2'].sort());
      expect(diff.onlyRemote.sort()).to.deep.equal(['bafyreiRemoteOnly1', 'bafyreiRemoteOnly2', 'bafyreiRemoteOnly3'].sort());

      await smtB.close();
    });

    it('should detect all differences when trees are completely disjoint', async () => {
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      await smt.insert('bafyreiA');
      await smt.insert('bafyreiB');
      await smtB.insert('bafyreiC');
      await smtB.insert('bafyreiD');

      const diff = await smt.diff(smtB);
      expect(diff.onlyLocal.sort()).to.deep.equal(['bafyreiA', 'bafyreiB'].sort());
      expect(diff.onlyRemote.sort()).to.deep.equal(['bafyreiC', 'bafyreiD'].sort());

      await smtB.close();
    });

    it('should detect differences in larger trees efficiently', async () => {
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      // Both trees share 50 elements
      for (let i = 0; i < 50; i++) {
        const cid = `bafyreig-shared-${i.toString().padStart(3, '0')}`;
        await smt.insert(cid);
        await smtB.insert(cid);
      }

      // Local has 5 unique elements
      const localOnly: string[] = [];
      for (let i = 0; i < 5; i++) {
        const cid = `bafyreig-local-${i}`;
        await smt.insert(cid);
        localOnly.push(cid);
      }

      // Remote has 3 unique elements
      const remoteOnly: string[] = [];
      for (let i = 0; i < 3; i++) {
        const cid = `bafyreig-remote-${i}`;
        await smtB.insert(cid);
        remoteOnly.push(cid);
      }

      const diff = await smt.diff(smtB);
      expect(diff.onlyLocal.sort()).to.deep.equal(localOnly.sort());
      expect(diff.onlyRemote.sort()).to.deep.equal(remoteOnly.sort());

      await smtB.close();
    });

    it('should handle diff where local tree is empty', async () => {
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      await smtB.insert('bafyreiA');
      await smtB.insert('bafyreiB');

      const diff = await smt.diff(smtB);
      expect(diff.onlyLocal).to.deep.equal([]);
      expect(diff.onlyRemote.sort()).to.deep.equal(['bafyreiA', 'bafyreiB'].sort());

      await smtB.close();
    });

    it('should handle diff where remote tree is empty', async () => {
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      await smt.insert('bafyreiA');
      await smt.insert('bafyreiB');

      const diff = await smt.diff(smtB);
      expect(diff.onlyLocal.sort()).to.deep.equal(['bafyreiA', 'bafyreiB'].sort());
      expect(diff.onlyRemote).to.deep.equal([]);

      await smtB.close();
    });
  });

  describe('clear', () => {
    it('should reset the tree to empty state', async () => {
      const emptyRoot = await smt.getRoot();

      await smt.insert('bafyreiA');
      await smt.insert('bafyreiB');

      await smt.clear();
      const rootAfterClear = await smt.getRoot();

      expect(hashEquals(emptyRoot, rootAfterClear)).to.be.true;
      expect(await smt.has('bafyreiA')).to.be.false;
      expect(await smt.has('bafyreiB')).to.be.false;
    });
  });

  describe('getSubtreeHash with leaf at shallow depth', () => {
    it('should return leaf hash when leaf matches the prefix', async () => {
      // Insert a single element — the tree stores it as a leaf near the root
      await smt.insert('bafyreiA');
      const keyHash = await hashKey('bafyreiA');

      // Build a deep prefix that follows the leaf's keyHash bits
      const matchingPrefix: boolean[] = [];
      for (let i = 0; i < 8; i++) {
        matchingPrefix.push(getBit(keyHash, i));
      }

      const subtreeHash = await smt.getSubtreeHash(matchingPrefix);
      // Should be the leaf hash (non-default) since the leaf is under this prefix
      const expectedLeafHash = await hashLeaf(keyHash, 'bafyreiA');
      expect(hashEquals(subtreeHash, expectedLeafHash)).to.be.true;
    });

    it('should return default hash when leaf does not match the prefix', async () => {
      await smt.insert('bafyreiA');
      const keyHash = await hashKey('bafyreiA');
      const defaultHashes = await initDefaultHashes();

      // Build a prefix that diverges from the leaf's keyHash at bit 0
      const firstBit = getBit(keyHash, 0);
      const nonMatchingPrefix = [!firstBit]; // opposite of the first bit

      const subtreeHash = await smt.getSubtreeHash(nonMatchingPrefix);
      expect(hashEquals(subtreeHash, defaultHashes[1])).to.be.true;
    });
  });

  describe('getLeaves with leaf at shallow depth', () => {
    it('should return the leaf CID when leaf matches the prefix', async () => {
      await smt.insert('bafyreiA');
      const keyHash = await hashKey('bafyreiA');

      // Build a prefix that matches the leaf's keyHash bits
      const matchingPrefix: boolean[] = [];
      for (let i = 0; i < 4; i++) {
        matchingPrefix.push(getBit(keyHash, i));
      }

      const leaves = await smt.getLeaves(matchingPrefix);
      expect(leaves).to.deep.equal(['bafyreiA']);
    });

    it('should return empty when leaf does not match the prefix', async () => {
      await smt.insert('bafyreiA');
      const keyHash = await hashKey('bafyreiA');

      // Build a prefix that diverges from the leaf's keyHash
      const firstBit = getBit(keyHash, 0);
      const nonMatchingPrefix = [!firstBit];

      const leaves = await smt.getLeaves(nonMatchingPrefix);
      expect(leaves).to.deep.equal([]);
    });
  });

  describe('proof', () => {
    it('should generate a multi-level proof with sibling hashes', async () => {
      // Insert two elements so the tree has internal nodes
      await smt.insert('bafyreiA');
      await smt.insert('bafyreiB');

      const proof = await smt.getProof('bafyreiA');
      expect(proof.leafNode).to.not.be.undefined;
      expect(proof.leafNode!.valueCid).to.equal('bafyreiA');
      // With two elements, there should be at least one sibling hash
      expect(proof.siblings.length).to.be.greaterThan(0);
    });
  });

  describe('diff edge cases', () => {
    it('should detect local leaf not present in remote subtree', async () => {
      // We need a scenario where local has a single leaf at a node while remote
      // has an internal subtree at the same position, and the local leaf is NOT
      // in the remote set. This happens when:
      //   - Remote has 2+ elements that share a prefix
      //   - Local has 1 element with the same prefix but a different CID
      const storeB = new SMTStoreMemory();
      const smtB = new SparseMerkleTree(storeB);
      await smtB.initialize();

      // Insert many elements into both trees so they develop deep structure
      const sharedCids: string[] = [];
      for (let i = 0; i < 30; i++) {
        const cid = `bafyreig-shared-${i}`;
        sharedCids.push(cid);
        await smt.insert(cid);
        await smtB.insert(cid);
      }

      // Add unique elements to each side
      const localOnly = 'bafyreig-local-unique-42';
      await smt.insert(localOnly);

      const remoteOnly = 'bafyreig-remote-unique-99';
      await smtB.insert(remoteOnly);

      const diff = await smt.diff(smtB);
      expect(diff.onlyLocal).to.include(localOnly);
      expect(diff.onlyRemote).to.include(remoteOnly);

      await smtB.close();
    });

    it('should handle diff with corrupted/missing nodes via fallback', async () => {
      // Create a custom store that returns undefined for specific node lookups
      const realStore = new SMTStoreMemory();
      const corruptStore: SMTNodeStore = {
        open       : (): Promise<void> => realStore.open(),
        close      : (): Promise<void> => realStore.close(),
        clear      : (): Promise<void> => realStore.clear(),
        getRoot    : (): Promise<Hash | undefined> => realStore.getRoot(),
        setRoot    : (hash: Hash): Promise<void> => realStore.setRoot(hash),
        putNode    : (hash: Hash, node: any): Promise<void> => realStore.putNode(hash, node),
        deleteNode : (hash: Hash): Promise<void> => realStore.deleteNode(hash),
        getNode    : async (hash: Hash): Promise<any> => {
          // Return nodes normally during insertion, but after we
          // switch to diff mode, return undefined for the root node
          if (corruptDuringDiff) {
            return undefined;
          }
          return realStore.getNode(hash);
        },
      };

      let corruptDuringDiff = false;

      // Build a tree using the corrupt store
      const corruptSmt = new SparseMerkleTree(corruptStore);
      await corruptSmt.initialize();
      await corruptSmt.insert('bafyreiCorrupt1');
      await corruptSmt.insert('bafyreiCorrupt2');

      // Build a normal tree with different elements
      const normalStore = new SMTStoreMemory();
      const normalSmt = new SparseMerkleTree(normalStore);
      await normalSmt.initialize();
      await normalSmt.insert('bafyreiNormal1');

      // Now corrupt the store during diff
      corruptDuringDiff = true;

      // The diff should still complete — the fallback handles missing nodes
      const diff = await normalSmt.diff(corruptSmt);

      // Normal tree's elements should be in onlyLocal since the corrupt
      // tree returns no data
      expect(diff.onlyLocal).to.include('bafyreiNormal1');

      corruptDuringDiff = false;
      await corruptSmt.close();
      await normalSmt.close();
    });
  });

  describe('node storage efficiency', () => {
    it('should clean up internal nodes after deletion collapses the tree', async () => {
      await smt.insert('bafyreiA');
      await smt.insert('bafyreiB');
      const sizeAfterInserts = store.size;

      await smt.delete('bafyreiA');
      await smt.delete('bafyreiB');
      const sizeAfterDeletes = store.size;

      // After deleting everything, the store should have fewer nodes than after inserts
      expect(sizeAfterDeletes).to.be.lessThan(sizeAfterInserts);
    });
  });
});

describe('SMT Utility Functions', () => {
  describe('getDefaultHashes', () => {
    it('should return default hashes after initialization', async () => {
      await initDefaultHashes();
      const hashes = getDefaultHashes();
      expect(hashes).to.have.length(SMT_DEPTH + 1);
      expect(hashEquals(hashes[SMT_DEPTH], ZERO_HASH)).to.be.true;
    });
  });

  describe('hashEquals', () => {
    it('should return false for hashes of different lengths', () => {
      const a = new Uint8Array(32);
      const b = new Uint8Array(16);
      expect(hashEquals(a, b)).to.be.false;
    });
  });

  describe('hashKey', () => {
    it('should produce consistent hashes for the same input', async () => {
      const hash1 = await hashKey('bafyreigtest');
      const hash2 = await hashKey('bafyreigtest');
      expect(hashEquals(hash1, hash2)).to.be.true;
    });

    it('should produce different hashes for different inputs', async () => {
      const hash1 = await hashKey('bafyreigtest1');
      const hash2 = await hashKey('bafyreigtest2');
      expect(hashEquals(hash1, hash2)).to.be.false;
    });

    it('should produce 32-byte hashes', async () => {
      const hash = await hashKey('bafyreigtest');
      expect(hash.length).to.equal(32);
    });
  });
});
