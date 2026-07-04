import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';

import { VcApi } from '../src/vc-api.js';

describe('VcApi', () => {
  let vc: VcApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : EnboxUserAgent,
      agentStores : 'memory'
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Create a new Identity to author VC requests.
    const identity = await testHarness.agent.identity.create({
      metadata  : { name: 'Test' },
      didMethod : 'jwk',
    });

    // Instantiate VcApi.
    vc = new VcApi({ agent: testHarness.agent, connectedDid: identity.did.uri });
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('create()', () => {
    it('is not implemented', async () => {
      try {
        await vc.create();
        throw new Error('Expected method to throw, but it did not.');
      } catch (e: any) {
        expect(e.message).toContain('Not implemented.');
      }
    });
  });
});
