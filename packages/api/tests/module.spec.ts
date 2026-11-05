import type { BearerDid } from '@enbox/dids';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';

import { DwnApi } from '../src/dwn-api.js';
import emailModuleDefinition from './fixtures/module-definitions/email.json' with { type: 'json' };
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls = [testDwnUrl];

describe('Module', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : EnboxUserAgent,
      agentStores : 'memory'
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Create an "alice" Identity to author the DWN messages.
    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    // Instantiate DwnApi for both test identities.
    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
  });

  beforeEach(async () => {
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('toJSON()', () => {
    it('should return all defined properties', async () => {
      const moduleUri = `http://example.com/module/${TestDataGenerator.randomString(15)}`;
      const { status, module: aliceModule } = await dwnAlice.modules.configure({
        definition: {
          ...emailModuleDefinition,
          module: moduleUri
        }
      });
      expect(status.code).toBe(202);

      const moduleJson = aliceModule.toJSON();

      expect(moduleJson.descriptor).toBeDefined();
      expect(moduleJson.descriptor.interface).toBe('Modules');
      expect(moduleJson.descriptor.method).toBe('Configure');
      expect(moduleJson.descriptor.messageTimestamp).toBeDefined();
      expect(moduleJson.descriptor.definition).toEqual({
        ...emailModuleDefinition,
        module: moduleUri
      });
      expect(moduleJson.authorization).toBeDefined();
    });
  });
});
