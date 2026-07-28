import type { BearerDid } from '@enbox/dids';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { Message } from '@enbox/dwn-sdk-js';
import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { DwnInterface, EnboxUserAgent } from '@enbox/agent';

import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { Enbox } from '../src/enbox.js';
import { ProtocolReadinessError } from '../src/protocol-readiness.js';
import { recordCodecs } from '../src/record-codec.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls = [testDwnUrl];

describe('protocol readiness integration', () => {
  let aliceDid: BearerDid;
  let bobDid: BearerDid;
  let hostedDid: BearerDid;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/protocol-readiness',
    });
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
    [aliceDid, bobDid, hostedDid] = (await Promise.all([
      testHarness.createIdentity({ name: 'Alice', testDwnUrls }),
      testHarness.createIdentity({ name: 'Bob', testDwnUrls }),
      testHarness.createIdentity({ name: 'Hosted', testDwnUrls }),
    ])).map((identity) => identity.did);
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  it('publishes one exact artifact to every endpoint, is idempotent, and enables remote writes', async () => {
    const protocol = createNotesProtocol();
    const application = defineApplicationManifest({ protocols: [protocol] });
    const enbox = new Enbox({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    const bobDwn = new DwnApi({ agent: testHarness.agent, connectedDid: bobDid.uri });
    const endpointResolution = sinon.stub(testHarness.agent.dwn, 'getRemoteDwnEndpointUrls')
      .withArgs(aliceDid.uri)
      .resolves([testDwnUrl, testDwnUrl]);
    const rpcSpy = sinon.spy(testHarness.agent.rpc, 'sendDwnRequest');

    await enbox.protocols.ensureReady({ application, publication: 'required' });

    const firstConfigureCalls = remoteConfigureCalls(rpcSpy);
    expect(endpointResolution.calledOnceWith(aliceDid.uri)).toBe(true);
    expect(firstConfigureCalls).toHaveLength(2);
    const publishedCids = await Promise.all(firstConfigureCalls.map(
      async (call) => Message.getCid(call.args[0].message),
    ));
    expect(new Set(publishedCids).size).toBe(1);

    const local = await enbox.dwn.protocols.query({ filter: { protocol: protocol.definition.protocol } });
    expect(local.protocols).toHaveLength(1);
    expect(await Message.getCid(local.protocols[0].toJSON())).toBe(publishedCids[0]);

    await enbox.protocols.ensureReady({ application, publication: 'required' });
    expect(remoteConfigureCalls(rpcSpy)).toHaveLength(2);

    const { record, status } = await bobDwn.records.write({
      data         : 'hello from bob',
      dataFormat   : 'text/plain',
      from         : aliceDid.uri,
      protocol     : protocol.definition.protocol,
      protocolPath : 'note',
      schema       : protocol.definition.types.note.schema,
    });
    expect(status.code).toBe(202);
    expect(record).toBeDefined();

    const read = await enbox.dwn.records.read({
      from   : aliceDid.uri,
      filter : { recordId: record!.id },
    });
    expect(read.status.code).toBe(200);
    expect(await read.record!.data.text()).toBe('hello from bob');
  });

  it('surfaces a non-converging publication as a typed readiness failure', async () => {
    const protocol = createNotesProtocol();
    const application = defineApplicationManifest({ protocols: [protocol] });
    const enbox = new Enbox({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    const send = testHarness.agent.rpc.sendDwnRequest.bind(testHarness.agent.rpc);
    sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake(async (request) => {
      if (request.message.descriptor.interface === 'Protocols'
        && request.message.descriptor.method === 'Configure') {
        return { status: { code: 503, detail: 'publication unavailable' } };
      }
      return send(request);
    });

    let failure: unknown;
    try {
      await enbox.protocols.ensureReady({ application, publication: 'required' });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ProtocolReadinessError);
    expect(failure).toMatchObject({
      endpointFailures: [{
        endpoint : testDwnUrl,
        status   : { code: 503, detail: 'publication unavailable' },
      }],
      protocol : protocol.definition.protocol,
      recovery : 'retry',
      stage    : 'remote-verify',
      status   : { code: 503, detail: 'publication unavailable' },
    });
    expect((failure as Error).message).toContain('publication unavailable');
  });

  it('fails closed when one reachable endpoint returns another identity\'s signed artifact', async () => {
    const protocol = createNotesProtocol();
    const application = defineApplicationManifest({ protocols: [protocol] });
    const enbox = new Enbox({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    const { message: attackerMessage } = await testHarness.agent.processDwnRequest({
      author        : bobDid.uri,
      messageParams : { definition: protocol.definition },
      messageType   : DwnInterface.ProtocolsConfigure,
      store         : false,
      target        : bobDid.uri,
    });
    sinon.stub(testHarness.agent.dwn, 'getRemoteDwnEndpointUrls')
      .withArgs(aliceDid.uri)
      .resolves([testDwnUrl, testDwnUrl]);
    const send = testHarness.agent.rpc.sendDwnRequest.bind(testHarness.agent.rpc);
    let intercepted = false;
    sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake(async (request) => {
      if (!intercepted
        && request.message.descriptor.interface === 'Protocols'
        && request.message.descriptor.method === 'Query') {
        intercepted = true;
        return {
          entries : [attackerMessage!],
          status  : { code: 200, detail: 'OK' },
        };
      }
      return send(request);
    });

    await expect(enbox.protocols.ensureReady({
      application,
      publication: 'required',
    })).rejects.toMatchObject({
      protocol : protocol.definition.protocol,
      stage    : 'remote-query',
    });

    const local = await enbox.dwn.protocols.query({ filter: { protocol: protocol.definition.protocol } });
    expect(local.protocols).toHaveLength(0);
  });

  it('prepares an explicitly targeted identity controlled by the same agent', async () => {
    const protocol = createNotesProtocol();
    const application = defineApplicationManifest({ protocols: [protocol] });
    const enbox = new Enbox({ agent: testHarness.agent, connectedDid: aliceDid.uri });

    await enbox.protocols.ensureReady({
      application,
      publication : 'required',
      targetDid   : hostedDid.uri,
    });

    const hostedDwn = new DwnApi({ agent: testHarness.agent, connectedDid: hostedDid.uri });
    const remote = await hostedDwn.protocols.query({
      from   : hostedDid.uri,
      filter : { protocol: protocol.definition.protocol },
    });
    expect(remote.status.code).toBe(200);
    expect(remote.protocols).toHaveLength(1);
    expect(enbox.using(protocol).isConfigured).toBe(false);
  });
});

function createNotesProtocol(): ReturnType<typeof defineProtocol> {
  const protocolUri = `http://protocol-readiness.example/${TestDataGenerator.randomString(15)}`;
  const definition = {
    protocol  : protocolUri,
    published : true,
    types     : {
      note: {
        schema      : `${protocolUri}/schemas/note`,
        dataFormats : ['text/plain'],
      },
    },
    structure: {
      note: {
        $actions: [{ who: 'anyone', can: ['create'] }],
      },
    },
  } as const satisfies ProtocolDefinition;

  return defineProtocol(definition, { note: recordCodecs.text() });
}

function remoteConfigureCalls(spy: sinon.SinonSpy): sinon.SinonSpyCall[] {
  return spy.getCalls().filter(({ args }) => args[0].message.descriptor.interface === 'Protocols'
    && args[0].message.descriptor.method === 'Configure');
}
