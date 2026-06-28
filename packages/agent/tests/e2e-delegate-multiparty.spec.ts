/**
 * e2e: delegate + encrypted role protocol
 *
 * Encrypted delegate grants use ProtocolPath-derived decryption keys.
 */

import type { BearerIdentity } from '../src/bearer-identity.js';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, KeyDerivationScheme } from '@enbox/dwn-sdk-js';

import { EnboxConnectProtocol } from '../src/enbox-connect-protocol.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

const chatProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/e2e-delegate-multiparty-chat',
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

describe('e2e: delegate + encrypted role protocol', () => {
  let walletHarness: PlatformAgentTestHarness;
  let walletIdentity: BearerIdentity;

  beforeAll(async () => {
    walletHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-delegate-multiparty-wallet',
    });
  });

  afterAll(async () => {
    await walletHarness.clearStorage();
    await walletHarness.closeStorage();
  });

  beforeEach(async () => {
    await walletHarness.clearStorage();
    await walletHarness.createAgentDid();
    walletHarness.agent.dwn.clearDelegateDecryptionKeys();

    walletIdentity = await walletHarness.createIdentity({
      name        : 'Alice',
      testDwnUrls : [testDwnUrl],
    });
  });

  it('should derive a protocol-wide decryption key for a protocol-wide read grant', async () => {
    const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
      walletHarness.agent,
      walletIdentity.did.uri,
      chatProtocol.protocol,
      [{
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Read,
        protocol  : chatProtocol.protocol,
      }],
      chatProtocol,
    );

    expect(keys).toHaveLength(1);
    expect(keys[0].scope.kind).toBe('protocol');
    expect(keys[0].derivedPrivateKey.derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    expect(keys[0].derivedPrivateKey.derivationPath).toEqual([
      KeyDerivationScheme.ProtocolPath,
      chatProtocol.protocol,
    ]);
  });

  it('should derive an exact path decryption key for a protocolPath read grant', async () => {
    const keys = await EnboxConnectProtocol.deriveScopedDecryptionKeys(
      walletHarness.agent,
      walletIdentity.did.uri,
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
    expect(keys[0].scope).toEqual({ kind: 'protocolPath', protocolPath: 'thread/chat', match: 'exact' });
    expect(keys[0].derivedPrivateKey.derivationPath).toEqual([
      KeyDerivationScheme.ProtocolPath,
      chatProtocol.protocol,
      'thread',
      'chat',
    ]);
  });

});
