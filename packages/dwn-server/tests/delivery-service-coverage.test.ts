import type { DwnServerConfig } from '../src/config.js';
import type { DidDocument, DidResolutionResult, DidResolver } from '@enbox/dids';
import type { Dwn, GenericMessage, ModuleDefinition, RecordsQueryMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';
import { DataStream, DwnConstant, DwnInterfaceName, DwnMethodName, Encoder, Message, Poller } from '@enbox/dwn-sdk-js';
import { HTTP_DWN_RPC_MEDIA_TYPE, parseHttpDwnRpcRequestBody } from '@enbox/dwn-clients';

import { config } from '../src/config.js';
import { DeliveryService } from '../src/delivery-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal config for tests with forwarding + delivery enabled. */
function testConfig(overrides: Partial<DwnServerConfig> = {}): DwnServerConfig {
  return {
    ...config,
    baseUrl                           : 'http://self.example.com',
    forwardingEnabled                 : true,
    deliveryEnabled                   : true,
    deliveryMaxConcurrency            : 2,
    deliveryEndpointCacheTtlSeconds   : 60,
    forwardingDeduplicationTtlSeconds : 60,
    ...overrides,
  };
}

/** Creates a fake DidResolver that returns the given DID document. */
function fakeResolver(docs: Record<string, DidDocument | undefined>): DidResolver {
  return {
    resolve: async (did: string): Promise<DidResolutionResult> => {
      const doc = docs[did];
      return {
        didResolutionMetadata : {},
        didDocument           : doc ?? null,
        didDocumentMetadata   : {},
      } as DidResolutionResult;
    },
    dereference : sinon.stub(),
    cache       : undefined as any,
  } as unknown as DidResolver;
}

/** Creates a fake DidResolver that always throws. */
function throwingResolver(): DidResolver {
  return {
    resolve: async (): Promise<DidResolutionResult> => {
      throw new Error('resolve failed');
    },
    dereference : sinon.stub(),
    cache       : undefined as any,
  } as unknown as DidResolver;
}

/** Optional storage stubs for `mockDwn` — used by the record-data forwarding tests. */
type MockDwnStorage = {
  messageStoreGet?: sinon.SinonStub;
  dataStoreGet?: sinon.SinonStub;
};

/** Creates a mock DWN with a configurable processMessage stub. */
function mockDwn(processMessageFn?: sinon.SinonStub, storage: MockDwnStorage = {}): Dwn {
  return {
    processMessage: processMessageFn ?? sinon.stub().resolves({
      status  : { code: 200 },
      entries : [],
    }),
    storage: {
      messageStore : { get: storage.messageStoreGet ?? sinon.stub().resolves(undefined) },
      dataStore    : { get: storage.dataStoreGet ?? sinon.stub().resolves(undefined) },
      eventLog     : undefined,
    },
    close: sinon.stub(),
  } as unknown as Dwn;
}

/** Creates a DID document with DWN service endpoints. */
function didDocWithDwnService(did: string, endpoints: string[]): DidDocument {
  return {
    id      : did,
    service : [{
      id              : `${did}#dwn`,
      type            : 'DecentralizedWebNode',
      serviceEndpoint : endpoints,
    }],
  } as DidDocument;
}

/** Creates a DID document with DWN service endpoint as object with nodes. */
function didDocWithDwnNodes(did: string, nodes: string[]): DidDocument {
  return {
    id      : did,
    service : [{
      id              : `${did}#dwn`,
      type            : 'DecentralizedWebNode',
      serviceEndpoint : { nodes },
    }],
  } as DidDocument;
}

/** Creates a DID document with a single string endpoint. */
function didDocWithSingleEndpoint(did: string, endpoint: string): DidDocument {
  return {
    id      : did,
    service : [{
      id              : `${did}#dwn`,
      type            : 'DecentralizedWebNode',
      serviceEndpoint : endpoint,
    }],
  } as DidDocument;
}

/** A RecordsWrite message with module fields for delivery tests. */
function moduleWriteMessage(opts: {
  module?: string;
  modulePath?: string;
  contextId?: string;
  recordId?: string;
  recipient?: string;
}): GenericMessage {
  return {
    descriptor: {
      interface        : DwnInterfaceName.Records,
      method           : DwnMethodName.Write,
      messageTimestamp : new Date().toISOString(),
      module           : opts.module,
      modulePath       : opts.modulePath,
      recipient        : opts.recipient,
    },
    contextId : opts.contextId,
    recordId  : opts.recordId ?? 'test-record-id',
  } as unknown as GenericMessage;
}

/** A simple RecordsWrite message for forwarding tests. */
function recordsWriteMessage(recordId = 'test-record'): GenericMessage {
  return {
    descriptor: {
      interface        : DwnInterfaceName.Records,
      method           : DwnMethodName.Write,
      messageTimestamp : new Date().toISOString(),
    },
    recordId,
  } as unknown as GenericMessage;
}

/**
 * A RecordsWrite message referencing record data, for payload-forwarding tests.
 * Every descriptor key is defined so the message can be CID-computed.
 */
function dataBearingWriteMessage(opts: { recordId?: string; dataCid?: string; dataSize: number }): GenericMessage {
  return {
    descriptor: {
      interface        : DwnInterfaceName.Records,
      method           : DwnMethodName.Write,
      messageTimestamp : new Date().toISOString(),
      dataCid          : opts.dataCid ?? 'bafy-test-data-cid',
      dataSize         : opts.dataSize,
    },
    recordId: opts.recordId ?? 'data-record-1',
  } as unknown as GenericMessage;
}

/** A RecordsDelete message for forwarding tests. */
function recordsDeleteMessage(recordId = 'test-record'): GenericMessage {
  return {
    descriptor: {
      interface        : DwnInterfaceName.Records,
      method           : DwnMethodName.Delete,
      messageTimestamp : new Date().toISOString(),
    },
    recordId,
  } as unknown as GenericMessage;
}

/**
 * Creates a base64url-encoded JSON string (no padding).
 * Used to mock JWS `protected` headers containing a `kid`.
 */
function base64UrlEncode(obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj);
  return Buffer.from(json).toString('base64url');
}

/**
 * Creates a mock ancestor RecordsWrite entry with the given author (via JWS)
 * and optional recipient. The `authorization.signature` mimics the structure
 * that `Message.getAuthor()` / `Jws.getSignerDid()` expects.
 */
function ancestorEntry(opts: { author: string; recipient?: string }): Record<string, unknown> {
  return {
    descriptor: {
      interface  : DwnInterfaceName.Records,
      method     : DwnMethodName.Write,
      module     : 'http://example.com/social',
      modulePath : 'friend',
      recipient  : opts.recipient,
    },
    authorization: {
      signature: {
        signatures: [{
          protected : base64UrlEncode({ kid: `${opts.author}#key-1` }),
          signature : 'fake-sig',
        }],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeliveryService — coverage', () => {
  afterEach(() => {
    sinon.restore();
  });

  // -----------------------------------------------------------------------
  // Forwarding (#forwardToEndpoints, #sendToEndpoints, #sendMessage)
  // -----------------------------------------------------------------------

  describe('forwarding', () => {
    it('should forward RecordsWrite to peer endpoints (excluding self)', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, [
          'http://self.example.com', // self — should be excluded
          'http://peer1.example.com', // peer — should receive
          'http://peer2.example.com/', // trailing slash — self check should trim
        ]),
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);

      // Give async dispatch time to run.
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      // Should have forwarded to peer1 and peer2.
      expect(fetchStub.callCount).toBe(2);
      const urls = fetchStub.getCalls().map((c): string => c.args[0] as string);
      expect(urls).toContain('http://peer1.example.com');
      expect(urls).toContain('http://peer2.example.com');
    });

    it('should forward RecordsDelete messages', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, [
          'http://self.example.com',
          'http://peer.example.com',
        ]),
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsDeleteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(1);
    });

    it('should not forward when DID has no service endpoints', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: { id: tenant } as DidDocument, // no service field
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should not forward when all endpoints are self', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, ['http://self.example.com']),
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should skip duplicate forwards using deduplication cache', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, [
          'http://self.example.com',
          'http://peer.example.com',
        ]),
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      // First dispatch — should forward.
      svc.dispatchIfNeeded(tenant, recordsWriteMessage('record-1'), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));
      expect(fetchStub.callCount).toBe(1);

      // Second dispatch with same recordId — should be deduped.
      svc.dispatchIfNeeded(tenant, recordsWriteMessage('record-1'), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));
      expect(fetchStub.callCount).toBe(1); // Still 1
    });

    it('should handle DID resolution failure gracefully', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, throwingResolver(), testConfig());

      svc.dispatchIfNeeded('did:test:alice', recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should handle DID document without didDocument field', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const resolver = fakeResolver({ 'did:test:alice': undefined });
      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded('did:test:alice', recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should use endpoint cache for subsequent resolutions', async () => {
      sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const resolveStub = sinon.stub().resolves({
        didResolutionMetadata : {},
        didDocument           : didDocWithDwnService(tenant, [
          'http://self.example.com',
          'http://peer.example.com',
        ]),
        didDocumentMetadata: {},
      });

      const resolver = { resolve: resolveStub, dereference: sinon.stub() } as unknown as DidResolver;
      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      // First dispatch — resolves DID.
      svc.dispatchIfNeeded(tenant, recordsWriteMessage('r1'), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));
      expect(resolveStub.callCount).toBe(1);

      // Second dispatch with different record — should use cache.
      svc.dispatchIfNeeded(tenant, recordsWriteMessage('r2'), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));
      expect(resolveStub.callCount).toBe(1); // Still 1 — cache hit
    });

    it('should handle fetch returning 409 (duplicate) as success', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 409 }),
      );

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, [
          'http://self.example.com',
          'http://peer.example.com',
        ]),
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      // Should have been called once (409 is treated as success, no retry).
      expect(fetchStub.callCount).toBe(1);
    });

    it('should retry on non-OK/non-409 response and eventually give up', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 500 }),
      );

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, [
          'http://self.example.com',
          'http://peer.example.com',
        ]),
      });

      const dwn = mockDwn();
      // Use very short dedup TTL so the retry delays are the only waits.
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);

      // Wait long enough for all retries (1s + 5s + initial = ~6.5s).
      // We use a larger timeout to accommodate retry delays.
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 8_000));

      // 3 attempts total (initial + 2 retries).
      expect(fetchStub.callCount).toBe(3);
    }, 15_000);

    it('should retry on fetch error (network failure)', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').rejects(new Error('network failure'));

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, [
          'http://self.example.com',
          'http://peer.example.com',
        ]),
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 8_000));

      expect(fetchStub.callCount).toBe(3);
    }, 15_000);

    it('should extract endpoints from service with string endpoint', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithSingleEndpoint(tenant, 'http://peer.example.com/'),
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(1);
      expect(fetchStub.firstCall.args[0]).toBe('http://peer.example.com');
    });

    it('should strip multiple trailing slashes from endpoints', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, [
          'http://self.example.com',
          'http://peer.example.com///',
        ]),
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(1);
      expect(fetchStub.firstCall.args[0]).toBe('http://peer.example.com');
    });

    it('should extract endpoints from service with nodes object', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnNodes(tenant, ['http://peer.example.com/']),
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(1);
    });

    it('should skip non-DecentralizedWebNode services', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: {
          id      : tenant,
          service : [{
            id              : `${tenant}#other`,
            type            : 'SomeOtherService',
            serviceEndpoint : 'http://other.example.com',
          }],
        } as DidDocument,
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should not forward when forwardingEnabled is false', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, ['http://peer.example.com']),
      });

      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : false,
      }));

      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Record data payloads (#getRecordsWriteData)
  // -----------------------------------------------------------------------

  describe('forwarding record data', () => {
    it('should attach small record data from the message store as the request body', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const dataBytes = new TextEncoder().encode('{"hello":"world"}');
      const message = dataBearingWriteMessage({ dataSize: dataBytes.length });
      const messageStoreGet = sinon.stub().resolves({ ...message, encodedData: Encoder.bytesToBase64Url(dataBytes) });

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, ['http://self.example.com', 'http://peer.example.com']),
      });

      const dwn = mockDwn(undefined, { messageStoreGet });
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, message, 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(1);
      expect(messageStoreGet.callCount).toBe(1);
      expect(messageStoreGet.firstCall.args[0]).toBe(tenant);
      expect(messageStoreGet.firstCall.args[1]).toBe(await Message.getCid(message));

      const [, fetchOptions] = fetchStub.firstCall.args;
      const headers = new Headers(fetchOptions?.headers);
      expect(headers.get('content-type')).toBe(HTTP_DWN_RPC_MEDIA_TYPE);
      expect(fetchOptions?.body).toBeInstanceOf(ReadableStream);

      const parsed = await parseHttpDwnRpcRequestBody(fetchOptions?.body as ReadableStream<Uint8Array>);
      const sentBytes = await DataStream.toBytes(parsed.dataStream!);
      expect(sentBytes).toEqual(dataBytes);
    });

    it('should stream large record data from the data store with a one-shot body', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const dataSize = DwnConstant.maxDataSizeAllowedToBeEncoded + 1;
      const dataBytes = new TextEncoder().encode('large-record-data');
      const dataStoreGet = sinon.stub().callsFake(
        async (): Promise<{ dataSize: number; dataStream: ReadableStream<Uint8Array> }> => ({
          dataSize,
          dataStream: DataStream.fromBytes(dataBytes),
        }),
      );
      const message = dataBearingWriteMessage({ recordId: 'large-record-1', dataSize });

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, ['http://self.example.com', 'http://peer.example.com']),
      });

      const dwn = mockDwn(undefined, { dataStoreGet });
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, message, 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(1);
      expect(dataStoreGet.callCount).toBe(1);
      expect(dataStoreGet.firstCall.args).toEqual([tenant, 'large-record-1', 'bafy-test-data-cid']);

      const [, fetchOptions] = fetchStub.firstCall.args;
      const headers = new Headers(fetchOptions?.headers);
      expect(headers.get('content-type')).toBe(HTTP_DWN_RPC_MEDIA_TYPE);
      expect(fetchOptions).toMatchObject({ duplex: 'half' });
      expect(fetchOptions?.body).toBeInstanceOf(ReadableStream);

      const parsed = await parseHttpDwnRpcRequestBody(fetchOptions?.body as ReadableStream<Uint8Array>);
      const sentBytes = await DataStream.toBytes(parsed.dataStream!);
      expect(sentBytes).toEqual(dataBytes);
    });

    it('should skip the send without retrying when record data is no longer available locally', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const message = dataBearingWriteMessage({ recordId: 'displaced-record-1', dataSize: 32 });
      const messageStoreGet = sinon.stub().resolves(undefined);

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, ['http://self.example.com', 'http://peer.example.com']),
      });

      const dwn = mockDwn(undefined, { messageStoreGet });
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, message, 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(0);
      expect(messageStoreGet.callCount).toBe(1);
    });

    it('should re-read the data for each retry attempt', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.onFirstCall().resolves(new Response(null, { status: 500 }));
      fetchStub.onSecondCall().resolves(new Response(null, { status: 200 }));

      const dataSize = DwnConstant.maxDataSizeAllowedToBeEncoded + 1;
      const dataBytes = new TextEncoder().encode('retry-payload');
      const dataStoreGet = sinon.stub().callsFake(
        async (): Promise<{ dataSize: number; dataStream: ReadableStream<Uint8Array> }> => ({
          dataSize,
          dataStream: DataStream.fromBytes(dataBytes),
        }),
      );
      const message = dataBearingWriteMessage({ recordId: 'retry-record-1', dataSize });

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, ['http://self.example.com', 'http://peer.example.com']),
      });

      const dwn = mockDwn(undefined, { dataStoreGet });
      const svc = DeliveryService.create(dwn, resolver, testConfig());

      svc.dispatchIfNeeded(tenant, message, 202);

      // Wait for the first attempt plus the 1s retry delay.
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 2_500));

      // Each attempt gets a freshly-read body — a stream cannot be replayed.
      expect(fetchStub.callCount).toBe(2);
      expect(dataStoreGet.callCount).toBe(2);
    }, 10_000);

    it('should read delivery payload data from the origin tenant while targeting the participant', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const participant = 'did:test:bob';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : {
          thread      : {},
          participant : {},
          message     : {},
        },
        structure: {
          thread: {
            participant : { $role: true, $actions: [{ role: 'thread/participant', can: ['read'] }] },
            message     : {
              $delivery : 'direct',
              $actions  : [{ role: 'thread/participant', can: ['create', 'read'] }],
            },
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [
          { descriptor: { recipient: participant } },
        ],
      });

      const dataSize = DwnConstant.maxDataSizeAllowedToBeEncoded + 1;
      const dataBytes = new TextEncoder().encode('delivered-data');
      const dataStoreGet = sinon.stub().callsFake(
        async (): Promise<{ dataSize: number; dataStream: ReadableStream<Uint8Array> }> => ({
          dataSize,
          dataStream: DataStream.fromBytes(dataBytes),
        }),
      );

      const dwn = mockDwn(processStub, { dataStoreGet });
      const resolver = fakeResolver({
        [participant]: didDocWithDwnService(participant, ['http://bob-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      const message = {
        descriptor: {
          interface        : DwnInterfaceName.Records,
          method           : DwnMethodName.Write,
          messageTimestamp : new Date().toISOString(),
          module           : 'http://example.com/chat',
          modulePath       : 'thread/message',
          dataCid          : 'bafy-delivered-data',
          dataSize,
        },
        contextId : 'ctx-data-1/deliver-data-1',
        recordId  : 'deliver-data-1',
      } as unknown as GenericMessage;

      svc.dispatchIfNeeded(tenant, message, 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(1);
      expect(fetchStub.firstCall.args[0]).toBe('http://bob-dwn.example.com');

      // The data is read from the origin tenant's store...
      expect(dataStoreGet.callCount).toBe(1);
      expect(dataStoreGet.firstCall.args[0]).toBe(tenant);

      // ...while the JSON-RPC envelope targets the participant.
      const [, fetchOptions] = fetchStub.firstCall.args;
      const headers = new Headers(fetchOptions?.headers);
      expect(headers.get('content-type')).toBe(HTTP_DWN_RPC_MEDIA_TYPE);
      const parsed = await parseHttpDwnRpcRequestBody(new Response(fetchOptions?.body).body!);
      expect((parsed.jsonRpcRequest.params as Record<string, unknown>).target).toBe(participant);
    });
  });

  // -----------------------------------------------------------------------
  // Delivery (#deliverToParticipants, #resolveDeliveryTargets, etc.)
  // -----------------------------------------------------------------------

  describe('delivery', () => {
    it('should not deliver for non-module messages', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({});
      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      // Message without module/modulePath.
      svc.dispatchIfNeeded(tenant, recordsWriteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should not deliver when module definition is not found', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';
      const processStub = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [], // no module definition found
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({});
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/module',
        modulePath : 'post',
        recordId   : 'deliver-1',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should not deliver when module query returns error', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';
      const processStub = sinon.stub().resolves({
        status  : { code: 500 },
        entries : undefined,
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({});
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/module',
        modulePath : 'post',
        recordId   : 'deliver-2',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should not deliver when ruleSet has no $delivery', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';
      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/module',
        published : true,
        types     : { post: {} },
        structure : { post: {} }, // no $delivery
      };

      const processStub = sinon.stub().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({});
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/module',
        modulePath : 'post',
        recordId   : 'deliver-3',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should deliver to participants when $delivery is "direct"', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const participant = 'did:test:bob';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : {
          thread      : {},
          participant : {},
          message     : {},
        },
        structure: {
          thread: {
            participant : { $role: true, $actions: [{ role: 'thread/participant', can: ['read'] }] },
            message     : {
              $delivery : 'direct',
              $actions  : [{ role: 'thread/participant', can: ['create', 'read'] }],
            },
          },
        },
      };

      // First call: ModulesQuery returns definition.
      // Second call: RecordsQuery returns role records with recipients.
      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [
          { descriptor: { recipient: participant } },
        ],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [participant]: didDocWithDwnService(participant, ['http://bob-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'thread/message',
        contextId  : 'ctx-1',
        recordId   : 'deliver-direct-1',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      // Should have sent to bob's DWN endpoint.
      expect(fetchStub.callCount).toBe(1);
      expect(fetchStub.firstCall.args[0]).toBe('http://bob-dwn.example.com');
    });

    it('should complete one role lookup before querying the next delivery action', async () => {
      const tenant = 'did:test:alice';
      const firstRecipient = 'did:test:first';
      const secondRecipient = 'did:test:second';
      const moduleDefinition: ModuleDefinition = {
        module    : 'https://example.com/ordered-delivery',
        published : true,
        types     : { first: {}, second: {}, message: {} },
        structure : {
          first   : { $role: true },
          second  : { $role: true },
          message : {
            $delivery : 'direct',
            $actions  : [{ role: 'first', can: ['read'] }, { role: 'second', can: ['read'] }],
          },
        },
      };
      const lookups: string[] = [];
      let releaseFirstLookup!: () => void;
      const firstLookupGate = new Promise<void>(resolve => {
        releaseFirstLookup = resolve;
      });
      let announceFirstLookup!: () => void;
      const firstLookupStarted = new Promise<void>(resolve => {
        announceFirstLookup = resolve;
      });
      const processStub = sinon.stub().callsFake(async (_tenant: string, message: GenericMessage) => {
        if (message.descriptor.interface === DwnInterfaceName.Modules) {
          return { status: { code: 200 }, entries: [{ descriptor: { definition: moduleDefinition } }] };
        }
        const path = (message as RecordsQueryMessage).descriptor.filter.modulePath!;
        lookups.push(path);
        if (path === 'first') {
          announceFirstLookup();
          await firstLookupGate;
        }
        return { status: { code: 200 }, entries: [{ descriptor: { recipient: path === 'first' ? firstRecipient : secondRecipient } }] };
      });
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response(null, { status: 200 }));
      const resolver = fakeResolver({
        [firstRecipient]  : didDocWithDwnService(firstRecipient, ['http://first.example.com']),
        [secondRecipient] : didDocWithDwnService(secondRecipient, ['http://second.example.com']),
      });
      const service = DeliveryService.create(mockDwn(processStub), resolver, testConfig({ forwardingEnabled: false, deliveryEnabled: true }));
      service.dispatchIfNeeded(tenant, moduleWriteMessage({ module: moduleDefinition.module, modulePath: 'message' }), 202);
      try {
        await firstLookupStarted;
        expect(lookups).toEqual(['first']);
        expect(fetchStub.callCount).toBe(0);
      } finally {
        releaseFirstLookup();
        await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
          expect(fetchStub.callCount).toBe(2);
        });
      }
      expect(lookups).toEqual(['first', 'second']);
    });

    it('should deliver to explicit recipient on the record', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const recipient = 'did:test:carol';

      // Module with $delivery: "direct" but NO role-based $actions rules.
      // The only delivery target should come from the record's recipient field.
      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/dm',
        published : true,
        types     : { message: {}, member: {} },
        structure : {
          member  : { $role: true },
          message : {
            $delivery : 'direct',
            $actions  : [
              { who: 'recipient', of: 'message', can: ['read'] },
            ],
          },
        },
      };

      // Call 1: ModulesQuery returns definition.
      // Call 2: Ancestor query for `of: "message"` — the actor-based branch also
      //         fires, returning carol as recipient of the ancestor (same record).
      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [ancestorEntry({ author: tenant, recipient })],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [recipient]: didDocWithDwnService(recipient, ['http://carol-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/dm',
        modulePath : 'message',
        recordId   : 'deliver-recipient-1',
        recipient  : recipient,
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      // Should have sent to carol's DWN endpoint via the explicit recipient.
      expect(fetchStub.callCount).toBe(1);
      expect(fetchStub.firstCall.args[0]).toBe('http://carol-dwn.example.com');
    });

    it('should deliver to both explicit recipient and role-based targets without duplicates', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const recipient = 'did:test:bob'; // explicit recipient
      const roleMember = 'did:test:carol'; // discovered via role

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : {
          thread      : {},
          participant : {},
          message     : {},
        },
        structure: {
          thread: {
            participant : { $role: true, $actions: [{ role: 'thread/participant', can: ['read'] }] },
            message     : {
              $delivery : 'direct',
              $actions  : [{ role: 'thread/participant', can: ['create', 'read'] }],
            },
          },
        },
      };

      // First call: ModulesQuery returns definition.
      // Second call: RecordsQuery for role records returns carol (and bob is NOT a role member).
      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [
          { descriptor: { recipient: roleMember } },
        ],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [recipient]  : didDocWithDwnService(recipient, ['http://bob-dwn.example.com']),
        [roleMember] : didDocWithDwnService(roleMember, ['http://carol-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'thread/message',
        contextId  : 'ctx-1',
        recordId   : 'deliver-combined-1',
        recipient  : recipient,
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      // Should have sent to BOTH bob (explicit recipient) and carol (role-based).
      expect(fetchStub.callCount).toBe(2);
      const calledUrls = [fetchStub.firstCall.args[0], fetchStub.secondCall.args[0]];
      expect(calledUrls).toContain('http://bob-dwn.example.com');
      expect(calledUrls).toContain('http://carol-dwn.example.com');
    });

    it('should not deliver to the tenant itself', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : { message: {}, member: {} },
        structure : {
          member  : { $role: true },
          message : {
            $delivery : 'direct',
            $actions  : [{ role: 'member', can: ['read'] }],
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { recipient: tenant } }], // tenant is the only participant
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, ['http://alice-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'message',
        recordId   : 'deliver-self-1',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should not deliver when role query returns no recipients', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : { message: {}, member: {} },
        structure : {
          member  : { $role: true },
          message : {
            $delivery : 'direct',
            $actions  : [{ role: 'member', can: ['read'] }],
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [], // no role records
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({});
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'message',
        recordId   : 'deliver-no-recip',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should skip participants whose DID has no endpoints', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : { message: {}, member: {} },
        structure : {
          member  : { $role: true },
          message : {
            $delivery : 'direct',
            $actions  : [{ role: 'member', can: ['read'] }],
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { recipient: 'did:test:no-endpoint' } }],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        'did:test:no-endpoint': { id: 'did:test:no-endpoint' } as DidDocument, // no service
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'message',
        recordId   : 'deliver-no-ep',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should deduplicate delivery to the same participant for the same message', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const participant = 'did:test:bob';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : { message: {}, member: {} },
        structure : {
          member  : { $role: true },
          message : {
            $delivery : 'direct',
            $actions  : [{ role: 'member', can: ['read'] }],
          },
        },
      };

      const processStub = sinon.stub();
      // Same setup for both dispatches.
      processStub.resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { recipient: participant } }],
      });
      processStub.onCall(3).resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { recipient: participant } }],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [participant]: didDocWithDwnService(participant, ['http://bob-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      // First delivery.
      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'message',
        recordId   : 'dedup-test',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      const firstCount = fetchStub.callCount;

      // Second delivery with same recordId — should be deduped.
      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'message',
        recordId   : 'dedup-test',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(firstCount);
    });

    it('should handle role query returning recipients in top-level field', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const participant = 'did:test:carol';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : { message: {}, member: {} },
        structure : {
          member  : { $role: true },
          message : {
            $delivery : 'direct',
            $actions  : [{ role: 'member', can: ['read'] }],
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [{ recipient: participant }], // top-level recipient field
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [participant]: didDocWithDwnService(participant, ['http://carol-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'message',
        recordId   : 'top-level-recip',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(1);
    });

    it('should handle role query failure gracefully', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : { message: {}, member: {} },
        structure : {
          member  : { $role: true },
          message : {
            $delivery : 'direct',
            $actions  : [{ role: 'member', can: ['read'] }],
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      // Role query throws.
      processStub.onSecondCall().rejects(new Error('query failed'));

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({});
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'message',
        recordId   : 'role-query-fail',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      // Should not crash; no delivery attempted.
      expect(fetchStub.callCount).toBe(0);
    });

    it('should handle module query throwing an exception', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';
      const processStub = sinon.stub().rejects(new Error('dwn error'));

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({});
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/module',
        modulePath : 'post',
        recordId   : 'module-throw',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should not deliver for RecordsDelete even when deliveryEnabled', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({});
      const dwn = mockDwn();
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      // Delivery is only for Write, not Delete.
      svc.dispatchIfNeeded(tenant, recordsDeleteMessage(), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should handle role query with nested contextId scoping', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const participant = 'did:test:dave';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : {
          thread      : {},
          participant : {},
          message     : {},
        },
        structure: {
          thread: {
            participant : { $role: true },
            message     : {
              $delivery : 'direct',
              $actions  : [{ role: 'thread/participant', can: ['create', 'read'] }],
            },
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { recipient: participant } }],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [participant]: didDocWithDwnService(participant, ['http://dave-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'thread/message',
        contextId  : 'ctx-root/sub-context',
        recordId   : 'nested-ctx-1',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(1);
    });

    it('should handle role query returning non-200 status', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/chat',
        published : true,
        types     : { message: {}, member: {} },
        structure : {
          member  : { $role: true },
          message : {
            $delivery : 'direct',
            $actions  : [{ role: 'member', can: ['read'] }],
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 401 },
        entries : undefined,
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({});
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/chat',
        modulePath : 'message',
        recordId   : 'role-401',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Actor-based delivery (who: "author"/"recipient" + of)
  // -----------------------------------------------------------------------

  describe('actor-based delivery', () => {
    it('should deliver to the author of the ancestor record (who: "author", of: "friend")', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const friendAuthor = 'did:test:bob';

      // A social module where "friend/post" records are delivered to the
      // author of the parent "friend" record.
      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/social',
        published : true,
        types     : { friend: {}, post: {} },
        structure : {
          friend: {
            post: {
              $delivery : 'direct',
              $actions  : [{ who: 'author', of: 'friend', can: ['read'] }],
            },
          },
        },
      };

      // Call 1: ModulesQuery returns the module definition.
      // Call 2: RecordsQuery for the ancestor "friend" record returns Bob as author.
      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [ancestorEntry({ author: friendAuthor })],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [friendAuthor]: didDocWithDwnService(friendAuthor, ['http://bob-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/social',
        modulePath : 'friend/post',
        contextId  : 'ctx-friend-1/ctx-post-1',
        recordId   : 'actor-author-1',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(1);
      expect(fetchStub.firstCall.args[0]).toBe('http://bob-dwn.example.com');
    });

    it('should deliver to the recipient of the ancestor record (who: "recipient", of: "request")', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const requestRecipient = 'did:test:carol';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/request',
        published : true,
        types     : { request: {}, response: {} },
        structure : {
          request: {
            response: {
              $delivery : 'direct',
              $actions  : [{ who: 'recipient', of: 'request', can: ['read'] }],
            },
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [ancestorEntry({ author: 'did:test:alice', recipient: requestRecipient })],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [requestRecipient]: didDocWithDwnService(requestRecipient, ['http://carol-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/request',
        modulePath : 'request/response',
        contextId  : 'ctx-req/ctx-resp',
        recordId   : 'actor-recipient-1',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(1);
      expect(fetchStub.firstCall.args[0]).toBe('http://carol-dwn.example.com');
    });

    it('should combine actor-based and role-based targets without duplicates', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const friendAuthor = 'did:test:bob';
      const roleMember = 'did:test:carol';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/social',
        published : true,
        types     : { friend: {}, moderator: {}, post: {} },
        structure : {
          friend: {
            moderator : { $role: true },
            post      : {
              $delivery : 'direct',
              $actions  : [
                { who: 'author', of: 'friend', can: ['read'] },
                { role: 'friend/moderator', can: ['read'] },
              ],
            },
          },
        },
      };

      // Rules are processed in order: first the role-based rule resolves, then
      // the actor-based rule resolves. But within each rule, the code checks
      // `rule.role` first, then `rule.who`/`rule.of`. Since the role rule is
      // listed second in $actions, the actor rule (first in $actions) is processed
      // first — it skips role (undefined) and enters actor branch.
      //
      // Actual call order:
      // Call 1: ModulesQuery returns definition.
      // Call 2: RecordsQuery for ancestor "friend" (actor-based, processed first).
      // Call 3: RecordsQuery for role recipients (moderator, processed second).
      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [ancestorEntry({ author: friendAuthor })],
      });
      processStub.onThirdCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { recipient: roleMember } }],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [friendAuthor] : didDocWithDwnService(friendAuthor, ['http://bob-dwn.example.com']),
        [roleMember]   : didDocWithDwnService(roleMember, ['http://carol-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/social',
        modulePath : 'friend/post',
        contextId  : 'ctx-friend-1/ctx-post-1',
        recordId   : 'actor-combined-1',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      // Both bob (author of friend) and carol (moderator role) should receive.
      expect(fetchStub.callCount).toBe(2);
      const calledUrls = [fetchStub.firstCall.args[0], fetchStub.secondCall.args[0]];
      expect(calledUrls).toContain('http://bob-dwn.example.com');
      expect(calledUrls).toContain('http://carol-dwn.example.com');
    });

    it('should deduplicate when actor-based target matches role-based target', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const bob = 'did:test:bob'; // bob is both the author AND a role member

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/social',
        published : true,
        types     : { friend: {}, moderator: {}, post: {} },
        structure : {
          friend: {
            moderator : { $role: true },
            post      : {
              $delivery : 'direct',
              $actions  : [
                { who: 'author', of: 'friend', can: ['read'] },
                { role: 'friend/moderator', can: ['read'] },
              ],
            },
          },
        },
      };

      // Actor rule is listed first in $actions, so it resolves first:
      // Call 1: ModulesQuery → definition
      // Call 2: Ancestor query (actor-based) → bob as author
      // Call 3: Role query (role-based) → bob as role recipient
      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [ancestorEntry({ author: bob })],
      });
      processStub.onThirdCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { recipient: bob } }],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({
        [bob]: didDocWithDwnService(bob, ['http://bob-dwn.example.com']),
      });

      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/social',
        modulePath : 'friend/post',
        contextId  : 'ctx-friend-1/ctx-post-1',
        recordId   : 'actor-dedup-1',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      // Bob should only receive once, not twice.
      expect(fetchStub.callCount).toBe(1);
      expect(fetchStub.firstCall.args[0]).toBe('http://bob-dwn.example.com');
    });

    it('should not deliver when ancestor record is not found', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/social',
        published : true,
        types     : { friend: {}, post: {} },
        structure : {
          friend: {
            post: {
              $delivery : 'direct',
              $actions  : [{ who: 'author', of: 'friend', can: ['read'] }],
            },
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      // Ancestor query returns empty — the friend record was deleted or not found.
      processStub.onSecondCall().resolves({
        status  : { code: 200 },
        entries : [],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({});
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/social',
        modulePath : 'friend/post',
        contextId  : 'ctx-friend-1/ctx-post-1',
        recordId   : 'actor-no-ancestor',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(0);
    });

    it('should handle ancestor query failure gracefully', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/social',
        published : true,
        types     : { friend: {}, post: {} },
        structure : {
          friend: {
            post: {
              $delivery : 'direct',
              $actions  : [{ who: 'author', of: 'friend', can: ['read'] }],
            },
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });
      // Ancestor query throws.
      processStub.onSecondCall().rejects(new Error('query failed'));

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({});
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/social',
        modulePath : 'friend/post',
        contextId  : 'ctx-friend-1/ctx-post-1',
        recordId   : 'actor-query-fail',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      // Should not crash; no delivery attempted.
      expect(fetchStub.callCount).toBe(0);
    });

    it('should resolve publicly readable foreign roles and actors through a chained attachment', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').callsFake(async () => new Response(null, { status: 200 }));
      const tenant = 'did:test:alice';
      const member = 'did:test:bob';
      const author = 'did:test:carol';
      const threads: ModuleDefinition = {
        module    : 'https://example.com/delivery/threads', published : true,
        types     : { thread: {}, member: {} },
        structure : { thread: { $actions: [{ who: 'anyone', can: ['read'] }], member: { $role: true, $actions: [{ who: 'anyone', can: ['read'] }] } } },
      };
      const discussions: ModuleDefinition = {
        module    : 'https://example.com/delivery/discussions', published : true,
        uses      : { threads: threads.module }, types     : { discussion: {} },
        structure : { thread: { $ref: 'threads:thread', discussion: {} } },
      };
      const posts: ModuleDefinition = {
        module    : 'https://example.com/delivery/posts', published : true,
        uses      : { threads: threads.module, discussions: discussions.module }, types     : { post: {} },
        structure : { discussion: {
          $ref : 'discussions:thread/discussion',
          post : { $delivery : 'direct', $actions  : [
            { role: 'threads:thread/member', can: ['read'] },
            { who: 'author', of: 'threads:thread', can: ['read'] },
          ] },
        } },
      };
      const definitions = new Map([threads, discussions, posts].map(definition => [definition.module, definition]));
      // Existing unsigned delivery discovery only sees published records. This
      // fixture intentionally publishes the thread and membership metadata.
      const processStub = sinon.stub().callsFake(async (_tenant, message) => {
        const filter = message.descriptor.filter;
        if (message.descriptor.interface === DwnInterfaceName.Modules) {
          return { status: { code: 200 }, entries: [{ descriptor: { definition: definitions.get(filter.module) } }] };
        }
        return {
          status  : { code: 200 },
          entries : filter.modulePath === 'thread/member'
            ? [{ contextId: 'thread-id/member-id', descriptor: { module: threads.module, modulePath: 'thread/member', recipient: member, published: true } }]
            : [{ ...ancestorEntry({ author }), contextId: 'thread-id', descriptor: { module: threads.module, modulePath: 'thread', published: true } }],
        };
      });
      const service = DeliveryService.create(mockDwn(processStub), fakeResolver({
        [member] : didDocWithDwnService(member, ['https://bob.example']),
        [author] : didDocWithDwnService(author, ['https://carol.example']),
      }), testConfig({ forwardingEnabled: false, deliveryEnabled: true }));

      service.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : posts.module, modulePath : 'discussion/post',
        contextId  : 'thread-id/discussion-id/post-id', recordId   : 'post-id',
      }), 202);
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(fetchStub.callCount).toBe(2);
      const filters = processStub.getCalls().filter(call => call.args[1].descriptor.interface === DwnInterfaceName.Records)
        .map(call => call.args[1].descriptor.filter);
      expect(filters).toContainEqual({ module: threads.module, modulePath: 'thread/member', contextId: 'thread-id' });
      expect(filters).toContainEqual({ module: threads.module, modulePath: 'thread', contextId: 'thread-id', recordId: 'thread-id' });
    });

    it('should not trigger actor resolution for who: "anyone" rules', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      const tenant = 'did:test:alice';

      const moduleDef: ModuleDefinition = {
        module    : 'http://example.com/public',
        published : true,
        types     : { post: {} },
        structure : {
          post: {
            $delivery : 'direct',
            $actions  : [{ who: 'anyone', can: ['read'] }],
          },
        },
      };

      const processStub = sinon.stub();
      processStub.onFirstCall().resolves({
        status  : { code: 200 },
        entries : [{ descriptor: { definition: moduleDef } }],
      });

      const dwn = mockDwn(processStub);
      const resolver = fakeResolver({});
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingEnabled : false,
        deliveryEnabled   : true,
      }));

      svc.dispatchIfNeeded(tenant, moduleWriteMessage({
        module     : 'http://example.com/public',
        modulePath : 'post',
        recordId   : 'anyone-skip',
      }), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));

      // Only the ModulesQuery — no ancestor query, no delivery.
      expect(processStub.callCount).toBe(1);
      expect(fetchStub.callCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Deduplication cache eviction
  // -----------------------------------------------------------------------

  describe('deduplication cache', () => {
    it('should evict expired entries during dedup check', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(
        new Response(null, { status: 200 }),
      );

      const tenant = 'did:test:alice';
      const resolver = fakeResolver({
        [tenant]: didDocWithDwnService(tenant, [
          'http://self.example.com',
          'http://peer.example.com',
        ]),
      });

      const dwn = mockDwn();
      // Use a 0-second TTL so entries expire immediately.
      const svc = DeliveryService.create(dwn, resolver, testConfig({
        forwardingDeduplicationTtlSeconds: 0,
      }));

      svc.dispatchIfNeeded(tenant, recordsWriteMessage('evict-1'), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      const firstCount = fetchStub.callCount;
      expect(firstCount).toBe(1);

      // Wait a bit so the entry expires.
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 50));

      // Dispatch again — entry should be expired and not deduped.
      svc.dispatchIfNeeded(tenant, recordsWriteMessage('evict-1'), 202);
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 100));

      expect(fetchStub.callCount).toBeGreaterThan(firstCount);
    });
  });
});
