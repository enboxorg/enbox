import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DidDht } from '@enbox/dids';
import { PlatformAgentTestHarness, Web5UserAgent } from '@enbox/agent';

import { DidApi } from '../src/did-api.js';

describe('DidApi', () => {
  let did: DidApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : Web5UserAgent,
      agentStores : 'memory'
    });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Create a new Identity to author DID requests.
    const identity = await testHarness.agent.identity.create({
      metadata  : { name: 'Test' },
      didMethod : 'jwk',
    });

    // Instantiate DidApi.
    did = new DidApi({ agent: testHarness.agent, connectedDid: identity.did.uri });
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('create()', () => {
    it('creates a DID and returns a response', async () => {
      const didCreateResponse = await did.create({ method: 'jwk' });

      expect(didCreateResponse).toBeDefined();
      expect(didCreateResponse).toHaveProperty('ok', true);
      expect(didCreateResponse).toHaveProperty('status');
      expect(didCreateResponse.status).toHaveProperty('code', 201);
      expect(didCreateResponse.status).toHaveProperty('message', 'Created');
      expect(didCreateResponse).toHaveProperty('did');
      expect(didCreateResponse.did).toHaveProperty('uri');
      expect(didCreateResponse.did).toHaveProperty('document');
      expect(didCreateResponse.did).toHaveProperty('metadata');
    });

    it('supports DHT method', async () => {
      const didCreateResponse = await did.create({ method: 'dht' });

      expect(didCreateResponse.did.uri).toContain('did:dht:');
    });

    it('supports JWK method', async () => {
      const didCreateResponse = await did.create({ method: 'jwk' });

      expect(didCreateResponse.did.uri).toContain('did:jwk:');
    });
  });

  describe('resolve()', () => {
    it('resolves a DID and returns a resolution result', async () => {

      // avoid actually resolving the DHT
      sinon.stub(DidDht, 'resolve').resolves({
        didDocument: {
          id                 : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
          '@context'         : 'https://w3id.org/did/v1',
          verificationMethod : [
          ],
          authentication: [
            'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#keys-1'
          ]
        },
        didDocumentMetadata   : {},
        didResolutionMetadata : {}
      });

      const testDid = 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy';

      const didResolutionResult = await did.resolve(testDid);

      expect(didResolutionResult).toBeDefined();
      expect(didResolutionResult).toHaveProperty('didDocument');
      expect(didResolutionResult.didDocument).toHaveProperty('id', testDid);
      expect(didResolutionResult).toHaveProperty('didDocument');
      expect(didResolutionResult).toHaveProperty('didDocumentMetadata');
      expect(didResolutionResult).toHaveProperty('didResolutionMetadata');
    });

    it('returns an invalidDid error if the DID cannot be parsed', async () => {
      const didResolutionResult = await did.resolve('unparseable:did');

      expect(didResolutionResult).toBeDefined();
      expect(didResolutionResult).toHaveProperty('@context');
      expect(didResolutionResult).toHaveProperty('didDocument');
      expect(didResolutionResult).toHaveProperty('didDocumentMetadata');
      expect(didResolutionResult).toHaveProperty('didResolutionMetadata');
      expect(didResolutionResult.didResolutionMetadata).toHaveProperty('error', 'invalidDid');
    });

    it('returns a methodNotSupported error if the DID method is not supported', async () => {
      const didResolutionResult = await did.resolve('did:unknown:abc123');

      expect(didResolutionResult).toBeDefined();
      expect(didResolutionResult).toHaveProperty('@context');
      expect(didResolutionResult).toHaveProperty('didDocument');
      expect(didResolutionResult).toHaveProperty('didDocumentMetadata');
      expect(didResolutionResult).toHaveProperty('didResolutionMetadata');
      expect(didResolutionResult.didResolutionMetadata).toHaveProperty('error', 'methodNotSupported');
    });
  });
});
