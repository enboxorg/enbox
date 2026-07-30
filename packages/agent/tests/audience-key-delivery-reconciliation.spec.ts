import type { GenericMessage, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';

import sinon from 'sinon';
import { describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { scanActiveAudienceKeyDeliveryIntents } from '../src/audience-key-delivery-reconciliation.js';

const protocol = 'https://example.com/reconciliation';
const rolePath = 'thread/participant';
const protocolDefinition = {
  protocol,
  published : true,
  types     : {
    participant : { dataFormats: ['application/json'] },
    thread      : { dataFormats: ['application/json'] },
  },
  structure: {
    thread: {
      participant: {
        $keyAgreement: {
          publicKeyJwk: { crv: 'X25519', kty: 'OKP', x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        },
        $role: true,
      },
    },
  },
} satisfies ProtocolDefinition;

describe('audience-key delivery reconciliation', () => {
  it('replays a role deletion received on a later feed page', async () => {
    const roleRecordId = 'role-record';
    const processRequest = sinon.stub();
    processRequest.onFirstCall().resolves({
      reply: {
        cursor  : { epoch: 'epoch', position: '1', streamId: 'stream' },
        drained : false,
        entries : [{
          isLatestBaseState : true,
          message           : roleWrite(roleRecordId),
          messageCid        : 'write-cid',
          seq               : '1',
        }],
        status: { code: 200 },
      },
    });
    processRequest.onSecondCall().resolves({
      reply: {
        drained : true,
        entries : [{
          isLatestBaseState : true,
          message           : roleDelete(roleRecordId),
          messageCid        : 'delete-cid',
          seq               : '2',
        }],
        status: { code: 200 },
      },
    });
    const agent = { dwn: { processRequest }, permissions: {} } as unknown as EnboxPlatformAgent;

    expect(await scanActiveAudienceKeyDeliveryIntents({
      agent,
      protocolDefinition,
      sourceDid: 'did:example:alice',
    })).toEqual([]);
    expect(processRequest.callCount).toBe(2);
    for (const call of processRequest.getCalls()) {
      expect(call.args[0].messageParams.filters).toEqual([{
        interface          : DwnInterfaceName.Records,
        protocol,
        protocolPathPrefix : rolePath,
      }]);
    }
  });
});

function roleWrite(recordId: string): GenericMessage {
  return {
    contextId  : 'thread-context/role-context',
    descriptor : {
      interface    : DwnInterfaceName.Records,
      method       : DwnMethodName.Write,
      protocol,
      protocolPath : rolePath,
      recipient    : 'did:example:bob',
    },
    recordId,
  } as unknown as GenericMessage;
}

function roleDelete(recordId: string): GenericMessage {
  return {
    descriptor: {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Delete,
      recordId,
    },
  } as unknown as GenericMessage;
}
