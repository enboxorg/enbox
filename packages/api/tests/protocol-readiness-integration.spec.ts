import type { BearerDid } from '@enbox/dids';
import type { DwnMessage } from '@enbox/agent';
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
type ProtocolConfigureMessage = DwnMessage[DwnInterface.ProtocolsConfigure];

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

  function simulateProtocolEndpoints(options: {
    afterConfigure?: (result: { dwnUrl: string; message: ProtocolConfigureMessage }) => Promise<void> | void;
    afterQuery?: (result: { dwnUrl: string; entry?: ProtocolConfigureMessage }) => Promise<void> | void;
    endpointSets: readonly (readonly string[])[];
    state: Map<string, ProtocolConfigureMessage>;
  }): {
    endpointResolution: sinon.SinonStub;
    sendDwnRequest: sinon.SinonStub;
  } {
    const endpointResolution = sinon.stub(testHarness.agent.dwn, 'getRemoteDwnEndpointUrls');
    for (const [index, endpoints] of options.endpointSets.entries()) {
      endpointResolution.onCall(index).resolves([...endpoints]);
    }

    const sendDwnRequest = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake(async (request) => {
      if (request.message.descriptor.interface !== 'Protocols') {
        throw new Error(`Unexpected remote interface '${request.message.descriptor.interface}'.`);
      }
      if (request.message.descriptor.method === 'Configure') {
        const message = request.message as ProtocolConfigureMessage;
        options.state.set(request.dwnUrl, message);
        await options.afterConfigure?.({ dwnUrl: request.dwnUrl, message });
        return { status: { code: 202, detail: 'Accepted' } };
      }
      if (request.message.descriptor.method === 'Query') {
        const entry = options.state.get(request.dwnUrl);
        await options.afterQuery?.({ dwnUrl: request.dwnUrl, entry });
        return {
          entries : entry === undefined ? [] : [entry],
          status  : { code: 200, detail: 'OK' },
        };
      }
      throw new Error(`Unexpected remote method '${request.message.descriptor.method}'.`);
    });

    return { endpointResolution, sendDwnRequest };
  }

  it('publishes one exact artifact, is idempotent, and enables remote writes', async () => {
    const protocol = createNotesProtocol();
    const application = defineApplicationManifest({ protocols: [protocol] });
    const enbox = new Enbox({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    const bobDwn = new DwnApi({ agent: testHarness.agent, connectedDid: bobDid.uri });
    const endpointResolution = sinon.stub(testHarness.agent.dwn, 'getRemoteDwnEndpointUrls')
      .withArgs(aliceDid.uri)
      .resolves([testDwnUrl]);
    const rpcSpy = sinon.spy(testHarness.agent.rpc, 'sendDwnRequest');

    await enbox.protocols.ensureReady({ application, publication: 'required' });

    const firstConfigureCalls = remoteConfigureCalls(rpcSpy);
    expect(endpointResolution.calledOnceWith(aliceDid.uri)).toBe(true);
    expect(firstConfigureCalls).toHaveLength(1);
    const publishedCid = await Message.getCid(firstConfigureCalls[0].args[0].message);

    const local = await enbox.dwn.protocols.query({ filter: { protocol: protocol.definition.protocol } });
    expect(local.protocols).toHaveLength(1);
    expect(await Message.getCid(local.protocols[0].toJSON())).toBe(publishedCid);
    expect(enbox.using(protocol).isConfigured).toBe(true);

    await enbox.protocols.ensureReady({ application, publication: 'required' });
    expect(remoteConfigureCalls(rpcSpy)).toHaveLength(1);

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

  it('fails local verification when the local artifact changes after remote verification', async () => {
    const protocol = createNotesProtocol();
    const application = defineApplicationManifest({ protocols: [protocol] });
    const enbox = new Enbox({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    const endpoint = 'https://dwn-race.example/';
    const endpointState = new Map<string, ProtocolConfigureMessage>();
    const process = testHarness.agent.processDwnRequest.bind(testHarness.agent);
    let remotePostconditionObserved = false;
    let mutationStatus: number | undefined;
    sinon.stub(testHarness.agent, 'processDwnRequest').callsFake(async (request) => {
      if (remotePostconditionObserved
        && mutationStatus === undefined
        && request.messageType === DwnInterface.ProtocolsQuery) {
        const mutation = await process({
          author        : aliceDid.uri,
          messageParams : {
            definition       : protocol.definition,
            messageTimestamp : '2099-01-01T00:00:00.000000Z',
          },
          messageType : DwnInterface.ProtocolsConfigure,
          target      : aliceDid.uri,
        });
        mutationStatus = mutation.reply.status.code;
      }
      return process(request);
    });
    simulateProtocolEndpoints({
      endpointSets : [[endpoint]],
      state        : endpointState,
      afterQuery   : ({ entry }) => {
        remotePostconditionObserved ||= entry !== undefined;
      },
    });

    await expect(enbox.protocols.ensureReady({
      application,
      publication: 'required',
    })).rejects.toMatchObject({
      protocol  : protocol.definition.protocol,
      stage     : 'local-verify',
      targetDid : aliceDid.uri,
    });

    expect(mutationStatus).toBe(202);
    expect(enbox.using(protocol).isConfigured).toBe(false);
    const local = await enbox.dwn.protocols.query({ filter: { protocol: protocol.definition.protocol } });
    const remoteMessage = endpointState.get(endpoint);
    expect(local.protocols).toHaveLength(1);
    expect(remoteMessage).toBeDefined();
    expect(await Message.getCid(local.protocols[0].toJSON()))
      .not.toBe(await Message.getCid(remoteMessage!));
  });

  it('publishes the existing exact local artifact only to a newly discovered stale endpoint', async () => {
    const protocol = createNotesProtocol();
    const application = defineApplicationManifest({ protocols: [protocol] });
    const enbox = new Enbox({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    const currentEndpoint = 'https://dwn-current.example/';
    const newEndpoint = 'https://dwn-new.example/';
    const endpointState = new Map<string, ProtocolConfigureMessage>();
    const staleConfigure = await testHarness.agent.processDwnRequest({
      author        : aliceDid.uri,
      messageParams : {
        definition       : protocol.definition,
        messageTimestamp : '2000-01-01T00:00:00.000000Z',
      },
      messageType : DwnInterface.ProtocolsConfigure,
      store       : false,
      target      : aliceDid.uri,
    });
    expect(staleConfigure.message).toBeDefined();
    const staleMessage = staleConfigure.message as ProtocolConfigureMessage;
    const processDwnRequest = sinon.spy(testHarness.agent, 'processDwnRequest');
    const { endpointResolution, sendDwnRequest } = simulateProtocolEndpoints({
      endpointSets : [[currentEndpoint], [currentEndpoint, newEndpoint]],
      state        : endpointState,
    });

    await enbox.protocols.ensureReady({ application, publication: 'required' });

    const localAfterFirstRun = await enbox.dwn.protocols.query({
      filter: { protocol: protocol.definition.protocol },
    });
    expect(localAfterFirstRun.protocols).toHaveLength(1);
    const localMessage = localAfterFirstRun.protocols[0].toJSON();
    const localCid = await Message.getCid(localMessage);
    expect(await Message.isNewer(localMessage, staleMessage)).toBe(true);
    endpointState.set(newEndpoint, staleMessage);
    expect(enbox.using(protocol).isConfigured).toBe(true);
    expect(remoteConfigureCalls(sendDwnRequest).map((call) => call.args[0].dwnUrl))
      .toEqual([currentEndpoint]);
    expect(processDwnRequest.getCalls().filter(
      (call) => call.args[0].messageType === DwnInterface.ProtocolsConfigure,
    )).toHaveLength(1);

    await enbox.protocols.ensureReady({ application, publication: 'required' });

    const configureCalls = remoteConfigureCalls(sendDwnRequest);
    expect(endpointResolution.callCount).toBe(2);
    expect(configureCalls.map((call) => call.args[0].dwnUrl))
      .toEqual([currentEndpoint, newEndpoint]);
    expect(await Message.getCid(configureCalls[1].args[0].message)).toBe(localCid);
    expect(processDwnRequest.getCalls().filter(
      (call) => call.args[0].messageType === DwnInterface.ProtocolsConfigure,
    )).toHaveLength(1);
    expect(await Message.getCid(endpointState.get(currentEndpoint)!)).toBe(localCid);
    expect(await Message.getCid(endpointState.get(newEndpoint)!)).toBe(localCid);
  });

  it('rechecks current endpoints after publishing to a missing endpoint', async () => {
    const protocol = createNotesProtocol();
    const application = defineApplicationManifest({ protocols: [protocol] });
    const enbox = new Enbox({ agent: testHarness.agent, connectedDid: aliceDid.uri });
    const currentEndpoint = 'https://dwn-current.example/';
    const missingEndpoint = 'https://dwn-missing.example/';
    const endpointState = new Map<string, ProtocolConfigureMessage>();
    const concurrentConfigure = await testHarness.agent.processDwnRequest({
      author        : aliceDid.uri,
      messageParams : {
        definition       : protocol.definition,
        messageTimestamp : '2099-01-01T00:00:00.000000Z',
      },
      messageType : DwnInterface.ProtocolsConfigure,
      store       : false,
      target      : aliceDid.uri,
    });
    expect(concurrentConfigure.message).toBeDefined();
    const concurrentMessage = concurrentConfigure.message as ProtocolConfigureMessage;
    const { sendDwnRequest } = simulateProtocolEndpoints({
      afterConfigure: ({ dwnUrl }) => {
        if (dwnUrl === missingEndpoint) {
          endpointState.set(currentEndpoint, concurrentMessage);
        }
      },
      endpointSets : [[currentEndpoint], [currentEndpoint, missingEndpoint]],
      state        : endpointState,
    });

    await enbox.protocols.ensureReady({ application, publication: 'required' });

    await expect(enbox.protocols.ensureReady({
      application,
      publication: 'required',
    })).rejects.toMatchObject({
      endpointFailures : [{ endpoint: currentEndpoint }],
      protocol         : protocol.definition.protocol,
      stage            : 'remote-verify',
    });
    expect(remoteConfigureCalls(sendDwnRequest).map((call) => call.args[0].dwnUrl))
      .toEqual([currentEndpoint, missingEndpoint]);
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
      .resolves([testDwnUrl]);
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
