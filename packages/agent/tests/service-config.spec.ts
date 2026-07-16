import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

import { DataStream } from '@enbox/dwn-sdk-js';

import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import {
  DwnInterface,
  SERVICE_CONFIG_PROTOCOL_PATH,
  SERVICE_CONFIG_PROTOCOL_URI,
} from '../src/index.js';

describe('service-config announcement', () => {
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn',
    });
  });

  beforeEach(async () => {
    mock.restore();
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
  });

  afterAll(async () => {
    mock.restore();
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  /** Reads and JSON-decodes the single service-config record on the owner's DWN. */
  async function readServiceConfig(ownerDid: string): Promise<{ recordId: string; data: any } | undefined> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { protocol: SERVICE_CONFIG_PROTOCOL_URI, protocolPath: SERVICE_CONFIG_PROTOCOL_PATH } },
    });
    const entry = reply.entries?.[0];
    if (!entry) { return undefined; }

    const { reply: readReply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: entry.recordId } },
    });
    const bytes = readReply.entry?.data ? await DataStream.toBytes(readReply.entry.data) : new Uint8Array(0);
    return { recordId: entry.recordId, data: JSON.parse(new TextDecoder().decode(bytes)) };
  }

  describe('AgentDidApi.refreshResolution()', () => {
    it('evicts the cached resolution and re-resolves the DID document', async () => {
      const identity = await testHarness.agent.identity.create({ didMethod: 'jwk', metadata: { name: 'Owner' } });
      const ownerDid = identity.did.uri;

      const deleteSpy = sinon.spy((testHarness.agent.did as any).cache, 'delete');

      const result = await testHarness.agent.did.refreshResolution(ownerDid);

      expect(deleteSpy.calledOnceWith(ownerDid)).toBe(true);
      expect(result.didDocument?.id).toBe(ownerDid);
    });
  });

  describe('AgentIdentityApi.publishServiceConfig()', () => {
    it('installs the protocol and writes a readable record with the current endpoints', async () => {
      const identity = await testHarness.agent.identity.create({ didMethod: 'jwk', metadata: { name: 'Owner' } });
      const ownerDid = identity.did.uri;

      // did:jwk has no DWN service, so stub endpoint resolution to a known set
      // and short-circuit the best-effort remote fan-out.
      const endpoints = ['https://dwn.example/owner'];
      sinon.stub(testHarness.agent.dwn, 'getRemoteDwnEndpointUrls').resolves(endpoints);
      sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({ reply: { status: { code: 202, detail: 'Accepted' } } } as any);

      await testHarness.agent.identity.publishServiceConfig({ didUri: ownerDid });

      const record = await readServiceConfig(ownerDid);
      expect(record).toBeDefined();
      expect(record!.data.dwnEndpoints).toEqual(endpoints);
      expect(typeof record!.data.updatedAt).toBe('string');
    });

    it('updates the single record in place across repeated publishes', async () => {
      const identity = await testHarness.agent.identity.create({ didMethod: 'jwk', metadata: { name: 'Owner' } });
      const ownerDid = identity.did.uri;

      sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({ reply: { status: { code: 202, detail: 'Accepted' } } } as any);
      const endpointsStub = sinon.stub(testHarness.agent.dwn, 'getRemoteDwnEndpointUrls');

      endpointsStub.resolves(['https://dwn.example/a']);
      await testHarness.agent.identity.publishServiceConfig({ didUri: ownerDid });
      const first = await readServiceConfig(ownerDid);

      endpointsStub.resolves(['https://dwn.example/a', 'https://dwn.example/b']);
      await testHarness.agent.identity.publishServiceConfig({ didUri: ownerDid });

      // Query must still return exactly one record (updated, not duplicated).
      const { reply } = await testHarness.agent.dwn.processRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : { filter: { protocol: SERVICE_CONFIG_PROTOCOL_URI, protocolPath: SERVICE_CONFIG_PROTOCOL_PATH } },
      });
      expect(reply.entries?.length).toBe(1);

      const second = await readServiceConfig(ownerDid);
      expect(second!.recordId).toBe(first!.recordId);
      expect(second!.data.dwnEndpoints).toEqual(['https://dwn.example/a', 'https://dwn.example/b']);
    });
  });

  describe('AgentIdentityApi.setDwnEndpoints({ announce: false })', () => {
    it('does not publish a service-config record when announce is false', async () => {
      const identity = await testHarness.agent.identity.create({
        didMethod  : 'jwk',
        metadata   : { name: 'Owner' },
        didOptions : { verificationMethods: [{ algorithm: 'Ed25519' }] },
      });
      const ownerDid = identity.did.uri;

      const publishSpy = sinon.spy(testHarness.agent.identity, 'publishServiceConfig');

      await testHarness.agent.identity.setDwnEndpoints({
        didUri    : ownerDid,
        endpoints : ['https://dwn.example/new'],
        announce  : false,
      });

      expect(publishSpy.called).toBe(false);
      expect(await readServiceConfig(ownerDid)).toBeUndefined();
    });
  });
});
