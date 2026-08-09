import type { GenericMessage } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { SyncEvent } from '../src/types/sync.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import {
  isServiceConfigNoticeDelivery,
  publishServiceConfigNotice,
  ServiceConfigProtocolDefinition,
} from '../src/service-config.js';

const OWNER_DID = 'did:example:alice';

function createAgent(): {
  agent: EnboxPlatformAgent;
  processRequest: sinon.SinonStub;
  protocolMessage: GenericMessage;
  recordMessage: GenericMessage;
  sendDwnRequest: sinon.SinonStub;
  } {
  const protocolMessage = { descriptor: { interface: 'Protocols', method: 'Configure' } } as GenericMessage;
  const recordMessage = { descriptor: { interface: 'Records', method: 'Write' } } as GenericMessage;
  const processRequest = sinon.stub().callsFake(async (request: { messageType: DwnInterface }) => ({
    message : request.messageType === DwnInterface.ProtocolsConfigure ? protocolMessage : recordMessage,
    reply   : { status: { code: 202, detail: 'Accepted' } },
  }));
  const sendDwnRequest = sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } });
  const agent = {
    dwn : { processRequest },
    rpc : { sendDwnRequest },
  } as unknown as EnboxPlatformAgent;

  return { agent, processRequest, protocolMessage, recordMessage, sendDwnRequest };
}

describe('service-config notice', () => {
  afterEach(() => sinon.restore());

  it('writes each local notice as an append-only initial record', async () => {
    const { agent, processRequest } = createAgent();
    const params = { agent, currentEndpoints: [], formerEndpoints: [], ownerDid: OWNER_DID };

    await publishServiceConfigNotice(params);
    await publishServiceConfigNotice(params);

    const requests = processRequest.getCalls().map(call => call.args[0]);
    const writes = requests.filter(request => request.messageType === DwnInterface.RecordsWrite);
    expect(requests.map(request => request.messageType)).toEqual([
      DwnInterface.ProtocolsConfigure,
      DwnInterface.RecordsWrite,
      DwnInterface.ProtocolsConfigure,
      DwnInterface.RecordsWrite,
    ]);
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write.messageParams).not.toHaveProperty('recordId');
      expect(write.messageParams).not.toHaveProperty('dateCreated');
    }
  });

  it('configures the protocol before sending the record to every former and current endpoint', async () => {
    const {
      agent, protocolMessage, recordMessage, sendDwnRequest,
    } = createAgent();
    const formerEndpoints = ['https://old.example/dwn', 'https://shared.example/dwn'];
    const currentEndpoints = ['https://shared.example/dwn', 'https://new.example/dwn'];

    await publishServiceConfigNotice({ agent, currentEndpoints, formerEndpoints, ownerDid: OWNER_DID });

    expect(sendDwnRequest.callCount).toBe(6);
    for (const endpoint of [
      'https://old.example/dwn',
      'https://shared.example/dwn',
      'https://new.example/dwn',
    ]) {
      const calls = sendDwnRequest.getCalls().filter(call => call.args[0].dwnUrl === endpoint);
      expect(calls).toHaveLength(2);
      expect(calls[0].args[0].message).toBe(protocolMessage);
      expect(calls[0].args[0].data).toBeUndefined();
      expect(calls[1].args[0].message).toBe(recordMessage);
      expect(calls[1].args[0].data).toBeInstanceOf(Blob);
    }
  });

  it('matches only an owner-authored service-config record delivery for the requested tenant', () => {
    const event: Extract<SyncEvent, { type: 'delivery:applied' }> = {
      type           : 'delivery:applied',
      tenantDid      : OWNER_DID,
      remoteEndpoint : 'https://old.example/dwn',
      messageCid     : 'bafy-notice',
      descriptor     : {
        interface    : DwnInterfaceName.Records,
        method       : DwnMethodName.Write,
        protocol     : ServiceConfigProtocolDefinition.protocol,
        protocolPath : 'serviceConfig',
        author       : OWNER_DID,
      },
    };

    expect(isServiceConfigNoticeDelivery(event, OWNER_DID)).toBe(true);
    const mismatches: SyncEvent[] = [
      { ...event, tenantDid: 'did:example:bob' },
      { ...event, descriptor: { ...event.descriptor, author: 'did:example:bob' } },
      { ...event, descriptor: { ...event.descriptor, interface: DwnInterfaceName.Protocols } },
      { ...event, descriptor: { ...event.descriptor, method: DwnMethodName.Delete } },
      { ...event, descriptor: { ...event.descriptor, protocol: 'https://example.com/other' } },
      { ...event, descriptor: { ...event.descriptor, protocolPath: 'other' } },
      { type: 'identity:registration-change', tenantDid: OWNER_DID },
    ];
    for (const mismatch of mismatches) {
      expect(isServiceConfigNoticeDelivery(mismatch, OWNER_DID)).toBe(false);
    }
  });
});
