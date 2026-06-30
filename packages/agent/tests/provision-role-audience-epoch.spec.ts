import type { PrivateKeyJwk } from '@enbox/crypto';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { EncryptionProtocol, Protocols } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls = [testDwnUrl];
const PROTOCOL_URI = 'https://example.org/protocols/eager-audience-test';

/**
 * Minimal protocol with a top-level `$role` type (`admin`) that can read an
 * encrypted sibling (`note`). `$keyAgreement` is injected at install, making
 * `admin` an encrypted audience eligible for role-audience provisioning.
 */
function definition(): ProtocolDefinition {
  return {
    published : true,
    protocol  : PROTOCOL_URI,
    types     : {
      admin : { dataFormats: ['application/json'] },
      note  : { dataFormats: ['application/json'], encryptionRequired: true },
    },
    structure: {
      admin : { $role: true, $actions: [{ who: 'anyone', can: ['read'] }] },
      note  : { $actions: [{ role: 'admin', can: ['read'] }] },
    },
  };
}

describe('AgentDwnApi.provisionRoleAudienceEpoch', () => {
  let testHarness: PlatformAgentTestHarness;
  let ownerDid: string;

  async function countAudienceEpochs(): Promise<number> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: { protocol: EncryptionProtocol.uri, protocolPath: EncryptionProtocol.audienceEpochPath },
      },
    });
    return reply.entries?.length ?? 0;
  }

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({ agentClass: TestAgent, agentStores: 'memory' });
    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const owner = await testHarness.createIdentity({ name: 'Owner', testDwnUrls });
    ownerDid = owner.did.uri;

    const { portableDid } = await testHarness.agent.identity.export({ didUri: ownerDid });
    const rootPrivateJwk = (portableDid.privateKeys ?? []).find((key): boolean => key.crv === 'X25519') as PrivateKeyJwk;
    const deriver = await testHarness.agent.dwn.getEncryptionKeyDeriver(ownerDid);
    const injected = await Protocols.deriveAndInjectPublicEncryptionKeys(definition(), deriver.rootKeyId, rootPrivateJwk);

    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: injected },
    });
    expect(reply.status.code).toBe(202);
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  it('mints an epoch and writes the audienceEpoch record for an encrypted role', async () => {
    const result = await testHarness.agent.dwn.provisionRoleAudienceEpoch({
      ownerDid,
      protocol  : PROTOCOL_URI,
      role      : 'admin',
      contextId : '',
    });

    expect(result.created).toBe(true);
    expect(result.epoch).toBe(1);
    expect(result.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await countAudienceEpochs()).toBe(1);
  });

  it('is idempotent — reuses the existing epoch and writes no new record', async () => {
    const first = await testHarness.agent.dwn.provisionRoleAudienceEpoch({
      ownerDid, protocol: PROTOCOL_URI, role: 'admin', contextId: '',
    });
    const again = await testHarness.agent.dwn.provisionRoleAudienceEpoch({
      ownerDid, protocol: PROTOCOL_URI, role: 'admin', contextId: '',
    });

    expect(again.created).toBe(false);
    expect(again.epoch).toBe(first.epoch);
    expect(again.keyId).toBe(first.keyId);
    expect(await countAudienceEpochs()).toBe(1);
  });

  it('throws when the role is not an encrypted audience', async () => {
    await expect(
      testHarness.agent.dwn.provisionRoleAudienceEpoch({
        ownerDid, protocol: PROTOCOL_URI, role: 'note', contextId: '',
      }),
    ).rejects.toThrow('not an encrypted audience');
  });
});
