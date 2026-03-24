import type { GenericMessage, MessageStore } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { ClosureFailureCode, createClosureContext } from '../src/sync-closure-types.js';
import { evaluateClosure, evaluateClosureBatch } from '../src/sync-closure-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock message with configurable descriptor fields. */
function mockMessage(overrides: Record<string, unknown> = {}): GenericMessage {
  return {
    descriptor: {
      interface        : 'Records',
      method           : 'Write',
      messageTimestamp : '2025-01-01T00:00:00.000000Z',
      ...overrides,
    },
  } as any;
}

/** Minimal mock MessageStore with query and get stubs. */
function mockMessageStore(options: {
  queryResults?: Map<string, GenericMessage[]>;
  getResults?: Map<string, GenericMessage>;
} = {}): MessageStore {
  const queryResults = options.queryResults ?? new Map();
  const getResults = options.getResults ?? new Map();

  return {
    query: sinon.stub().callsFake(async (_tenant: string, filters: any[]): Promise<{ messages: GenericMessage[] }> => {
      const filter = filters[0] ?? {};
      // Match by protocol (Class 1)
      if (filter.interface === 'Protocols' && filter.protocol) {
        return { messages: queryResults.get(`protocol:${filter.protocol}`) ?? [] };
      }
      // Match by recordId (Class 2/3)
      if (filter.recordId) {
        return { messages: queryResults.get(`recordId:${filter.recordId}`) ?? [] };
      }
      return { messages: [] };
    }),
    get: sinon.stub().callsFake(async (_tenant: string, cid: string): Promise<GenericMessage | undefined> => {
      return getResults.get(cid);
    }),
    // Unused methods
    put    : sinon.stub(),
    delete : sinon.stub(),
    clear  : sinon.stub(),
    close  : sinon.stub(),
    open   : sinon.stub(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateClosure', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('full-tenant scope bypass', () => {
    it('should return complete immediately for kind:full scope', async () => {
      const msg = mockMessage({ protocol: 'https://example.com/proto' });
      const store = mockMessageStore();

      const result = await evaluateClosure(msg, store, { kind: 'full' }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges).toEqual([]);
      expect(result.depth).toBe(0);
      // MessageStore should NOT have been queried.
      expect((store.query as sinon.SinonStub).called).toBe(false);
    });
  });

  describe('Class 1: Protocol metadata closure', () => {
    it('should require ProtocolsConfigure for protocol-scoped messages', async () => {
      const msg = mockMessage({ protocol: 'https://example.com/proto', dateCreated: '2025-01-01T00:00:00.000000Z' });
      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure', protocol: 'https://example.com/proto' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'protocolsConfigure')).toBe(true);
    });

    it('should fail when ProtocolsConfigure is missing', async () => {
      const msg = mockMessage({ protocol: 'https://example.com/proto', dateCreated: '2025-01-01T00:00:00.000000Z' });
      const store = mockMessageStore(); // no protocols in store

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.ProtocolMetadataMissing);
    });
  });

  describe('Class 2: Record ancestry closure', () => {
    it('should require initialWrite for non-initial RecordsWrite', async () => {
      const msg = mockMessage({
        protocol         : 'https://example.com/proto',
        dateCreated      : '2025-01-01T00:00:00.000000Z',
        messageTimestamp : '2025-01-02T00:00:00.000000Z', // different from dateCreated = non-initial
      });
      (msg as any).recordId = 'record-1';

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const initialWrite = mockMessage({ interface: 'Records', method: 'Write' });
      (initialWrite as any).recordId = 'record-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['recordId:record-1', [initialWrite]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'initialWrite')).toBe(true);
    });

    it('should fail when initialWrite is missing', async () => {
      const msg = mockMessage({
        protocol         : 'https://example.com/proto',
        dateCreated      : '2025-01-01T00:00:00.000000Z',
        messageTimestamp : '2025-01-02T00:00:00.000000Z',
      });
      (msg as any).recordId = 'record-1';

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          // no record-1 in store
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.InitialWriteMissing);
    });

    it('should require parent record when parentId is present', async () => {
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        parentId    : 'parent-1',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'child-1';

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const parentRecord = mockMessage({ interface: 'Records', method: 'Write' });
      (parentRecord as any).recordId = 'parent-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['recordId:parent-1', [parentRecord]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'parentRecord')).toBe(true);
    });

    it('should fail when parent record is missing', async () => {
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        parentId    : 'parent-1',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'child-1';

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.ParentChainMissing);
    });

    it('should require initialWrite for RecordsDelete', async () => {
      const msg = mockMessage({
        interface : 'Records',
        method    : 'Delete',
        protocol  : 'https://example.com/proto',
      });
      (msg as any).recordId = 'record-1';

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          // no record-1 in store
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.InitialWriteMissing);
    });
  });

  describe('Class 3: Authorization closure', () => {
    it('should require permission grant when permissionGrantId is in authorization', async () => {
      const grantId = 'grant-123';
      const payload = Buffer.from(JSON.stringify({ permissionGrantId: grantId })).toString('base64url');
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { authorSignature: { payload } };

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const grantRecord = mockMessage({ interface: 'Records', method: 'Write' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          [`recordId:${grantId}`, [grantRecord]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'permissionGrant')).toBe(true);
    });

    it('should fail when permission grant is missing', async () => {
      const payload = Buffer.from(JSON.stringify({ permissionGrantId: 'grant-missing' })).toString('base64url');
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { authorSignature: { payload } };

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.GrantMissing);
    });
  });

  describe('Class 2: Context ancestry closure', () => {
    it('should require context root when contextId differs from recordId', async () => {
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'child-1';
      (msg as any).contextId = 'context-root-1'; // different from recordId = needs context root

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const contextRoot = mockMessage({ interface: 'Records', method: 'Write' });
      (contextRoot as any).recordId = 'context-root-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['recordId:context-root-1', [contextRoot]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'contextRoot')).toBe(true);
    });

    it('should fail when context root is missing', async () => {
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'child-1';
      (msg as any).contextId = 'context-root-missing';

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.ContextChainMissing);
    });

    it('should not require context root when contextId equals recordId', async () => {
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'root-record';
      (msg as any).contextId = 'root-record'; // same as recordId = IS the context root

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.every(e => e.label !== 'contextRoot')).toBe(true);
    });
  });

  describe('traversal limits', () => {
    it('should fail with DepthExceeded when traversal exceeds maxDepth', async () => {
      // Create a chain of messages that reference each other via parentId.
      const messages = new Map<string, GenericMessage[]>();
      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      messages.set('protocol:https://example.com/proto', [protocolConfig]);

      // Build a chain of 5 records, each referencing the previous as parent.
      for (let i = 0; i < 5; i++) {
        const parent = mockMessage({
          interface   : 'Records',
          method      : 'Write',
          protocol    : 'https://example.com/proto',
          parentId    : i > 0 ? `record-${i - 1}` : undefined,
          dateCreated : '2025-01-01T00:00:00.000000Z',
        });
        (parent as any).recordId = `record-${i}`;
        messages.set(`recordId:record-${i}`, [parent]);
      }

      const root = mockMessage({
        protocol    : 'https://example.com/proto',
        parentId    : 'record-4',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (root as any).recordId = 'record-5';

      const store = mockMessageStore({ queryResults: messages });

      // Set maxDepth to 3 — the chain of 5+ parents should exceed it.
      const result = await evaluateClosure(root, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice', 3));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.DepthExceeded);
    });
  });

  describe('batch evaluation', () => {
    it('should share cache across roots in a batch', async () => {
      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
        ]),
      });

      const msg1 = mockMessage({ protocol: 'https://example.com/proto', dateCreated: '2025-01-01T00:00:00.000000Z' });
      const msg2 = mockMessage({ protocol: 'https://example.com/proto', dateCreated: '2025-01-02T00:00:00.000000Z' });

      const results = await evaluateClosureBatch(
        [msg1, msg2],
        store,
        { kind: 'protocol', protocol: 'https://example.com/proto' },
        'did:example:alice',
      );

      expect(results).toHaveLength(2);
      expect(results[0].complete).toBe(true);
      expect(results[1].complete).toBe(true);

      // ProtocolsConfigure should only have been queried ONCE (cached).
      const queryCalls = (store.query as sinon.SinonStub).getCalls()
        .filter((c: any) => c.args[1][0]?.interface === 'Protocols');
      expect(queryCalls).toHaveLength(1);
    });
  });

  describe('deduplication', () => {
    it('should not revisit already-satisfied dependencies', async () => {
      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
        ]),
      });

      const ctx = createClosureContext('did:example:alice');
      // Pre-populate the satisfied set with composite key format.
      ctx.satisfiedDeps.add('protocol:https://example.com/proto');

      const msg = mockMessage({ protocol: 'https://example.com/proto', dateCreated: '2025-01-01T00:00:00.000000Z' });
      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, ctx);

      expect(result.complete).toBe(true);
      // No queries should have been made — dependency was pre-satisfied.
      expect((store.query as sinon.SinonStub).called).toBe(false);
    });
  });
});
