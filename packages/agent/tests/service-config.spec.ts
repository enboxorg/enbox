import type { GenericMessage } from '@enbox/dwn-sdk-js';
import type { ServiceConfig } from '../src/service-config.js';

import { DataStream } from '@enbox/dwn-sdk-js';
import { DwnEndpointResolutionErrorCode } from '@enbox/dids';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import sinon from 'sinon';
import { TestAgent } from './utils/test-agent.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
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

  async function createOwner(endpoints: string[]): Promise<string> {
    const identity = await testHarness.agent.identity.create({
      didMethod  : 'dht',
      metadata   : { name: 'Service configuration owner' },
      didOptions : {
        publish  : false,
        services : [{
          id              : 'dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : endpoints,
        }],
      },
    });
    return identity.did.uri;
  }

  async function readServiceConfig(ownerDid: string): Promise<{
    recordId: string;
    data: ServiceConfig;
  } | undefined> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : SERVICE_CONFIG_PROTOCOL_URI,
          protocolPath : SERVICE_CONFIG_PROTOCOL_PATH,
        },
      },
    });
    const entry = reply.entries?.[0];
    if (entry === undefined) {
      return undefined;
    }

    const { reply: readReply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: entry.recordId } },
    });
    const bytes = readReply.entry?.data === undefined
      ? new Uint8Array(0)
      : await DataStream.toBytes(readReply.entry.data);
    return {
      recordId : entry.recordId,
      data     : JSON.parse(new TextDecoder().decode(bytes)) as ServiceConfig,
    };
  }

  it('writes the advertised endpoints and configures each former and current DWN before fan-out', async () => {
    const ownerDid = await createOwner(['https://current.example/dwn/']);
    const sendDwnRequest = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({
      status: { code: 202, detail: 'Accepted' },
    });

    await testHarness.agent.identity.publishServiceConfig({
      didUri            : ownerDid,
      deliveryEndpoints : ['https://former.example/dwn/'],
    });

    const record = await readServiceConfig(ownerDid);
    expect(record?.data.dwnEndpoints).toEqual(['https://current.example/dwn']);
    expect(typeof record?.data.updatedAt).toBe('string');

    for (const endpoint of ['https://former.example/dwn', 'https://current.example/dwn']) {
      const endpointCalls = sendDwnRequest.getCalls()
        .filter((call) => call.args[0].dwnUrl === endpoint);
      expect(endpointCalls).toHaveLength(2);
      expect((endpointCalls[0].args[0].message as GenericMessage).descriptor).toMatchObject({
        interface : 'Protocols',
        method    : 'Configure',
      });
      expect((endpointCalls[1].args[0].message as GenericMessage).descriptor).toMatchObject({
        interface : 'Records',
        method    : 'Write',
      });
    }
  });

  it('publishes each prompt as an independent initial write for empty destination DWNs', async () => {
    const ownerDid = await createOwner(['https://current.example/dwn']);
    sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({
      status: { code: 202, detail: 'Accepted' },
    });

    await testHarness.agent.identity.publishServiceConfig({ didUri: ownerDid });
    const first = await readServiceConfig(ownerDid);
    await testHarness.agent.identity.publishServiceConfig({ didUri: ownerDid });

    expect(first).toBeDefined();
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : SERVICE_CONFIG_PROTOCOL_URI,
          protocolPath : SERVICE_CONFIG_PROTOCOL_PATH,
        },
      },
    });
    expect(reply.entries).toHaveLength(2);
    expect(new Set(reply.entries?.map((entry) => entry.recordId)).size).toBe(2);
  });

  it('does not replace a missing DID service with a default endpoint', async () => {
    const identity = await testHarness.agent.identity.create({
      didMethod : 'jwk',
      metadata  : { name: 'Local-only identity' },
    });
    const processRequest = sinon.spy(testHarness.agent.dwn, 'processRequest');

    await expect(testHarness.agent.identity.publishServiceConfig({ didUri: identity.did.uri }))
      .rejects.toMatchObject({ code: DwnEndpointResolutionErrorCode.ServiceMissing });
    expect(processRequest.notCalled).toBe(true);
  });
});
