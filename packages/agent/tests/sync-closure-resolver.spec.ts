import type { GenericMessage, MessageStore } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { ClosureFailureCode, createClosureContext, invalidateClosureCache } from '../src/sync-closure-types.js';
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
      // Match by protocol + recordId (Class 6 cross-protocol parent)
      if (filter.recordId && filter.protocol && filter.interface === 'Records') {
        const key = `protocol+recordId:${filter.protocol}|${filter.recordId}`;
        const result = queryResults.get(key);
        if (result) { return { messages: result }; }
        // Fall through to bare recordId match below.
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

  describe('Class 4: Squash/visibility closure', () => {
    it('should NOT emit squash dependency edges — squash scope is derived from the message itself', async () => {
      // The runtime derives squash scope entirely from the message's own contextId
      // and the $squash rule in the ProtocolsConfigure (class 1 dependency).
      // No additional record needs to be fetched for squash closure.
      const protocolDef = {
        protocol  : 'https://example.com/proto',
        published : true,
        types     : { document: {}, patch: {} },
        structure : {
          document: {
            patch: {
              $squash  : true,
              $actions : [{ who: 'anyone', can: ['create'] }],
            },
          },
        },
      };
      const protocolConfig = {
        descriptor: {
          interface  : 'Protocols',
          method     : 'Configure',
          definition : protocolDef,
        },
      } as any;

      const msg = mockMessage({
        protocol     : 'https://example.com/proto',
        protocolPath : 'document/patch',
        parentId     : 'doc-1',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'patch-1';
      (msg as any).contextId = 'doc-1/patch-1';

      const parentDoc = mockMessage({ interface: 'Records', method: 'Write' });
      (parentDoc as any).recordId = 'doc-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['recordId:doc-1', [parentDoc]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      // No class 4 squash edges — squash scope comes from the message itself.
      expect(result.edges.every(e => e.dependencyClass !== 4)).toBe(true);
    });
  });

  describe('Class 5: Encryption closure', () => {
    it('should require encryption key material when type has encryptionRequired', async () => {
      const protocolDef = {
        protocol  : 'https://example.com/proto',
        published : false,
        types     : {
          secret: {
            schema             : 'http://secret',
            encryptionRequired : true,
          },
        },
        structure: {
          secret: {
            $encryption : { rootKeyId: 'key-1', publicKeyJwk: {} },
            $actions    : [{ who: 'anyone', can: ['create'] }],
          },
        },
      };
      const protocolConfig = {
        descriptor: {
          interface  : 'Protocols',
          method     : 'Configure',
          definition : protocolDef,
        },
      } as any;

      const msg = mockMessage({
        protocol     : 'https://example.com/proto',
        protocolPath : 'secret',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'secret-1';

      const keyDeliveryConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['protocol:https://identity.foundation/protocols/key-delivery', [keyDeliveryConfig]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'encryptionKeyMaterial')).toBe(true);
      expect(result.edges.some(e => e.label === 'keyDeliveryProtocol')).toBe(true);
    });

    it('should NOT require contextKey for single-party encrypted records', async () => {
      // Single-party protocol: no $role, no relational read rules.
      // ProtocolPath encryption is used — no context key needed.
      const protocolDef = {
        protocol  : 'https://example.com/proto',
        published : false,
        types     : { secret: { encryptionRequired: true } },
        structure : {
          secret: {
            $encryption : { rootKeyId: 'key-1', publicKeyJwk: {} },
            $actions    : [{ who: 'anyone', can: ['create'] }],
          },
        },
      };
      const protocolConfig = {
        descriptor: { interface: 'Protocols', method: 'Configure', definition: protocolDef },
      } as any;

      const msg = mockMessage({
        protocol     : 'https://example.com/proto',
        protocolPath : 'secret',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'secret-1';
      (msg as any).contextId = 'root-ctx-1/secret-1';

      const keyDeliveryConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const contextRoot = mockMessage({ interface: 'Records', method: 'Write' });
      (contextRoot as any).recordId = 'root-ctx-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['protocol:https://identity.foundation/protocols/key-delivery', [keyDeliveryConfig]],
          ['recordId:root-ctx-1', [contextRoot]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/proto',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      // keyDeliveryProtocol edge IS present (protocol definition level).
      expect(result.edges.some(e => e.label === 'keyDeliveryProtocol')).toBe(true);
      // contextKeyRecord edge is NOT present (single-party context).
      expect(result.edges.every(e => e.label !== 'contextKeyRecord')).toBe(true);
    });

    it('should require contextKey for multi-party encrypted records and fail when absent', async () => {
      // Multi-party protocol: has $role descendant → isMultiPartyContext returns true.
      const protocolDef = {
        protocol  : 'https://example.com/chat',
        published : true,
        types     : {
          thread      : {},
          participant : {},
          message     : { encryptionRequired: true },
        },
        structure: {
          thread: {
            participant: {
              $role    : true, // ← This makes it multi-party!
              $actions : [{ who: 'anyone', can: ['read'] }],
            },
            message: {
              $encryption : { rootKeyId: 'key-1', publicKeyJwk: {} },
              $actions    : [{ role: 'thread/participant', can: ['create', 'read'] }],
            },
          },
        },
      };
      const protocolConfig = {
        descriptor: { interface: 'Protocols', method: 'Configure', definition: protocolDef },
      } as any;

      const msg = mockMessage({
        protocol     : 'https://example.com/chat',
        protocolPath : 'thread/message',
        parentId     : 'thread-1',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'msg-1';
      (msg as any).contextId = 'thread-1/msg-1';

      const keyDeliveryConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const parentThread = mockMessage({ interface: 'Records', method: 'Write' });
      (parentThread as any).recordId = 'thread-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/chat', [protocolConfig]],
          ['protocol:https://identity.foundation/protocols/key-delivery', [keyDeliveryConfig]],
          ['recordId:thread-1', [parentThread]],
          // No contextKey record in the store!
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/chat',
      }, createClosureContext('did:example:alice'));

      // Closure should FAIL: multi-party context but no contextKey.
      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.EncryptionDependencyMissing);
      expect(result.failure!.edge.label).toBe('contextKeyRecord');
    });

    it('should succeed for multi-party encrypted records when contextKey is present', async () => {
      const protocolDef = {
        protocol  : 'https://example.com/chat',
        published : true,
        types     : {
          thread      : {},
          participant : {},
          message     : { encryptionRequired: true },
        },
        structure: {
          thread: {
            participant: {
              $role    : true,
              $actions : [{ who: 'anyone', can: ['read'] }],
            },
            message: {
              $encryption : { rootKeyId: 'key-1', publicKeyJwk: {} },
              $actions    : [{ role: 'thread/participant', can: ['create', 'read'] }],
            },
          },
        },
      };
      const protocolConfig = {
        descriptor: { interface: 'Protocols', method: 'Configure', definition: protocolDef },
      } as any;

      const msg = mockMessage({
        protocol     : 'https://example.com/chat',
        protocolPath : 'thread/message',
        parentId     : 'thread-1',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'msg-1';
      (msg as any).contextId = 'thread-1/msg-1';

      const keyDeliveryConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const parentThread = mockMessage({ interface: 'Records', method: 'Write' });
      (parentThread as any).recordId = 'thread-1';

      // Mock the context key as present (tag-based query returns a result).
      // The mock store doesn't support tag queries, but the resolveDependency
      // for contextKeyRecord queries by messageCid type, which falls through
      // to messageStore.get(). We can mock that via getResults.
      const contextKeyRecord = mockMessage({ interface: 'Records', method: 'Write' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/chat', [protocolConfig]],
          ['protocol:https://identity.foundation/protocols/key-delivery', [keyDeliveryConfig]],
          ['recordId:thread-1', [parentThread]],
        ]),
      });
      // Override the query to return the context key for the tag-based query.
      (store.query as any).callsFake(async (_tenant: string, filters: any[]): Promise<{ messages: GenericMessage[] }> => {
        const filter = filters[0] ?? {};
        if (filter.interface === 'Protocols' && filter.protocol) {
          const key = `protocol:${filter.protocol}`;
          if (key === 'protocol:https://example.com/chat') { return { messages: [protocolConfig] }; }
          if (key === 'protocol:https://identity.foundation/protocols/key-delivery') { return { messages: [keyDeliveryConfig] }; }
        }
        if (filter['tag.protocol'] && filter['tag.contextId']) {
          return { messages: [contextKeyRecord] };
        }
        if (filter.recordId) {
          if (filter.recordId === 'thread-1') { return { messages: [parentThread] }; }
        }
        return { messages: [] };
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://example.com/chat',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'contextKeyRecord')).toBe(true);
    });
  });

  describe('Class 6: Cross-protocol $ref closure', () => {
    it('should require referenced protocol ProtocolsConfigure when path uses $ref', async () => {
      const composingDef = {
        protocol  : 'https://comments.example.com',
        published : true,
        uses      : { threads: 'https://threads.example.com' },
        types     : { comment: {} },
        structure : {
          thread: {
            $ref    : 'threads:thread',
            comment : {
              $actions: [{ who: 'anyone', can: ['create'] }],
            },
          },
        },
      };
      const composingConfig = {
        descriptor: {
          interface  : 'Protocols',
          method     : 'Configure',
          definition : composingDef,
        },
      } as any;

      const referencedConfig = {
        descriptor: {
          interface  : 'Protocols',
          method     : 'Configure',
          definition : { protocol: 'https://threads.example.com' },
        },
      } as any;

      const msg = mockMessage({
        protocol     : 'https://comments.example.com',
        protocolPath : 'thread/comment',
        parentId     : 'thread-1',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'comment-1';

      const parentThread = mockMessage({ interface: 'Records', method: 'Write' });
      (parentThread as any).recordId = 'thread-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://comments.example.com', [composingConfig]],
          ['protocol:https://threads.example.com', [referencedConfig]],
          ['recordId:thread-1', [parentThread]],
          ['protocol+recordId:https://threads.example.com|thread-1', [parentThread]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://comments.example.com',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'crossProtocolConfig')).toBe(true);
      // Level 2: $ref parent record in the referenced protocol.
      expect(result.edges.some(e => e.label === 'crossProtocolParent')).toBe(true);
    });

    it('should fail when referenced protocol ProtocolsConfigure is missing', async () => {
      const composingDef = {
        protocol  : 'https://comments.example.com',
        published : true,
        uses      : { threads: 'https://threads.example.com' },
        types     : { comment: {} },
        structure : {
          thread: {
            $ref    : 'threads:thread',
            comment : {
              $actions: [{ who: 'anyone', can: ['create'] }],
            },
          },
        },
      };
      const composingConfig = {
        descriptor: {
          interface  : 'Protocols',
          method     : 'Configure',
          definition : composingDef,
        },
      } as any;

      const msg = mockMessage({
        protocol     : 'https://comments.example.com',
        protocolPath : 'thread/comment',
        parentId     : 'thread-1',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'comment-1';

      const parentThread = mockMessage({ interface: 'Records', method: 'Write' });
      (parentThread as any).recordId = 'thread-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://comments.example.com', [composingConfig]],
          // No threads protocol config — missing
          ['recordId:thread-1', [parentThread]],
        ]),
      });

      const result = await evaluateClosure(msg, store, {
        kind: 'protocol', protocol: 'https://comments.example.com',
      }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.CrossProtocolReferenceMissing);
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

  describe('invalidateClosureCache', () => {
    it('should invalidate protocolCache when a ProtocolsConfigure is processed', () => {
      const ctx = createClosureContext('did:example:alice');
      ctx.protocolCache.set('https://example.com/proto', { some: 'cached-definition' });

      const protocolMsg = mockMessage({
        interface  : 'Protocols',
        method     : 'Configure',
        definition : { protocol: 'https://example.com/proto' },
      });

      invalidateClosureCache(ctx, protocolMsg);

      expect(ctx.protocolCache.has('https://example.com/proto')).toBe(false);
    });

    it('should invalidate grantCache when a grant write is processed', () => {
      const ctx = createClosureContext('did:example:alice');
      ctx.grantCache.set('grant-1', mockMessage());
      ctx.satisfiedDeps.add('grantId:grant-1');

      const grantMsg = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://identity.foundation/dwn/permissions',
        protocolPath : 'grant',
      });
      (grantMsg as any).recordId = 'grant-1';

      invalidateClosureCache(ctx, grantMsg);

      expect(ctx.grantCache.has('grant-1')).toBe(false);
      expect(ctx.satisfiedDeps.has('grantId:grant-1')).toBe(false);
    });

    it('should invalidate grantCache revocation entry when a revocation is processed', () => {
      const ctx = createClosureContext('did:example:alice');
      ctx.grantCache.set('revocation:grant-1', mockMessage());
      ctx.satisfiedDeps.add('grantId:grant-1');

      const revocationMsg = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://identity.foundation/dwn/permissions',
        protocolPath : 'grant/revocation',
        parentId     : 'grant-1',
      });

      invalidateClosureCache(ctx, revocationMsg);

      expect(ctx.grantCache.has('revocation:grant-1')).toBe(false);
      expect(ctx.satisfiedDeps.has('grantId:grant-1')).toBe(false);
    });

    it('should invalidate recordId-based satisfied/missing entries on any Records message', () => {
      const ctx = createClosureContext('did:example:alice');
      ctx.satisfiedDeps.add('recordId:record-1');
      ctx.missingDeps.add('recordId:record-2');

      const recordMsg = mockMessage({ interface: 'Records', method: 'Write' });
      (recordMsg as any).recordId = 'record-1';
      invalidateClosureCache(ctx, recordMsg);
      expect(ctx.satisfiedDeps.has('recordId:record-1')).toBe(false);

      const recordMsg2 = mockMessage({ interface: 'Records', method: 'Write' });
      (recordMsg2 as any).recordId = 'record-2';
      invalidateClosureCache(ctx, recordMsg2);
      expect(ctx.missingDeps.has('recordId:record-2')).toBe(false);
    });

    it('should not affect unrelated cache entries', () => {
      const ctx = createClosureContext('did:example:alice');
      ctx.protocolCache.set('https://example.com/other', { some: 'definition' });
      ctx.grantCache.set('grant-2', mockMessage());

      const protocolMsg = mockMessage({
        interface  : 'Protocols',
        method     : 'Configure',
        definition : { protocol: 'https://example.com/proto' },
      });

      invalidateClosureCache(ctx, protocolMsg);

      // Other entries should remain.
      expect(ctx.protocolCache.has('https://example.com/other')).toBe(true);
      expect(ctx.grantCache.has('grant-2')).toBe(true);
    });
  });
});
