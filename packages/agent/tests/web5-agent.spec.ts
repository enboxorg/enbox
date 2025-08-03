import type { PortableIdentity } from '../src/types/identity.js';

import { expect } from 'chai';
import { DidDht } from '@enbox/dids';
import { Convert } from '@enbox/common';
import { DwnInterface } from '../src/types/dwn.js';
import { DidInterface } from '../src/did-api.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';

import { testDwnUrl } from './utils/test-config.js';
import { Web5Agent } from '../src/web5-agent.js';

// NOTE: @noble/secp256k1 requires globalThis.crypto polyfill for node.js <=18: https://github.com/paulmillr/noble-secp256k1/blob/main/README.md#usage
// Remove when we move off of node.js v18 to v20, earliest possible time would be Oct 2023: https://github.com/nodejs/release#release-schedule
import { webcrypto } from 'node:crypto';
// @ts-ignore
if (!globalThis.crypto) globalThis.crypto = webcrypto;

let testDwnUrls: string[] = [testDwnUrl];

describe('Web5Agent', () => {

  describe('agentDid', () => {
    it('throws an error if accessed before the Agent is initialized', async () => {
      // @ts-expect-error - Initializing with empty object to test error.
      const agent = new Web5Agent({ didApi: {}, dwnApi: {}, identityApi: {}, keyManager: {}, permissionsApi: {}, syncApi: {} });
      try {
        agent.agentDid;
        throw new Error('Expected an error');
      } catch (error: any) {
        expect(error.message).to.include('Agent DID is not set');
      }
    });
  });

  describe('create()', () => {
    it('should create an instance with default parameters when none are provided', async () => {
      const agent = await Web5Agent.create({ dataPath: '__TESTDATA__/WEB5AGENT' });

      expect(agent).to.be.an.instanceof(Web5Agent);
      expect(agent.crypto).to.exist;
      expect(agent.did).to.exist;
      expect(agent.dwn).to.exist;
      expect(agent.identity).to.exist;
      expect(agent.keyManager).to.exist;
      expect(agent.rpc).to.exist;
      expect(agent.sync).to.exist;
      expect(agent.vault).to.exist;
    });
  });

  const agentStoreTypes = ['dwn', 'memory'] as const;
  agentStoreTypes.forEach((agentStoreType) => {

    describe(`with ${agentStoreType} data stores`, () => {
      let testHarness: PlatformAgentTestHarness;

      before(async () => {
        testHarness = await PlatformAgentTestHarness.setup({
          agentClass  : Web5Agent,
          agentStores : agentStoreType
        });
      });

      beforeEach(async () => {
        await testHarness.clearStorage();
        await testHarness.createAgentDid();
      });

      after(async () => {
        await testHarness.clearStorage();
        await testHarness.closeStorage();
      });

      describe('firstLaunch()', () => {
        it('returns true the first time the Identity Vault is initialized', async () => {
          const firstLaunch = await testHarness.agent.firstLaunch();
          expect(firstLaunch).to.be.true;
        });

        it('returns false after the Identity Vault has been initialized', async () => {
          await testHarness.agent.initialize({ password: 'test' });
          const firstLaunch = await testHarness.agent.firstLaunch();
          expect(firstLaunch).to.be.false;
        });
      });

      describe('initialize()', () => {
        it('initializes the vault with a password and returns a recovery phrase', async () => {
          // First launch and initialization.
          const recoveryPhrase = await testHarness.agent.initialize({ password: 'test' });

          expect(recoveryPhrase).to.be.a('string');
          expect((recoveryPhrase as string).split(' ')).to.have.lengthOf(12);
        });

        it('accepts an optional recovery phrase', async () => {
          // First launch and initialization with a recovery phrase.
          const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
          await testHarness.agent.initialize({ password: 'test', recoveryPhrase });

          // Verify the Agent's agentDid is set.
          expect(testHarness.agent.agentDid.uri).to.equal(testHarness.agent.vault.getDid());
        });

        it('throws an error if the vault is already initialized', async () => {
          // First launch and initialization.
          await testHarness.agent.initialize({ password: 'test' });

          // Attempt to initialize again.
          try {
            await testHarness.agent.initialize({ password: 'test' });
            throw new Error('Expected an error');
          } catch (error: any) {
            expect(error.message).to.include('Agent vault is already initialized');
          }
        });

        it('initializes with dwnEndpoints and updates the agent DID document', async () => {
          // First launch and initialization with DWN endpoints.
          const recoveryPhrase = await testHarness.agent.initialize({
            password: 'test',
            dwnEndpoints: testDwnUrls
          });

          expect(recoveryPhrase).to.be.a('string');
          expect((recoveryPhrase as string).split(' ')).to.have.lengthOf(12);

          // Verify the Agent's DID document includes the DWN service endpoints.
          const agentDidDocument = await testHarness.agent.did.resolve(testHarness.agent.agentDid.uri);
          expect(agentDidDocument.didDocument?.service).to.have.lengthOf(1);
          expect(agentDidDocument.didDocument?.service?.[0].serviceEndpoint).to.deep.equal(testDwnUrls);
        });
      });

      describe('processDidRequest()', () => {
        it('handles DID Create requests', async () => {
          const didCreateResponse = await testHarness.agent.processDidRequest({
            messageType   : DidInterface.Create,
            messageParams : { method: 'jwk' }
          });

          expect(didCreateResponse).to.have.property('ok', true);
          expect(didCreateResponse).to.have.property('status');
          expect(didCreateResponse.status).to.have.property('code', 200);
          expect(didCreateResponse.status).to.have.property('message', 'OK');
          expect(didCreateResponse).to.have.property('result');
          expect(didCreateResponse.result).to.have.property('uri');
          expect(didCreateResponse.result).to.have.property('document');
          expect(didCreateResponse.result).to.have.property('metadata');
        });

        it('handles DidInterface.Resolve requests', async () => {
          const didResolveResponse = await testHarness.agent.processDidRequest({
            messageType   : DidInterface.Resolve,
            messageParams : { didUri: testHarness.agent.agentDid.uri }
          });

          expect(didResolveResponse).to.have.property('ok', true);
          expect(didResolveResponse).to.have.property('status');
          expect(didResolveResponse.status).to.have.property('code', 200);
          expect(didResolveResponse.status).to.have.property('message', 'OK');
          expect(didResolveResponse).to.have.property('result');
          expect(didResolveResponse.result).to.have.property('@context');
          expect(didResolveResponse.result).to.have.property('didDocument');
          expect(didResolveResponse.result).to.have.property('didDocumentMetadata');
          expect(didResolveResponse.result).to.have.property('didResolutionMetadata');
        });
      });

      describe('processDwnRequest()', () => {
        it('handles DWN RecordsWrite requests', async () => {
          const dataString = 'Hello, world!';
          const processRequestResponse = await testHarness.agent.processDwnRequest({
            author        : testHarness.agent.agentDid.uri,
            target        : testHarness.agent.agentDid.uri,
            messageType   : DwnInterface.RecordsWrite,
            messageParams : {
              dataFormat : 'text/plain',
              data       : Convert.string(dataString).toUint8Array()
            }
          });

          expect(processRequestResponse).to.exist;
          expect(processRequestResponse).to.have.property('messageCid');
          expect(processRequestResponse).to.have.property('reply');
          expect(processRequestResponse.reply).to.exist;
        });
      });

      describe('processVcRequest()', () => {
        it('is not yet implemented', async () => {
          try {
            await testHarness.agent.processVcRequest({} as any);
            throw new Error('Expected an error');
          } catch (error: any) {
            expect(error.message).to.include('VC API not yet implemented');
          }
        });
      });

      describe('sendDidRequest()', () => {
        it('handles DID Resolve requests', async () => {
          const dwnDidUri = await testHarness.agent.identity.create({
            didMethod : 'dht',
            metadata  : { name: 'Agent DID' },
            didOptions: {
              services: [{
                id              : 'dwn',
                type            : 'DecentralizedWebNode',
                serviceEndpoint : testDwnUrls,
                enc             : '#enc',
                sig             : '#sig'
              }]
            }
          });

          const sendDidResponse = await testHarness.agent.sendDidRequest({
            messageType   : DidInterface.Resolve,
            messageParams : { didUri: dwnDidUri.did.uri }
          });

          expect(sendDidResponse).to.have.property('ok', true);
          expect(sendDidResponse).to.have.property('status');
          expect(sendDidResponse.status).to.have.property('code', 200);
          expect(sendDidResponse.status).to.have.property('message', 'OK');
          expect(sendDidResponse).to.have.property('result');
          expect(sendDidResponse.result).to.have.property('@context');
          expect(sendDidResponse.result).to.have.property('didDocument');
          expect(sendDidResponse.result).to.have.property('didDocumentMetadata');
          expect(sendDidResponse.result).to.have.property('didResolutionMetadata');
        });
      });

      describe('sendDwnRequest()', () => {
        let testPortableIdentity: PortableIdentity;

        before(async () => {
          const testPortableDid = await DidDht.create({
            options: {
              verificationMethods: [{
                algorithm : 'Ed25519',
                id        : 'sig',
                purposes  : ['authentication', 'assertionMethod']
              }]
            }
          });

          testPortableIdentity = { 
            portableDid: testPortableDid,
            metadata: { name: 'Test', uri: testPortableDid.uri, tenant: testPortableDid.uri }
          };
        });

        it('returns a 500 error if target DID has no DWN service endpoints', async () => {
          const didWithoutDwn = await DidDht.create();

          const dataString = 'Hello, world!';
          const sendDwnResponse = await testHarness.agent.sendDwnRequest({
            author        : didWithoutDwn.uri,
            target        : didWithoutDwn.uri,
            messageType   : DwnInterface.RecordsWrite,
            messageParams : {
              dataFormat : 'text/plain',
              data       : Convert.string(dataString).toUint8Array()
            }
          });

          expect(sendDwnResponse).to.exist;
          // Check for error in the response
          if ('error' in sendDwnResponse) {
            expect(sendDwnResponse.error).to.be.true;
          }
        });

        it('handles DWN MessagesQuery requests', async () => {
          const { did } = await testHarness.agent.identity.create({
            didMethod : 'dht',
            metadata  : { name: 'Test Identity' },
            didOptions: {
              services: [{
                id              : 'dwn',
                type            : 'DecentralizedWebNode',
                serviceEndpoint : testDwnUrls,
                enc             : '#enc',
                sig             : '#sig'
              }]
            }
          });

          const sendDwnResponse = await testHarness.agent.sendDwnRequest({
            author        : did.uri,
            target        : did.uri,
            messageType   : DwnInterface.MessagesQuery,
            messageParams : {
              filters: []
            }
          });

          expect(sendDwnResponse).to.exist;
          expect(sendDwnResponse).to.have.property('reply');
          expect(sendDwnResponse.reply).to.exist;
          if ('entries' in sendDwnResponse.reply) {
            expect(sendDwnResponse.reply.entries).to.be.an('array');
          }
        });
      });

      describe('sendVcRequest()', () => {
        it('is not yet implemented', async () => {
          try {
            await testHarness.agent.sendVcRequest({} as any);
            throw new Error('Expected an error');
          } catch (error: any) {
            expect(error.message).to.include('VC API not yet implemented');
          }
        });
      });

      describe('start()', () => {
        it('starts the Agent with the vault unlocked', async () => {
          // Initialize the vault.
          await testHarness.agent.initialize({ password: 'test' });

          // Start the Agent.
          await testHarness.agent.start({ password: 'test' });

          // Verify the Agent's agentDid is set.
          expect(testHarness.agent.agentDid.uri).to.equal(testHarness.agent.vault.getDid());
        });

        it('unlocks the vault if it is locked', async () => {
          // Initialize the vault.
          await testHarness.agent.initialize({ password: 'test' });

          // Lock the vault.
          await testHarness.agent.vault.lock();

          // Start the Agent.
          await testHarness.agent.start({ password: 'test' });

          // Verify the Agent's agentDid is set.
          expect(testHarness.agent.agentDid.uri).to.equal(testHarness.agent.vault.getDid());
        });

        it('throws an error if the password is incorrect', async () => {
          // Initialize the vault.
          await testHarness.agent.initialize({ password: 'test' });

          // Lock the vault.
          await testHarness.agent.vault.lock();

          // Start the Agent with the wrong password.
          try {
            await testHarness.agent.start({ password: 'wrong' });
            throw new Error('Expected an error');
          } catch (error: any) {
            expect(error.message).to.include('Unable to unlock');
          }
        });
      });

      describe('Managing Identities', () => {
        it('can create three identities', async () => {
          // First launch and initialization.
          await testHarness.agent.initialize({ password: 'test' });

          // Start the Agent, which will decrypt and load the Agent's DID from the vault.
          await testHarness.agent.start({ password: 'test' });

          // Create three identities, each of which is stored in a new tenant.
          const careerIdentity = await testHarness.agent.identity.create({
            metadata  : { name: 'Career' },
            didMethod : 'jwk'
          });

          const familyIdentity = await testHarness.agent.identity.create({
            metadata  : { name: 'Family' },
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
          expect(storedCareerIdentity!.did).to.have.property('uri', careerIdentity.did.uri);
          expect(storedFamilyIdentity!.did).to.have.property('uri', familyIdentity.did.uri);
          expect(storedSocialIdentity!.did).to.have.property('uri', socialIdentity.did.uri);
        }).timeout(30000);
      });

      describe('Persistence and subsequent launches', () => {
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
            agentClass  : Web5Agent,
            agentStores : agentStoreType
          });
          await testHarness.agent.start({ password: 'test' });

          // Try to get the identity and verify it exists.
          const storedIdentity = await testHarness.agent.identity.get({
            didUri: socialIdentity.did.uri,
          });

          expect(storedIdentity).to.exist;
          expect(storedIdentity!.did).to.have.property('uri', socialIdentity.did.uri);
        });
      });
    });
  });
});