import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { Web5UserAgent } from '../src/web5-user-agent.js';

describe('Managing Identities', () => {

  const agentStoreTypes = ['dwn', 'memory'] as const;
  agentStoreTypes.forEach((agentStoreType) => {

    describe(`with ${agentStoreType} data stores`, () => {
      let testHarness: PlatformAgentTestHarness;

      beforeAll(async () => {
        testHarness = await PlatformAgentTestHarness.setup({
          agentClass  : Web5UserAgent,
          agentStores : agentStoreType
        });
      });

      beforeEach(async () => {
        await testHarness.clearStorage();
        await testHarness.createAgentDid();
      });

      afterAll(async () => {
        await testHarness.clearStorage();
        await testHarness.closeStorage();
      });

      describe('initial identity creation', () => {
        it('can create three identities', async () => {
          // First launch and initialization.
          await testHarness.agent.initialize({ password: 'test' });

          // Start the Agent, which will decrypt and load the Agent's DID from the vault.
          await testHarness.agent.start({ password: 'test' });

          // Create three identities, each of which is stored in a new tenant.
          const careerIdentity = await testHarness.agent.identity.create({
            metadata  : { name: 'Social' },
            didMethod : 'jwk'
          });

          const familyIdentity = await testHarness.agent.identity.create({
            metadata  : { name: 'Social' },
            didMethod : 'jwk'
          });

          const socialIdentity = await testHarness.agent.identity.create({
            metadata  : { name: 'Social' },
            didMethod : 'jwk'
          });

          // Verify the Identities were stored in each new Identity's tenant.
          const storedCareerIdentity = await testHarness.agent.identity.get({ didUri: careerIdentity.did.uri });
          const storedFamilyIdentity = await testHarness.agent.identity.get({ didUri: familyIdentity.did.uri });
          const storedSocialIdentity = await testHarness.agent.identity.get({ didUri: socialIdentity.did.uri });
          expect(storedCareerIdentity!.did).toHaveProperty('uri', careerIdentity.did.uri);
          expect(storedFamilyIdentity!.did).toHaveProperty('uri', familyIdentity.did.uri);
          expect(storedSocialIdentity!.did).toHaveProperty('uri', socialIdentity.did.uri);
        }, 30000);
      });
    });
  });
});
