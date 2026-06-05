import type { GenericMessage, MessageStore } from '@enbox/dwn-sdk-js';

import { PermissionsProtocol } from '@enbox/dwn-sdk-js';
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

function protocolSetDependencyKey(protocol: string, dependencyKey: string): string {
  return `protocolSet:${protocol}:${dependencyKey}`;
}

function mockPermissionGrantRecord(grantId: string, protocol: string): GenericMessage {
  const grant = mockMessage({
    interface    : 'Records',
    method       : 'Write',
    protocol     : PermissionsProtocol.uri,
    protocolPath : PermissionsProtocol.grantPath,
    tags         : { protocol },
  });
  (grant as any).recordId = grantId;
  return grant;
}

function encodePermissionGrantIds(...permissionGrantIds: string[]): string {
  return Buffer.from(JSON.stringify({ permissionGrantIds })).toString('base64url');
}

function encodePermissionGrantId(permissionGrantId: string): string {
  return Buffer.from(JSON.stringify({ permissionGrantId })).toString('base64url');
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

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'protocolsConfigure')).toBe(true);
    });

    it('should fail when ProtocolsConfigure is missing', async () => {
      const msg = mockMessage({ protocol: 'https://example.com/proto', dateCreated: '2025-01-01T00:00:00.000000Z' });
      const store = mockMessageStore(); // no protocols in store

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

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
      const initialWrite = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/proto' });
      (initialWrite as any).recordId = 'record-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['recordId:record-1', [initialWrite]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

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

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

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
      const parentRecord = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/proto' });
      (parentRecord as any).recordId = 'parent-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['recordId:parent-1', [parentRecord]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'parentRecord')).toBe(true);
    });

    it('should reject locally present dependencies outside the current sync scope', async () => {
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        parentId    : 'parent-1',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'child-1';

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const parentRecord = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/other' });
      (parentRecord as any).recordId = 'parent-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['recordId:parent-1', [parentRecord]],
        ]),
      });

      const result = await evaluateClosure(
        msg,
        store,
        { kind: 'protocolSet', protocols: ['https://example.com/proto'] },
        createClosureContext('did:example:alice'),
      );

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.DependencyForbidden);
      expect(result.failure!.edge.label).toBe('parentRecord');
    });

    it('should reject a locally present context root outside the current sync scope', async () => {
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'child-1';
      (msg as any).contextId = 'root-1/child-1';

      const contextRoot = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/other' });
      (contextRoot as any).recordId = 'root-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [mockMessage({ interface: 'Protocols', method: 'Configure' })]],
          ['recordId:root-1', [contextRoot]],
        ]),
      });

      const result = await evaluateClosure(
        msg,
        store,
        { kind: 'protocolSet', protocols: ['https://example.com/proto'] },
        createClosureContext('did:example:alice'),
      );

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.DependencyForbidden);
      expect(result.failure!.edge.label).toBe('contextRoot');
    });

    it('should reject a locally present initial write outside the current sync scope', async () => {
      const msg = mockMessage({
        protocol         : 'https://example.com/proto',
        dateCreated      : '2025-01-01T00:00:00.000000Z',
        messageTimestamp : '2025-01-02T00:00:00.000000Z',
      });
      (msg as any).recordId = 'record-1';

      const initialWrite = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/other' });
      (initialWrite as any).recordId = 'record-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [mockMessage({ interface: 'Protocols', method: 'Configure' })]],
          ['recordId:record-1', [initialWrite]],
        ]),
      });

      const result = await evaluateClosure(
        msg,
        store,
        { kind: 'protocolSet', protocols: ['https://example.com/proto'] },
        createClosureContext('did:example:alice'),
      );

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.DependencyForbidden);
      expect(result.failure!.edge.label).toBe('initialWrite');
    });

    it('should not reuse a dependency cache entry across different sync scopes', async () => {
      const parentRecord = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/other' });
      (parentRecord as any).recordId = 'parent-1';
      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [mockMessage({ interface: 'Protocols', method: 'Configure' })]],
          ['protocol:https://example.com/other', [mockMessage({ interface: 'Protocols', method: 'Configure' })]],
          ['recordId:parent-1', [parentRecord]],
        ]),
      });
      const context = createClosureContext('did:example:alice');

      const otherScopedRoot = mockMessage({
        protocol    : 'https://example.com/other',
        parentId    : 'parent-1',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (otherScopedRoot as any).recordId = 'child-other';

      const otherResult = await evaluateClosure(
        otherScopedRoot,
        store,
        { kind: 'protocolSet', protocols: ['https://example.com/other'] },
        context,
      );
      expect(otherResult.complete).toBe(true);

      const protoScopedRoot = mockMessage({
        protocol    : 'https://example.com/proto',
        parentId    : 'parent-1',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (protoScopedRoot as any).recordId = 'child-proto';

      const protoResult = await evaluateClosure(
        protoScopedRoot,
        store,
        { kind: 'protocolSet', protocols: ['https://example.com/proto'] },
        context,
      );

      expect(protoResult.complete).toBe(false);
      expect(protoResult.failure!.code).toBe(ClosureFailureCode.DependencyForbidden);
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

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

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

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.InitialWriteMissing);
    });
  });

  describe('Class 3: Authorization closure', () => {
    it('should require permission grant when permissionGrantIds is in authorization', async () => {
      const grantId = 'grant-123';
      const payload = encodePermissionGrantIds(grantId);
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { signature: { payload, signatures: [{ protected: payload, signature: 'fake' }] } };

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const grantRecord = mockPermissionGrantRecord(grantId, 'https://example.com/proto');

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          [`recordId:${grantId}`, [grantRecord]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'permissionGrant')).toBe(true);
    });

    it('should require permission grant when permissionGrantId is in authorization', async () => {
      const grantId = 'grant-123';
      const payload = encodePermissionGrantId(grantId);
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { signature: { payload, signatures: [{ protected: payload, signature: 'fake' }] } };

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const grantRecord = mockPermissionGrantRecord(grantId, 'https://example.com/proto');

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          [`recordId:${grantId}`, [grantRecord]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'permissionGrant')).toBe(true);
    });

    it('should reject untagged permission grants in protocol-scoped closure', async () => {
      const grantId = 'grant-untagged';
      const payload = encodePermissionGrantIds(grantId);
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { signature: { payload, signatures: [{ protected: payload, signature: 'fake' }] } };

      const grantRecord = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : PermissionsProtocol.uri,
        protocolPath : PermissionsProtocol.grantPath,
      });
      (grantRecord as any).recordId = grantId;

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [mockMessage({ interface: 'Protocols', method: 'Configure' })]],
          [`recordId:${grantId}`, [grantRecord]],
        ]),
      });

      const result = await evaluateClosure(
        msg,
        store,
        { kind: 'protocolSet', protocols: ['https://example.com/proto'] },
        createClosureContext('did:example:alice'),
      );

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.DependencyForbidden);
      expect(result.failure!.edge.label).toBe('permissionGrant');
    });

    it('should fail when permission grant is missing', async () => {
      const payload = encodePermissionGrantIds('grant-missing');
      const msg = mockMessage({
        protocol    : 'https://example.com/proto',
        dateCreated : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { signature: { payload, signatures: [{ protected: payload, signature: 'fake' }] } };

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.GrantMissing);
    });
  });

  describe('Causal grant ordering', () => {
    /** Helper to build a grant record with temporal fields. */
    function mockGrantRecord(grantId: string, dateCreated: string, dateExpires: string): GenericMessage {
      const grantData = { dateExpires, scope: { interface: 'Records', method: 'Write' } };
      return {
        recordId   : grantId,
        descriptor : {
          interface        : 'Records',
          method           : 'Write',
          dateCreated,
          messageTimestamp : dateCreated,
          protocol         : PermissionsProtocol.uri,
          protocolPath     : PermissionsProtocol.grantPath,
          tags             : { protocol: 'https://example.com/proto' },
        },
        encodedData: Buffer.from(JSON.stringify(grantData)).toString('base64url'),
      } as any;
    }

    it('should fail when message timestamp is before grant dateGranted', async () => {
      const grantId = 'grant-temporal-1';
      const grantPayload = encodePermissionGrantIds(grantId);

      // Message at 2024-01-01, grant active from 2025-01-01.
      const msg = mockMessage({
        protocol         : 'https://example.com/proto',
        dateCreated      : '2024-01-01T00:00:00.000000Z',
        messageTimestamp : '2024-01-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { signature: { payload: grantPayload, signatures: [{ protected: grantPayload, signature: 'fake' }] } };

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const grantRecord = mockGrantRecord(grantId, '2025-01-01T00:00:00.000000Z', '2026-01-01T00:00:00.000000Z');

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          [`recordId:${grantId}`, [grantRecord]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.GrantNotYetActive);
      expect(result.failure!.detail).toContain('not yet active');
    });

    it('should fail when message timestamp is at or after grant dateExpires', async () => {
      const grantId = 'grant-temporal-2';
      const grantPayload = encodePermissionGrantIds(grantId);

      // Message at 2026-06-01, grant expires at 2026-01-01.
      const msg = mockMessage({
        protocol         : 'https://example.com/proto',
        dateCreated      : '2025-06-01T00:00:00.000000Z',
        messageTimestamp : '2026-06-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { signature: { payload: grantPayload, signatures: [{ protected: grantPayload, signature: 'fake' }] } };

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const grantRecord = mockGrantRecord(grantId, '2025-01-01T00:00:00.000000Z', '2026-01-01T00:00:00.000000Z');

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          [`recordId:${grantId}`, [grantRecord]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.GrantExpired);
      expect(result.failure!.detail).toContain('expired');
    });

    it('should fail when grant is revoked before message timestamp', async () => {
      const grantId = 'grant-temporal-3';
      const grantPayload = encodePermissionGrantIds(grantId);

      // Message at 2025-06-01, revocation at 2025-03-01 (before message).
      const msg = mockMessage({
        protocol         : 'https://example.com/proto',
        dateCreated      : '2025-01-01T00:00:00.000000Z',
        messageTimestamp : '2025-06-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { signature: { payload: grantPayload, signatures: [{ protected: grantPayload, signature: 'fake' }] } };

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const grantRecord = mockGrantRecord(grantId, '2025-01-01T00:00:00.000000Z', '2027-01-01T00:00:00.000000Z');
      const revocationRecord = mockMessage({
        interface        : 'Records',
        method           : 'Write',
        protocol         : PermissionsProtocol.uri,
        protocolPath     : PermissionsProtocol.revocationPath,
        tags             : { protocol: 'https://example.com/proto' },
        messageTimestamp : '2025-03-01T00:00:00.000000Z',
      });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          [`recordId:${grantId}`, [grantRecord]],
        ]),
      });

      // Pre-populate the grant cache with the revocation record.
      const ctx = createClosureContext('did:example:alice');
      ctx.grantCache.set(grantId, grantRecord);
      ctx.grantCache.set(`revocation:${grantId}`, revocationRecord);

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, ctx);

      expect(result.complete).toBe(false);
      expect(result.failure!.detail).toContain('revoked');
    });

    it('should succeed when grant is temporally valid and not revoked', async () => {
      const grantId = 'grant-temporal-4';
      const grantPayload = encodePermissionGrantIds(grantId);

      // Message at 2025-06-01, grant active 2025-01-01 to 2026-01-01, no revocation.
      const msg = mockMessage({
        protocol         : 'https://example.com/proto',
        dateCreated      : '2025-06-01T00:00:00.000000Z',
        messageTimestamp : '2025-06-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { signature: { payload: grantPayload, signatures: [{ protected: grantPayload, signature: 'fake' }] } };

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const grantRecord = mockGrantRecord(grantId, '2025-01-01T00:00:00.000000Z', '2026-01-01T00:00:00.000000Z');

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          [`recordId:${grantId}`, [grantRecord]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
    });

    it('should succeed when revocation exists but is after message timestamp', async () => {
      const grantId = 'grant-temporal-5';
      const grantPayload = encodePermissionGrantIds(grantId);

      // Message at 2025-06-01, revocation at 2025-09-01 (after message → grant was valid at message time).
      const msg = mockMessage({
        protocol         : 'https://example.com/proto',
        dateCreated      : '2025-01-01T00:00:00.000000Z',
        messageTimestamp : '2025-06-01T00:00:00.000000Z',
      });
      (msg as any).authorization = { signature: { payload: grantPayload, signatures: [{ protected: grantPayload, signature: 'fake' }] } };

      const protocolConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const grantRecord = mockGrantRecord(grantId, '2025-01-01T00:00:00.000000Z', '2027-01-01T00:00:00.000000Z');
      const revocationRecord = mockMessage({
        interface        : 'Records',
        method           : 'Write',
        protocol         : PermissionsProtocol.uri,
        protocolPath     : PermissionsProtocol.revocationPath,
        tags             : { protocol: 'https://example.com/proto' },
        messageTimestamp : '2025-09-01T00:00:00.000000Z',
      });

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          [`recordId:${grantId}`, [grantRecord]],
        ]),
      });

      const ctx = createClosureContext('did:example:alice');
      ctx.grantCache.set(grantId, grantRecord);
      ctx.grantCache.set(`revocation:${grantId}`, revocationRecord);

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, ctx);

      // Grant was valid at the message's timestamp — revocation came later.
      expect(result.complete).toBe(true);
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
      const contextRoot = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/proto' });
      (contextRoot as any).recordId = 'context-root-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['recordId:context-root-1', [contextRoot]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

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

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

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

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

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

      const parentDoc = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/proto' });
      (parentDoc as any).recordId = 'doc-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['recordId:doc-1', [parentDoc]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

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

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

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
      const contextRoot = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/proto' });
      (contextRoot as any).recordId = 'root-ctx-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/proto', [protocolConfig]],
          ['protocol:https://identity.foundation/protocols/key-delivery', [keyDeliveryConfig]],
          ['recordId:root-ctx-1', [contextRoot]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice'));

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
      const parentThread = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/chat' });
      (parentThread as any).recordId = 'thread-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/chat', [protocolConfig]],
          ['protocol:https://identity.foundation/protocols/key-delivery', [keyDeliveryConfig]],
          ['recordId:thread-1', [parentThread]],
          // No contextKey record in the store!
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/chat',] }, createClosureContext('did:example:alice'));

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
      const parentThread = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/chat' });
      (parentThread as any).recordId = 'thread-1';

      // Mock the context key as present. The resolveDependency for
      // contextKeyRecord uses a tag-based query (tag.protocol + tag.contextId).
      // We override the mock store's query stub below to handle this.
      const contextKeyRecord = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://identity.foundation/protocols/key-delivery',
        protocolPath : 'contextKey',
        tags         : {
          protocol  : 'https://example.com/chat',
          contextId : 'thread-1',
        },
      });

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

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/chat',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'contextKeyRecord')).toBe(true);
    });

    it('should reject a contextKey record with mismatched source tags', async () => {
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
      const parentThread = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/chat' });
      (parentThread as any).recordId = 'thread-1';
      const wrongContextKeyRecord = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://identity.foundation/protocols/key-delivery',
        protocolPath : 'contextKey',
        tags         : {
          protocol  : 'https://example.com/other',
          contextId : 'thread-1',
        },
      });

      const store = mockMessageStore();
      (store.query as any).callsFake(async (_tenant: string, filters: any[]): Promise<{ messages: GenericMessage[] }> => {
        const filter = filters[0] ?? {};
        if (filter.interface === 'Protocols' && filter.protocol === 'https://example.com/chat') {
          return { messages: [protocolConfig] };
        }
        if (filter.interface === 'Protocols' && filter.protocol === 'https://identity.foundation/protocols/key-delivery') {
          return { messages: [keyDeliveryConfig] };
        }
        if (filter.recordId === 'thread-1') {
          return { messages: [parentThread] };
        }
        if (filter['tag.protocol'] && filter['tag.contextId']) {
          return { messages: [wrongContextKeyRecord] };
        }
        return { messages: [] };
      });

      const result = await evaluateClosure(
        msg,
        store,
        { kind: 'protocolSet', protocols: ['https://example.com/chat'] },
        createClosureContext('did:example:alice'),
      );

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.DependencyForbidden);
      expect(result.failure!.edge.label).toBe('contextKeyRecord');
    });

    it('should gate contextKey records by projected context scope, not bare protocol', async () => {
      const protocolDef = {
        protocol  : 'https://example.com/chat',
        published : true,
        types     : {
          thread  : {},
          message : { encryptionRequired: true },
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
      const keyDeliveryConfig = mockMessage({ interface: 'Protocols', method: 'Configure' });
      const contextKeyRecord = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://identity.foundation/protocols/key-delivery',
        protocolPath : 'contextKey',
        tags         : {
          protocol  : 'https://example.com/chat',
          contextId : 'thread-1',
        },
      });
      const msg = mockMessage({
        protocol     : 'https://example.com/chat',
        protocolPath : 'thread/message',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'thread-1';
      (msg as any).contextId = 'thread-1';

      const store = mockMessageStore();
      (store.query as any).callsFake(async (_tenant: string, filters: any[]): Promise<{ messages: GenericMessage[] }> => {
        const filter = filters[0] ?? {};
        if (filter.interface === 'Protocols' && filter.protocol === 'https://example.com/chat') {
          return { messages: [protocolConfig] };
        }
        if (filter.interface === 'Protocols' && filter.protocol === 'https://identity.foundation/protocols/key-delivery') {
          return { messages: [keyDeliveryConfig] };
        }
        if (filter['tag.protocol'] && filter['tag.contextId']) {
          return { messages: [contextKeyRecord] };
        }
        return { messages: [] };
      });

      const contextScopedResult = await evaluateClosure(
        msg,
        store,
        {
          kind   : 'recordsProjection',
          scopes : [{ protocol: 'https://example.com/chat', contextId: 'thread-1' }],
        },
        createClosureContext('did:example:alice'),
      );
      expect(contextScopedResult.complete).toBe(true);

      const pathScopedResult = await evaluateClosure(
        msg,
        store,
        {
          kind   : 'recordsProjection',
          scopes : [{ protocol: 'https://example.com/chat', protocolPath: 'thread/message' }],
        },
        createClosureContext('did:example:alice'),
      );
      expect(pathScopedResult.complete).toBe(false);
      expect(pathScopedResult.failure!.code).toBe(ClosureFailureCode.DependencyForbidden);
      expect(pathScopedResult.failure!.edge.label).toBe('contextKeyRecord');
    });
  });

  describe('Class 5 — delegate session encryption closure', () => {
    it('should auto-satisfy keyDeliveryProtocol for delegate sessions (single-party)', async () => {
      // Delegate sessions decrypt via pre-derived keys (delegateDecryptionKeys
      // for single-party, delegateContextKeys for multi-party) — they do NOT
      // use DWN-stored key-delivery records.  The closure resolver must treat
      // keyDeliveryProtocol as structurally inapplicable for delegates.
      const protocolDef = {
        protocol  : 'https://example.com/wallet',
        published : true,
        types     : {
          proof: { encryptionRequired: true },
        },
        structure: {
          proof: {
            $encryption: { rootKeyId: 'key-1', publicKeyJwk: {} },
          },
        },
      };
      const protocolConfig = {
        descriptor: { interface: 'Protocols', method: 'Configure', definition: protocolDef },
      } as any;

      const msg = mockMessage({
        protocol     : 'https://example.com/wallet',
        protocolPath : 'proof',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'proof-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/wallet', [protocolConfig]],
          // key-delivery protocol is MISSING from the store
        ]),
      });

      // Non-delegate: closure FAILS because keyDeliveryProtocol is missing.
      const ownerCtx = createClosureContext('did:example:alice');
      const ownerResult = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/wallet',] }, ownerCtx);

      expect(ownerResult.complete).toBe(false);
      expect(ownerResult.failure!.code).toBe(ClosureFailureCode.EncryptionDependencyMissing);
      expect(ownerResult.failure!.edge.label).toBe('keyDeliveryProtocol');

      // Delegate: closure SUCCEEDS — keyDeliveryProtocol is auto-satisfied.
      const delegateCtx = createClosureContext('did:example:alice', undefined, {
        isDelegateSession: true,
      });
      const delegateResult = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/wallet',] }, delegateCtx);

      expect(delegateResult.complete).toBe(true);
      // The edge is suppressed at extraction time — it does not appear in the graph.
      expect(delegateResult.edges.some(e => e.label === 'keyDeliveryProtocol')).toBe(false);
    });

    it('should NOT suppress keyDeliveryProtocol for delegate sessions with multi-party records', async () => {
      // Multi-party: on cache miss the runtime falls back to
      // fetchCrossDeviceContextKey() (dwn-encryption.ts:453,
      // dwn-key-delivery.ts:268) which does a local RecordsQuery +
      // RecordsRead.  That authorization path requires both the
      // key-delivery ProtocolsConfigure and the contextKey record.
      // Neither should be auto-satisfied for multi-party delegates.
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

      const parentThread = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://example.com/chat' });
      (parentThread as any).recordId = 'thread-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://example.com/chat', [protocolConfig]],
          ['recordId:thread-1', [parentThread]],
          // key-delivery protocol AND context key are MISSING
        ]),
      });

      const ctx = createClosureContext('did:example:alice', undefined, {
        isDelegateSession: true,
      });
      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/chat',] }, ctx);

      // Both keyDeliveryProtocol and contextKeyRecord are real dependencies
      // for multi-party delegates.  keyDeliveryProtocol is resolved first
      // and fails because the key-delivery ProtocolsConfigure is not installed.
      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.EncryptionDependencyMissing);
      expect(result.failure!.edge.label).toBe('keyDeliveryProtocol');
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

      const parentThread = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://threads.example.com' });
      (parentThread as any).recordId = 'thread-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://comments.example.com', [composingConfig]],
          ['protocol:https://threads.example.com', [referencedConfig]],
          ['recordId:thread-1', [parentThread]],
          ['protocol+recordId:https://threads.example.com|thread-1', [parentThread]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://comments.example.com',] }, createClosureContext('did:example:alice'));

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

      const parentThread = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://threads.example.com' });
      (parentThread as any).recordId = 'thread-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://comments.example.com', [composingConfig]],
          // No threads protocol config — missing
          ['recordId:thread-1', [parentThread]],
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://comments.example.com',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.CrossProtocolReferenceMissing);
    });

    it('should require cross-protocol role record when protocolRole is invoked', async () => {
      const composingDef = {
        protocol  : 'https://comments.example.com',
        published : true,
        uses      : { threads: 'https://threads.example.com' },
        types     : { comment: {} },
        structure : {
          thread: {
            $ref    : 'threads:thread',
            comment : {
              $actions: [
                { role: 'threads:thread/participant', can: ['create', 'read'] },
              ],
            },
          },
        },
      };
      const composingConfig = {
        descriptor: { interface: 'Protocols', method: 'Configure', definition: composingDef },
      } as any;
      const referencedConfig = {
        descriptor: { interface: 'Protocols', method: 'Configure', definition: { protocol: 'https://threads.example.com' } },
      } as any;

      // Build proper JWS authorization structure.
      // Message.getAuthor extracts DID from authorization.signature.signatures[0].protected.kid
      const protectedHeader = Buffer.from(JSON.stringify({
        kid: 'did:example:bob#key-1',
      })).toString('base64url');
      const rolePayload = Buffer.from(JSON.stringify({
        protocolRole: 'threads:thread/participant',
      })).toString('base64url');

      const msg = mockMessage({
        protocol     : 'https://comments.example.com',
        protocolPath : 'thread/comment',
        parentId     : 'thread-1',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'comment-1';
      (msg as any).contextId = 'thread-1/comment-1';
      // Real DWN authorization structure:
      // authorization.signature is a GeneralJws with:
      //   - payload: base64url JSON with protocolRole
      //   - signatures[0].protected: base64url JSON with kid (for author extraction)
      (msg as any).authorization = {
        signature: {
          payload    : rolePayload,
          signatures : [{ protected: protectedHeader, signature: 'fake' }],
        },
      };

      const parentThread = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://threads.example.com' });
      (parentThread as any).recordId = 'thread-1';

      // The role record (participant) in the referenced protocol.
      const roleRecord = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://threads.example.com',
        protocolPath : 'thread/participant',
      });
      (roleRecord as any).recordId = 'participant-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://comments.example.com', [composingConfig]],
          ['protocol:https://threads.example.com', [referencedConfig]],
          ['recordId:thread-1', [parentThread]],
          ['protocol+recordId:https://threads.example.com|thread-1', [parentThread]],
        ]),
      });

      // Override query to handle the filter-based role record query.
      (store.query as sinon.SinonStub).callsFake(
        async (_tenant: string, filters: any[]): Promise<{ messages: GenericMessage[] }> => {
          const filter = filters[0] ?? {};
          if (filter.interface === 'Protocols' && filter.protocol) {
            const key = `protocol:${filter.protocol}`;
            if (key === 'protocol:https://comments.example.com') { return { messages: [composingConfig] }; }
            if (key === 'protocol:https://threads.example.com') { return { messages: [referencedConfig] }; }
          }
          if (filter.recordId && filter.protocol && filter.interface === 'Records') {
            if (filter.protocol === 'https://threads.example.com' && filter.recordId === 'thread-1') {
              return { messages: [parentThread] };
            }
          }
          if (filter.recordId) {
            if (filter.recordId === 'thread-1') { return { messages: [parentThread] }; }
          }
          // Filter-based role record query.
          if (filter.protocol === 'https://threads.example.com' &&
              filter.protocolPath === 'thread/participant' &&
              filter.recipient === 'did:example:bob') {
            return { messages: [roleRecord] };
          }
          return { messages: [] };
        }
      );

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://comments.example.com',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'crossProtocolRoleRecord')).toBe(true);
      expect(result.edges.some(e => e.label === 'crossProtocolRoleConfig')).toBe(true);
    });

    it('should fail closure when cross-protocol role record is absent', async () => {
      const composingDef = {
        protocol  : 'https://comments.example.com',
        published : true,
        uses      : { threads: 'https://threads.example.com' },
        types     : { comment: {} },
        structure : {
          thread: {
            $ref    : 'threads:thread',
            comment : {
              $actions: [
                { role: 'threads:thread/participant', can: ['create', 'read'] },
              ],
            },
          },
        },
      };
      const composingConfig = {
        descriptor: { interface: 'Protocols', method: 'Configure', definition: composingDef },
      } as any;
      const referencedConfig = {
        descriptor: { interface: 'Protocols', method: 'Configure', definition: { protocol: 'https://threads.example.com' } },
      } as any;

      const absentProtectedHeader = Buffer.from(JSON.stringify({
        kid: 'did:example:bob#key-1',
      })).toString('base64url');
      const absentRolePayload = Buffer.from(JSON.stringify({
        protocolRole: 'threads:thread/participant',
      })).toString('base64url');

      const msg = mockMessage({
        protocol     : 'https://comments.example.com',
        protocolPath : 'thread/comment',
        parentId     : 'thread-1',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'comment-1';
      (msg as any).contextId = 'thread-1/comment-1';
      (msg as any).authorization = {
        signature: {
          payload    : absentRolePayload,
          signatures : [{ protected: absentProtectedHeader, signature: 'fake' }],
        },
      };

      const parentThread = mockMessage({ interface: 'Records', method: 'Write', protocol: 'https://threads.example.com' });
      (parentThread as any).recordId = 'thread-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://comments.example.com', [composingConfig]],
          ['protocol:https://threads.example.com', [referencedConfig]],
          ['recordId:thread-1', [parentThread]],
          ['protocol+recordId:https://threads.example.com|thread-1', [parentThread]],
          // No role record in the store!
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://comments.example.com',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.CrossProtocolReferenceMissing);
      expect(result.failure!.edge.label).toBe('crossProtocolRoleRecord');
    });

    it('should fail when crossProtocolParent record is missing in referenced protocol', async () => {
      const composingDef = {
        protocol  : 'https://comments.example.com',
        published : true,
        uses      : { threads: 'https://threads.example.com' },
        types     : { comment: {} },
        structure : {
          thread: {
            $ref    : 'threads:thread',
            comment : { $actions: [{ who: 'anyone', can: ['create'] }] },
          },
        },
      };
      const composingConfig = {
        descriptor: { interface: 'Protocols', method: 'Configure', definition: composingDef },
      } as any;
      const referencedConfig = {
        descriptor: { interface: 'Protocols', method: 'Configure', definition: { protocol: 'https://threads.example.com' } },
      } as any;

      const msg = mockMessage({
        protocol     : 'https://comments.example.com',
        protocolPath : 'thread/comment',
        parentId     : 'thread-missing',
        dateCreated  : '2025-01-01T00:00:00.000000Z',
      });
      (msg as any).recordId = 'comment-1';

      const store = mockMessageStore({
        queryResults: new Map([
          ['protocol:https://comments.example.com', [composingConfig]],
          ['protocol:https://threads.example.com', [referencedConfig]],
          // No parent thread-missing in the referenced protocol
        ]),
      });

      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://comments.example.com',] }, createClosureContext('did:example:alice'));

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.CrossProtocolReferenceMissing);
      expect(result.failure!.edge.label).toBe('crossProtocolParent');
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
      const result = await evaluateClosure(root, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, createClosureContext('did:example:alice', 3));

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
        { kind: 'protocolSet', protocols: ['https://example.com/proto'] },
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
      // Pre-populate the satisfied set with the scope-qualified dependency key format.
      ctx.satisfiedDeps.add(protocolSetDependencyKey('https://example.com/proto', 'protocolsConfigure:protocol:https://example.com/proto'));

      const msg = mockMessage({ protocol: 'https://example.com/proto', dateCreated: '2025-01-01T00:00:00.000000Z' });
      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, ctx);

      expect(result.complete).toBe(true);
      // No queries should have been made — dependency was pre-satisfied.
      expect((store.query as sinon.SinonStub).called).toBe(false);
    });

    it('should fail immediately for already-known-missing dependencies', async () => {
      const store = mockMessageStore();

      const ctx = createClosureContext('did:example:alice');
      // Pre-populate the missing set.
      ctx.missingDeps.add(protocolSetDependencyKey('https://example.com/proto', 'protocolsConfigure:protocol:https://example.com/proto'));

      const msg = mockMessage({ protocol: 'https://example.com/proto', dateCreated: '2025-01-01T00:00:00.000000Z' });
      const result = await evaluateClosure(msg, store, { kind: 'protocolSet', protocols: ['https://example.com/proto',] }, ctx);

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.ProtocolMetadataMissing);
      // No queries — failure was cached.
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
      ctx.satisfiedDeps.add(protocolSetDependencyKey('https://example.com/proto', 'permissionGrant:grantId:grant-1'));

      const grantMsg = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://identity.foundation/dwn/permissions',
        protocolPath : 'grant',
      });
      (grantMsg as any).recordId = 'grant-1';

      invalidateClosureCache(ctx, grantMsg);

      expect(ctx.grantCache.has('grant-1')).toBe(false);
      expect(ctx.satisfiedDeps.has(protocolSetDependencyKey('https://example.com/proto', 'permissionGrant:grantId:grant-1'))).toBe(false);
    });

    it('should invalidate grantCache revocation entry when a revocation is processed', () => {
      const ctx = createClosureContext('did:example:alice');
      ctx.grantCache.set('revocation:grant-1', mockMessage());
      ctx.satisfiedDeps.add(protocolSetDependencyKey('https://example.com/proto', 'grantRevocation:grantId:grant-1'));
      ctx.satisfiedDeps.add(protocolSetDependencyKey('https://example.com/proto', 'permissionGrant:grantId:grant-1'));

      const revocationMsg = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://identity.foundation/dwn/permissions',
        protocolPath : 'grant/revocation',
        parentId     : 'grant-1',
      });

      invalidateClosureCache(ctx, revocationMsg);

      expect(ctx.grantCache.has('revocation:grant-1')).toBe(false);
      expect(ctx.satisfiedDeps.has(protocolSetDependencyKey('https://example.com/proto', 'grantRevocation:grantId:grant-1'))).toBe(false);
      expect(ctx.satisfiedDeps.has(protocolSetDependencyKey('https://example.com/proto', 'permissionGrant:grantId:grant-1'))).toBe(false);
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

    it('should invalidate composite crossProtocolParent dep keys containing the recordId', () => {
      const ctx = createClosureContext('did:example:alice');
      // Composite key format: "recordId:referencedProtocol|parentId"
      ctx.missingDeps.add('recordId:https://threads.example.com|thread-1');
      ctx.satisfiedDeps.add('recordId:https://threads.example.com|thread-2');

      const parentMsg = mockMessage({ interface: 'Records', method: 'Write' });
      (parentMsg as any).recordId = 'thread-1';

      invalidateClosureCache(ctx, parentMsg);

      // thread-1 composite key should be cleared.
      expect(ctx.missingDeps.has('recordId:https://threads.example.com|thread-1')).toBe(false);
      // thread-2 should remain (different recordId).
      expect(ctx.satisfiedDeps.has('recordId:https://threads.example.com|thread-2')).toBe(true);
    });

    it('should invalidate filter-based role record dep keys matching protocol+protocolPath', () => {
      const ctx = createClosureContext('did:example:alice');
      const roleKey = 'filter:https://threads.example.com|thread/participant|did:example:bob|{"gte":"t1","lt":"t1\\uffff"}';
      ctx.missingDeps.add(roleKey);

      // A participant record arrives in the referenced protocol.
      const roleMsg = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://threads.example.com',
        protocolPath : 'thread/participant',
      });
      (roleMsg as any).recordId = 'participant-1';

      invalidateClosureCache(ctx, roleMsg);

      expect(ctx.missingDeps.has(roleKey)).toBe(false);
    });

    it('should also clear satisfiedDeps for filter-based role record keys', () => {
      const ctx = createClosureContext('did:example:alice');
      const roleKey = 'crossProtocolRoleRecord:filter:https://threads.example.com|thread/participant|did:example:bob|no-context';
      ctx.satisfiedDeps.add(roleKey);

      const roleMsg = mockMessage({
        interface    : 'Records',
        method       : 'Write',
        protocol     : 'https://threads.example.com',
        protocolPath : 'thread/participant',
      });
      (roleMsg as any).recordId = 'participant-2';

      invalidateClosureCache(ctx, roleMsg);

      expect(ctx.satisfiedDeps.has(roleKey)).toBe(false);
    });

    it('should also clear satisfiedDeps for contextKeyRecord keys', () => {
      const ctx = createClosureContext('did:example:alice');
      ctx.satisfiedDeps.add('contextKeyRecord:messageCid:https://example.com/chat|thread-1');

      const keyMsg = mockMessage({
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://identity.foundation/protocols/key-delivery',
        tags      : { protocol: 'https://example.com/chat', contextId: 'thread-1' },
      });
      (keyMsg as any).recordId = 'ctx-key-2';

      invalidateClosureCache(ctx, keyMsg);

      expect(ctx.satisfiedDeps.has('contextKeyRecord:messageCid:https://example.com/chat|thread-1')).toBe(false);
    });

    it('should invalidate contextKeyRecord dep keys when real key-delivery record arrives', () => {
      const ctx = createClosureContext('did:example:alice');
      // contextKeyRecord cache key uses the SOURCE protocol, not the key-delivery protocol.
      ctx.missingDeps.add('messageCid:https://example.com/chat|thread-1');

      // Real key-delivery record: protocol is the key-delivery protocol URI,
      // with tags pointing to the source protocol and contextId.
      const keyMsg = mockMessage({
        interface : 'Records',
        method    : 'Write',
        protocol  : 'https://identity.foundation/protocols/key-delivery',
        tags      : { protocol: 'https://example.com/chat', contextId: 'thread-1' },
      });
      (keyMsg as any).recordId = 'context-key-1';

      invalidateClosureCache(ctx, keyMsg);

      expect(ctx.missingDeps.has('messageCid:https://example.com/chat|thread-1')).toBe(false);
    });

    it('should not false-match recordId substrings (thread-1 vs thread-10)', () => {
      const ctx = createClosureContext('did:example:alice');
      ctx.missingDeps.add('recordId:thread-1');
      ctx.missingDeps.add('recordId:thread-10');

      const msg = mockMessage({ interface: 'Records', method: 'Write' });
      (msg as any).recordId = 'thread-1';

      invalidateClosureCache(ctx, msg);

      // thread-1 should be cleared, thread-10 should remain.
      expect(ctx.missingDeps.has('recordId:thread-1')).toBe(false);
      expect(ctx.missingDeps.has('recordId:thread-10')).toBe(true);
    });

    it('should clear stale missingDeps so re-evaluation can succeed', () => {
      const ctx = createClosureContext('did:example:alice');

      // Simulate a previously-missing parent record.
      ctx.missingDeps.add('recordId:parent-1');
      ctx.missingDeps.add('recordId:https://threads.example.com|parent-1');

      // The parent record arrives.
      const parentMsg = mockMessage({ interface: 'Records', method: 'Write' });
      (parentMsg as any).recordId = 'parent-1';

      invalidateClosureCache(ctx, parentMsg);

      // Both plain and composite keys should be cleared.
      expect(ctx.missingDeps.has('recordId:parent-1')).toBe(false);
      expect(ctx.missingDeps.has('recordId:https://threads.example.com|parent-1')).toBe(false);
      // Next closure evaluation will re-query and find the record present.
    });
  });
});
