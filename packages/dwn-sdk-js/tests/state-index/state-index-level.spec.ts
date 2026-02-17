import { expect } from 'chai';

import { StateIndexLevel } from '../../src/state-index/state-index-level.js';
import { hashEquals, initDefaultHashes } from '../../src/smt/smt-utils.js';

let testCounter = 0;
function uniqueLocation(): string {
  return `TEST-STATEINDEX-${Date.now()}-${testCounter++}`;
}

describe('StateIndexLevel', () => {
  let stateIndex: StateIndexLevel;

  beforeEach(async () => {
    stateIndex = new StateIndexLevel({ location: uniqueLocation() });
    await stateIndex.open();
  });

  afterEach(async () => {
    await stateIndex.clear();
    await stateIndex.close();
  });

  describe('insert and getRoot', () => {
    it('should return default empty root for a new tenant', async () => {
      const defaultHashes = await initDefaultHashes();
      const root = await stateIndex.getRoot('did:test:alice');
      expect(hashEquals(root, defaultHashes[0])).to.be.true;
    });

    it('should change the root after inserting a message', async () => {
      const defaultHashes = await initDefaultHashes();
      const tenant = 'did:test:alice';

      await stateIndex.insert(tenant, 'bafyreig-msg-1', { interface: 'Records', method: 'Write' });

      const root = await stateIndex.getRoot(tenant);
      expect(hashEquals(root, defaultHashes[0])).to.be.false;
    });

    it('should maintain separate roots per tenant', async () => {
      await stateIndex.insert('did:test:alice', 'bafyreig-msg-1', { interface: 'Records', method: 'Write' });
      await stateIndex.insert('did:test:bob', 'bafyreig-msg-2', { interface: 'Records', method: 'Write' });

      const aliceRoot = await stateIndex.getRoot('did:test:alice');
      const bobRoot = await stateIndex.getRoot('did:test:bob');

      // Different messages -> different roots
      expect(hashEquals(aliceRoot, bobRoot)).to.be.false;
    });

    it('should produce order-independent roots', async () => {
      const tenant = 'did:test:alice';

      const indexA = new StateIndexLevel({ location: uniqueLocation() });
      await indexA.open();
      const indexB = new StateIndexLevel({ location: uniqueLocation() });
      await indexB.open();

      const indexes = { interface: 'Records', method: 'Write' };

      await indexA.insert(tenant, 'bafyreig-1', indexes);
      await indexA.insert(tenant, 'bafyreig-2', indexes);
      await indexA.insert(tenant, 'bafyreig-3', indexes);

      await indexB.insert(tenant, 'bafyreig-3', indexes);
      await indexB.insert(tenant, 'bafyreig-1', indexes);
      await indexB.insert(tenant, 'bafyreig-2', indexes);

      const rootA = await indexA.getRoot(tenant);
      const rootB = await indexB.getRoot(tenant);
      expect(hashEquals(rootA, rootB)).to.be.true;

      await indexA.clear();
      await indexA.close();
      await indexB.clear();
      await indexB.close();
    });
  });

  describe('delete', () => {
    it('should return to empty root after deleting all messages', async () => {
      const defaultHashes = await initDefaultHashes();
      const tenant = 'did:test:alice';
      const indexes = { interface: 'Records', method: 'Write' };

      await stateIndex.insert(tenant, 'bafyreig-1', indexes);
      await stateIndex.insert(tenant, 'bafyreig-2', indexes);

      await stateIndex.delete(tenant, ['bafyreig-1', 'bafyreig-2']);

      const root = await stateIndex.getRoot(tenant);
      expect(hashEquals(root, defaultHashes[0])).to.be.true;
    });

    it('should only delete the specified messages', async () => {
      const defaultHashes = await initDefaultHashes();
      const tenant = 'did:test:alice';
      const indexes = { interface: 'Records', method: 'Write' };

      await stateIndex.insert(tenant, 'bafyreig-1', indexes);
      await stateIndex.insert(tenant, 'bafyreig-2', indexes);

      await stateIndex.delete(tenant, ['bafyreig-1']);

      const root = await stateIndex.getRoot(tenant);
      // Not empty — still has bafyreig-2
      expect(hashEquals(root, defaultHashes[0])).to.be.false;
    });
  });

  describe('protocol-scoped trees', () => {
    it('should maintain separate protocol roots', async () => {
      const tenant = 'did:test:alice';

      await stateIndex.insert(tenant, 'bafyreig-chat-1', {
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://example.com/chat',
      });
      await stateIndex.insert(tenant, 'bafyreig-social-1', {
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://example.com/social',
      });

      const chatRoot = await stateIndex.getProtocolRoot(tenant, 'https://example.com/chat');
      const socialRoot = await stateIndex.getProtocolRoot(tenant, 'https://example.com/social');

      // Different protocols have different roots
      expect(hashEquals(chatRoot, socialRoot)).to.be.false;
    });

    it('should update both global and protocol trees on insert', async () => {
      const defaultHashes = await initDefaultHashes();
      const tenant = 'did:test:alice';

      await stateIndex.insert(tenant, 'bafyreig-chat-1', {
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://example.com/chat',
      });

      const globalRoot = await stateIndex.getRoot(tenant);
      const chatRoot = await stateIndex.getProtocolRoot(tenant, 'https://example.com/chat');

      // Both should be non-empty
      expect(hashEquals(globalRoot, defaultHashes[0])).to.be.false;
      expect(hashEquals(chatRoot, defaultHashes[0])).to.be.false;
    });

    it('should remove from both global and protocol trees on delete', async () => {
      const defaultHashes = await initDefaultHashes();
      const tenant = 'did:test:alice';

      await stateIndex.insert(tenant, 'bafyreig-chat-1', {
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://example.com/chat',
      });

      await stateIndex.delete(tenant, ['bafyreig-chat-1']);

      const globalRoot = await stateIndex.getRoot(tenant);
      const chatRoot = await stateIndex.getProtocolRoot(tenant, 'https://example.com/chat');

      // Both should be empty
      expect(hashEquals(globalRoot, defaultHashes[0])).to.be.true;
      expect(hashEquals(chatRoot, defaultHashes[0])).to.be.true;
    });

    it('should return empty protocol root for unscoped messages', async () => {
      const defaultHashes = await initDefaultHashes();
      const tenant = 'did:test:alice';

      // Insert a message without a protocol (e.g., ProtocolsConfigure)
      await stateIndex.insert(tenant, 'bafyreig-config-1', {
        interface : 'Protocols',
        method    : 'Configure',
      });

      // Protocol-scoped root should be empty since no messages with this protocol exist
      const protoRoot = await stateIndex.getProtocolRoot(tenant, 'https://example.com/chat');
      expect(hashEquals(protoRoot, defaultHashes[0])).to.be.true;

      // But global root should not be empty
      const globalRoot = await stateIndex.getRoot(tenant);
      expect(hashEquals(globalRoot, defaultHashes[0])).to.be.false;
    });
  });

  describe('getProtocolSubtreeHash', () => {
    it('should return protocol-scoped subtree hashes', async () => {
      const defaultHashes = await initDefaultHashes();
      const tenant = 'did:test:alice';

      await stateIndex.insert(tenant, 'bafyreig-chat-1', {
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://example.com/chat',
      });
      await stateIndex.insert(tenant, 'bafyreig-chat-2', {
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://example.com/chat',
      });

      const leftHash = await stateIndex.getProtocolSubtreeHash(tenant, 'https://example.com/chat', [false]);
      const rightHash = await stateIndex.getProtocolSubtreeHash(tenant, 'https://example.com/chat', [true]);

      // At least one should be non-default
      const leftIsDefault = hashEquals(leftHash, defaultHashes[1]);
      const rightIsDefault = hashEquals(rightHash, defaultHashes[1]);
      expect(leftIsDefault && rightIsDefault).to.be.false;
    });
  });

  describe('delete non-existent messageCid', () => {
    it('should be a no-op when deleting a messageCid that was never inserted', async () => {
      const defaultHashes = await initDefaultHashes();
      const tenant = 'did:test:alice';

      // Delete a CID that was never inserted — should not throw
      await stateIndex.delete(tenant, ['bafyreig-nonexistent']);

      const root = await stateIndex.getRoot(tenant);
      expect(hashEquals(root, defaultHashes[0])).to.be.true;
    });
  });

  describe('getSubtreeHash', () => {
    it('should return subtree hashes for the global tree', async () => {
      const defaultHashes = await initDefaultHashes();
      const tenant = 'did:test:alice';

      await stateIndex.insert(tenant, 'bafyreig-1', { interface: 'Records', method: 'Write' });
      await stateIndex.insert(tenant, 'bafyreig-2', { interface: 'Records', method: 'Write' });

      const leftHash = await stateIndex.getSubtreeHash(tenant, [false]);
      const rightHash = await stateIndex.getSubtreeHash(tenant, [true]);

      // At least one should be non-default
      const leftIsDefault = hashEquals(leftHash, defaultHashes[1]);
      const rightIsDefault = hashEquals(rightHash, defaultHashes[1]);
      expect(leftIsDefault && rightIsDefault).to.be.false;
    });
  });

  describe('getLeaves', () => {
    it('should return all leaves for empty prefix', async () => {
      const tenant = 'did:test:alice';
      const indexes = { interface: 'Records', method: 'Write' };

      await stateIndex.insert(tenant, 'bafyreig-1', indexes);
      await stateIndex.insert(tenant, 'bafyreig-2', indexes);
      await stateIndex.insert(tenant, 'bafyreig-3', indexes);

      const leaves = await stateIndex.getLeaves(tenant, []);
      expect(leaves.sort()).to.deep.equal(['bafyreig-1', 'bafyreig-2', 'bafyreig-3'].sort());
    });

    it('should return protocol-scoped leaves', async () => {
      const tenant = 'did:test:alice';

      await stateIndex.insert(tenant, 'bafyreig-chat-1', {
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://example.com/chat',
      });
      await stateIndex.insert(tenant, 'bafyreig-social-1', {
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://example.com/social',
      });

      const chatLeaves = await stateIndex.getProtocolLeaves(tenant, 'https://example.com/chat', []);
      expect(chatLeaves).to.deep.equal(['bafyreig-chat-1']);

      const socialLeaves = await stateIndex.getProtocolLeaves(tenant, 'https://example.com/social', []);
      expect(socialLeaves).to.deep.equal(['bafyreig-social-1']);
    });
  });

  describe('clear', () => {
    it('should reset everything for all tenants', async () => {
      const defaultHashes = await initDefaultHashes();

      await stateIndex.insert('did:test:alice', 'bafyreig-1', {
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://example.com/chat',
      });
      await stateIndex.insert('did:test:bob', 'bafyreig-2', {
        interface : 'Records',
        method    : 'Write',
      });

      // close the stateIndex before the afterEach hook
      await stateIndex.close();

      // Create a fresh instance at the same location to verify clear works
      stateIndex = new StateIndexLevel({ location: uniqueLocation() });
      await stateIndex.open();

      const aliceRoot = await stateIndex.getRoot('did:test:alice');
      const bobRoot = await stateIndex.getRoot('did:test:bob');

      expect(hashEquals(aliceRoot, defaultHashes[0])).to.be.true;
      expect(hashEquals(bobRoot, defaultHashes[0])).to.be.true;
    });
  });
});
