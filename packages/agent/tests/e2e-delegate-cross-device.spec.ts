/**
 * e2e: cross-device encrypted delegate grants
 *
 * Cross-device delegates receive protocol/path-scoped decryption keys in the
 * connect response. Legacy contextKey records are not produced.
 */

import type { BearerIdentity } from '../src/bearer-identity.js';
import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, KeyDerivationScheme } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { EnboxConnectProtocol } from '../src/enbox-connect-protocol.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

const chatProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/e2e-cross-device-chat',
  types     : {
    thread: {
      schema             : 'https://schemas.xyz/thread',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    participant: {
      schema      : 'https://schemas.xyz/participant',
      dataFormats : ['application/json'],
    },
    chat: {
      schema             : 'https://schemas.xyz/chat',
      dataFormats        : ['text/plain'],
      encryptionRequired : true,
    },
  },
  structure: {
    thread: {
      participant : { $role: true },
      chat        : {},
    },
  },
};

describe('e2e: cross-device encrypted delegate grants', () => {
  let ownerHarness: PlatformAgentTestHarness;
  let ownerIdentity: BearerIdentity;

  beforeAll(async () => {
    ownerHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-cross-device-owner',
    });
  });

  afterAll(async () => {
    await ownerHarness.clearStorage();
    await ownerHarness.closeStorage();
  });

  beforeEach(async () => {
    await ownerHarness.clearStorage();
    await ownerHarness.createAgentDid();
    ownerHarness.agent.dwn.clearDelegateDecryptionKeys();

    ownerIdentity = await ownerHarness.createIdentity({
      name        : 'OwnerAlice',
      testDwnUrls : [testDwnUrl],
    });
  });

  it('should derive protocolPath keys without producing legacy contextKey records', async () => {
    await ownerHarness.agent.processDwnRequest({
      author        : ownerIdentity.did.uri,
      target        : ownerIdentity.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });

    const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
      ownerHarness.agent,
      ownerIdentity.did.uri,
      chatProtocol.protocol,
      [{
        interface    : DwnInterfaceName.Records,
        method       : DwnMethodName.Read,
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread/chat',
      }],
      chatProtocol,
    );

    expect(keys).toHaveLength(1);
    expect(keys[0].derivedPrivateKey.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);

    const { message: threadMessage } = await ownerHarness.agent.processDwnRequest({
      author        : ownerIdentity.did.uri,
      target        : ownerIdentity.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        schema       : 'https://schemas.xyz/thread',
        dataFormat   : 'application/json',
        data         : new TextEncoder().encode(JSON.stringify({ topic: 'No context key' })),
      },
      encryption: true,
    });
    const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;

    const { reply } = await ownerHarness.agent.processDwnRequest({
      author        : ownerIdentity.did.uri,
      target        : ownerIdentity.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : 'https://identity.foundation/protocols/key-delivery',
          protocolPath : 'contextKey',
        },
      },
    });

    const matchingKeys = (reply.entries ?? []).filter(
      (entry: any) => entry.descriptor?.tags?.contextId === threadContextId,
    );
    expect(matchingKeys).toHaveLength(0);
  });
});
