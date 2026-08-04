import type { BearerIdentity } from '../src/bearer-identity.js';
import type { PortableIdentity } from '../src/types/identity.js';

import { Convert } from '@enbox/common';
import { DidDht } from '@enbox/dids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { DidInterface } from '../src/did-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { EnboxUserAgent } from '../src/enbox-user-agent.js';
import freeForAllProtocolDefinition from './fixtures/protocol-definitions/free-for-all.json' with { type: 'json' };
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls: string[] = [testDwnUrl];

describe('EnboxUserAgent', () => {

  describe('agentDid', () => {
    it('throws an error if accessed before the Agent is initialized', async () => {
      // @ts-expect-error - Initializing with empty object to test error.
      const userAgent = new EnboxUserAgent({ didApi: {}, dwnApi: {}, identityApi: {}, keyManager: {}, permissionsApi: {}, syncApi: {} });
      try {
        userAgent.agentDid;
        throw new Error('Expected an error');
      } catch (error: any) {
        expect(error.message).toContain('"agentDid" property is not set');
      }
    });
  });

  describe('create()', () => {
    it('should create an instance with default parameters when none are provided', async () => {
      const userAgent = await EnboxUserAgent.create({ dataPath: '__TESTDATA__/USERAGENT' });

      expect(userAgent).toBeInstanceOf(EnboxUserAgent);
      expect(userAgent.crypto).toBeDefined();
      expect(userAgent.did).toBeDefined();
      expect(userAgent.dwn).toBeDefined();
      expect(userAgent.identity).toBeDefined();
      expect(userAgent.keyManager).toBeDefined();
      expect(userAgent.rpc).toBeDefined();
      expect(userAgent.sync).toBeDefined();
      expect(userAgent.vault).toBeDefined();
    });
  });

  const agentStoreTypes = ['dwn', 'memory'] as const;
  agentStoreTypes.forEach((agentStoreType) => {

    describe(`with ${agentStoreType} data stores`, () => {
      let testHarness: PlatformAgentTestHarness;

      beforeAll(async () => {
        testHarness = await PlatformAgentTestHarness.setup({
          agentClass  : EnboxUserAgent,
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

      describe('firstLaunch()', () => {
        it('returns true the first time the Identity Agent runs', async () => {
          const result = await testHarness.agent.firstLaunch();
          expect(result).toBe(true);
        });

        it('returns false after Identity Agent initialization', async () => {
          let result = await testHarness.agent.firstLaunch();
          expect(result).toBe(true);

          await testHarness.agent.initialize({ password: 'test' });

          result = await testHarness.agent.firstLaunch();
          expect(result).toBe(false);
        });
      });

      describe('test harness', () => {
        it('creates an unpublished agent and local identity', async () => {
          await testHarness.clearStorage();
          await testHarness.createAgentDid({ publish: false });

          const identity = await testHarness.createIdentity({ name: 'Local', publish: false });

          expect(testHarness.agent.agentDid.uri).toStartWith('did:dht:');
          expect(identity.did.uri).toStartWith('did:dht:');
          expect(identity.did.document.service).toBeUndefined();
        });
      });

      describe('initialize()', () => {
        it('generates and returns a 12-word mnenomic if one is not provided', async () => {
          // Initialize the vault.
          const generatedRecoveryPhrase = await testHarness.agent.initialize({
            password: 'dumbbell-krakatoa-ditty'
          });

          // Verify that the vault is initialized and is unlocked.
          expect(typeof generatedRecoveryPhrase).toBe('string');
          if (typeof generatedRecoveryPhrase !== 'string') {throw new Error('type guard');}
          expect(generatedRecoveryPhrase.split(' ')).toHaveLength(12);
        });

        it('accepts a recovery phrase', async () => {
          const predefinedRecoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

          // Initialize the vault with a recovery phrase.
          const returnedRecoveryPhrase = await testHarness.agent.initialize({
            password       : 'dumbbell-krakatoa-ditty',
            recoveryPhrase : predefinedRecoveryPhrase
          });

          // Verify that the vault is initialized and is unlocked.
          expect(returnedRecoveryPhrase).toBe(predefinedRecoveryPhrase);
        });
      });

      describe('processDidRequest()', () => {
        it('processes a DID Create request', async () => {
          const didCreateResponse = await testHarness.agent.processDidRequest({
            messageType   : DidInterface.Create,
            messageParams : { method: 'jwk' }
          });

          expect(didCreateResponse).toBeDefined();
          expect(didCreateResponse).toHaveProperty('ok', true);
          expect(didCreateResponse).toHaveProperty('status');
          expect(didCreateResponse.status).toHaveProperty('code', 201);
          expect(didCreateResponse.status).toHaveProperty('message', 'Created');
          expect(didCreateResponse).toHaveProperty('result');
          expect(didCreateResponse.result).toHaveProperty('uri');
          expect(didCreateResponse.result).toHaveProperty('document');
          expect(didCreateResponse.result).toHaveProperty('metadata');
        });

        it('processes a DID Resolve request', async () => {
          const didResolveResponse = await testHarness.agent.processDidRequest({
            messageType   : DidInterface.Resolve,
            messageParams : { didUri: testHarness.agent.agentDid.uri }
          });

          expect(didResolveResponse).toBeDefined();
          expect(didResolveResponse).toHaveProperty('ok', true);
          expect(didResolveResponse).toHaveProperty('status');
          expect(didResolveResponse.status).toHaveProperty('code', 200);
          expect(didResolveResponse.status).toHaveProperty('message', 'OK');
          expect(didResolveResponse).toHaveProperty('result');
          expect(didResolveResponse.result).toHaveProperty('didDocument');
          expect(didResolveResponse.result).toHaveProperty('didDocumentMetadata');
          expect(didResolveResponse.result).toHaveProperty('didResolutionMetadata');
        });
      });

      if (agentStoreType === 'dwn') {
        let alice: BearerIdentity;

        beforeEach(async () => {
          alice = await testHarness.agent.identity.create({
            metadata  : { name: 'Alice' },
            didMethod : 'jwk'
          });

          await testHarness.agent.processDwnRequest({
            author        : alice.did.uri,
            target        : alice.did.uri,
            messageType   : DwnInterface.ProtocolsConfigure,
            messageParams : { definition: freeForAllProtocolDefinition }
          });
        });

        describe('processDwnRequest()', () => {
          it('processes a Records Write request', async () => {
            // Create test data to write.
            const dataBytes = Convert.string('Hello, world!').toUint8Array();

            // Attempt to process the RecordsWrite
            const writeResponse = await testHarness.agent.processDwnRequest({
              author        : alice.did.uri,
              target        : alice.did.uri,
              messageType   : DwnInterface.RecordsWrite,
              messageParams : {
                dataFormat   : 'text/plain',
                protocol     : 'http://free-for-all.xyz',
                protocolPath : 'post'
              },
              dataStream: new Blob([dataBytes])
            });

            // Verify the response.
            expect(writeResponse).toHaveProperty('message');
            expect(writeResponse).toHaveProperty('messageCid');
            expect(writeResponse).toHaveProperty('reply');

            const writeMessage = writeResponse.message;
            expect(writeMessage).toHaveProperty('authorization');
            expect(writeMessage).toHaveProperty('descriptor');
            expect(writeMessage).toHaveProperty('recordId');

            const writeReply = writeResponse.reply;
            expect(writeReply).toHaveProperty('status');
            expect(writeReply.status.code).toBe(202);
          });
        });

        describe('sendDidRequest()', () => {
          it('throws an error', async () => {
            try {
              await testHarness.agent.sendDidRequest({
                messageType   : DidInterface.Create,
                messageParams : { method: 'jwk' }
              });
              throw new Error('Expected an error');
            } catch (error) {
              expect(error).toHaveProperty('message', 'Not implemented');
            }
          });
        });

        describe('sendDwnRequest()', () => {
          beforeEach(async () => {
            const testPortableIdentity: PortableIdentity = {
              portableDid: {
                uri      : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
                document : {
                  id                 : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
                  verificationMethod : [
                    {
                      id           : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#0',
                      type         : 'JsonWebKey',
                      controller   : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
                      publicKeyJwk : {
                        crv : 'Ed25519',
                        kty : 'OKP',
                        x   : 'mZXKvarfofrcrdTYzes2YneEsrbJFc1kE0O-d1cJPEw',
                        kid : 'EAlW6h08kqdLGEhR_o6hCnZpYpQ8QJavMp3g0BJ35IY',
                        alg : 'EdDSA',
                      },
                    },
                    {
                      id           : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#sig',
                      type         : 'JsonWebKey',
                      controller   : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
                      publicKeyJwk : {
                        crv : 'Ed25519',
                        kty : 'OKP',
                        x   : 'iIWijzQnfb_Jk4yRjISV6ci8EtyHn0fIxg0TVCh7wkE',
                        kid : '8QSlw4ct9taIgh23EUGLM0ELaukQ1VogIuBGrQ_UIsk',
                        alg : 'EdDSA',
                      },
                    },
                    {
                      id           : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#enc',
                      type         : 'JsonWebKey',
                      controller   : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
                      publicKeyJwk : {
                        kty : 'EC',
                        crv : 'secp256k1',
                        x   : 'P5FoqXk9W11i8FWyTpIvltAjV09FL9Q5o76wEHcxMtI',
                        y   : 'DgoLVlLKbjlaUja4RTjdxzqAy0ITOEFlCXGKSpu8XQs',
                        kid : 'hXXhIgfXRVIYqnKiX0DIL7ZGy0CBJrFQFIYxmRkAB-A',
                        alg : 'ES256K',
                      },
                    },
                  ],
                  authentication: [
                    'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#0',
                    'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#sig',
                  ],
                  assertionMethod: [
                    'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#0',
                    'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#sig',
                  ],
                  capabilityDelegation: [
                    'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#0',
                  ],
                  capabilityInvocation: [
                    'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#0',
                  ],
                  keyAgreement: [
                    'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#enc',
                  ],
                  service: [
                    {
                      id              : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#dwn',
                      type            : 'DecentralizedWebNode',
                      serviceEndpoint : testDwnUrls,
                    },
                  ],
                },
                metadata: {
                  published : true,
                  versionId : '1708160454',
                },
                privateKeys: [
                  {
                    crv : 'Ed25519',
                    d   : 'gXu7HmJgvZFWgNf_eqF-eDAFegd0OLe8elAIXXGMgoc',
                    kty : 'OKP',
                    x   : 'mZXKvarfofrcrdTYzes2YneEsrbJFc1kE0O-d1cJPEw',
                    kid : 'EAlW6h08kqdLGEhR_o6hCnZpYpQ8QJavMp3g0BJ35IY',
                    alg : 'EdDSA',
                  },
                  {
                    crv : 'Ed25519',
                    d   : 'SiUL1QDp6X2QnvJ1Q7hRlpo3ZhiVjRlvINocOzYPaBU',
                    kty : 'OKP',
                    x   : 'iIWijzQnfb_Jk4yRjISV6ci8EtyHn0fIxg0TVCh7wkE',
                    kid : '8QSlw4ct9taIgh23EUGLM0ELaukQ1VogIuBGrQ_UIsk',
                    alg : 'EdDSA',
                  },
                  {
                    kty : 'EC',
                    crv : 'secp256k1',
                    d   : 'b2gb-OfB5X4G3xd16u19MXNkamDP5lsT6bVsDN4aeuY',
                    x   : 'P5FoqXk9W11i8FWyTpIvltAjV09FL9Q5o76wEHcxMtI',
                    y   : 'DgoLVlLKbjlaUja4RTjdxzqAy0ITOEFlCXGKSpu8XQs',
                    kid : 'hXXhIgfXRVIYqnKiX0DIL7ZGy0CBJrFQFIYxmRkAB-A',
                    alg : 'ES256K',
                  },
                ],
              },
              metadata: {
                name   : 'Alice',
                tenant : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
                uri    : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy'
              }
            };

            alice = await testHarness.agent.identity.import({
              portableIdentity: testPortableIdentity
            });

            // Ensure the DID is published to the DHT. This step is necessary while the DHT Gateways
            // operated by TBD are regularly restarted and DIDs are no longer persisted.
            await DidDht.publish({ did: alice.did });

            await testHarness.agent.sendDwnRequest({
              author        : alice.did.uri,
              target        : alice.did.uri,
              messageType   : DwnInterface.ProtocolsConfigure,
              messageParams : { definition: freeForAllProtocolDefinition }
            });
          });

          it('resolves the remote protocol before sending a Records Write request', async () => {
            // Create test data to write.
            const dataBytes = Convert.string('Hello, world!').toUint8Array();

            // Attempt to process the RecordsWrite
            const writeResponse = await testHarness.agent.sendDwnRequest({
              author        : alice.did.uri,
              target        : alice.did.uri,
              messageType   : DwnInterface.RecordsWrite,
              messageParams : {
                dataFormat   : 'text/plain',
                protocol     : 'http://free-for-all.xyz',
                protocolPath : 'post'
              },
              dataStream: new Blob([dataBytes])
            });

            // Verify the response.
            expect(writeResponse).toHaveProperty('message');
            expect(writeResponse).toHaveProperty('messageCid');
            expect(writeResponse).toHaveProperty('reply');

            const writeMessage = writeResponse.message;
            expect(writeMessage).toHaveProperty('authorization');
            expect(writeMessage).toHaveProperty('descriptor');
            expect(writeMessage).toHaveProperty('recordId');

            const writeReply = writeResponse.reply;
            expect(writeReply).toHaveProperty('status');
            expect(writeReply.status.code).toBe(202);
          });
        });

        describe('subsequent launches', () => {
          it('can access stored identifiers after second launch', async () => {
            // First launch and initialization.
            await testHarness.agent.initialize({ password: 'test' });

            // Start the Agent, which will decrypt and load the Agent's DID from the vault.
            await testHarness.agent.start({ password: 'test' });

            // Create and persist a new Identity (with DID and Keys).
            const socialIdentity = await testHarness.agent.identity.create({
              metadata  : { name: 'Social' },
              didMethod : 'jwk'
            });

            // Simulate terminating and restarting an app.
            await testHarness.closeStorage();
            testHarness = await PlatformAgentTestHarness.setup({
              agentClass  : EnboxUserAgent,
              agentStores : 'dwn'
            });
            await testHarness.agent.start({ password: 'test' });

            // Try to get the identity and verify it exists.
            const storedIdentity = await testHarness.agent.identity.get({
              didUri: socialIdentity.did.uri,
            });

            expect(storedIdentity).toBeDefined();
            expect(storedIdentity!.did).toHaveProperty('uri', socialIdentity.did.uri);
          });
        });
      }
    });
  });

});
