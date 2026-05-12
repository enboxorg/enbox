import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { AuthManager } from '@enbox/auth/auth-manager';
import {
  DwnInterface,
  EnboxUserAgent,
  PlatformAgentTestHarness,
} from '@enbox/agent';

import { defineProtocol } from '../src/define-protocol.js';
import { Enbox } from '../src/enbox.js';
import { TypedEnbox } from '../src/typed-enbox.js';

describe('Enbox API', () => {
  let consoleWarn: typeof console.warn;

  beforeAll(() => {
    // Suppress console.warn output due to default password warnings
    consoleWarn = console.warn;
    console.warn = (): void => {};
  });

  afterAll(() => {
    // Restore console.warn output
    console.warn = consoleWarn;
  });

  describe('using Test Harness', () => {
    let testHarness: PlatformAgentTestHarness;

    beforeAll(async () => {
      testHarness = await PlatformAgentTestHarness.setup({
        agentClass  : EnboxUserAgent,
        agentStores : 'memory',
      });
    });

    beforeEach(async () => {
      sinon.restore();
      await testHarness.clearStorage();
      await testHarness.createAgentDid();
    });

    afterAll(async () => {
      sinon.restore();
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    describe('constructor', () => {
      it('should instantiate Enbox API with provided agent and connectedDid', async () => {
        // Create a new Identity.
        const socialIdentity = await testHarness.agent.identity.create({
          metadata  : { name: 'Social' },
          didMethod : 'jwk',
        });

        // Instantiates Enbox instance with test agent and new Identity's DID.
        const enbox = new Enbox({
          agent        : testHarness.agent,
          connectedDid : socialIdentity.did.uri,
        });
        expect(enbox).toBeDefined();
        expect(enbox).toHaveProperty('did');
        expect(enbox).toHaveProperty('vc');
        expect(enbox).toHaveProperty('using');
      });

      it('should support a single agent with multiple Enbox instances and different DIDs', async () => {
        // Create two identities, each of which is stored in a new tenant.
        const careerIdentity = await testHarness.agent.identity.create({
          metadata  : { name: 'Career' },
          didMethod : 'jwk',
        });
        const socialIdentity = await testHarness.agent.identity.create({
          metadata  : { name: 'Social' },
          didMethod : 'jwk',
        });

        // Instantiate an Enbox instance with the "Career" Identity.
        const enboxCareer = new Enbox({
          agent        : testHarness.agent,
          connectedDid : careerIdentity.did.uri,
        });
        expect(enboxCareer).toBeDefined();

        // Instantiate an Enbox instance with the "Social" Identity.
        const enboxSocial = new Enbox({
          agent        : testHarness.agent,
          connectedDid : socialIdentity.did.uri,
        });
        expect(enboxSocial).toBeDefined();
      });
    });

    describe('using()', () => {
      const TestProtocolDef = {
        protocol  : 'https://example.com/protocols/test',
        published : true,
        types     : {
          item: {
            schema      : 'https://example.com/schemas/item',
            dataFormats : ['application/json'],
          },
        },
        structure: {
          item: {},
        },
      } as const satisfies ProtocolDefinition;

      type TestSchemaMap = { item: { name: string } };

      const TestProtocol = defineProtocol(TestProtocolDef, {} as TestSchemaMap);

      it('should return the same TypedEnbox instance for repeated calls with the same protocol', async () => {
        const identity = await testHarness.agent.identity.create({
          metadata  : { name: 'CacheTest' },
          didMethod : 'jwk',
        });

        const enbox = new Enbox({
          agent        : testHarness.agent,
          connectedDid : identity.did.uri,
        });

        const first = enbox.using(TestProtocol);
        const second = enbox.using(TestProtocol);

        expect(first).toBeInstanceOf(TypedEnbox);
        expect(first).toBe(second); // same reference
      });

      it('should return different TypedEnbox instances for different protocols', async () => {
        const OtherProtocolDef = {
          protocol  : 'https://example.com/protocols/other',
          published : true,
          types     : {
            thing: {
              schema      : 'https://example.com/schemas/thing',
              dataFormats : ['application/json'],
            },
          },
          structure: { thing: {} },
        } as const satisfies ProtocolDefinition;

        type OtherSchemaMap = { thing: { value: number } };
        const OtherProtocol = defineProtocol(OtherProtocolDef, {} as OtherSchemaMap);

        const identity = await testHarness.agent.identity.create({
          metadata  : { name: 'CacheTest2' },
          didMethod : 'jwk',
        });

        const enbox = new Enbox({
          agent        : testHarness.agent,
          connectedDid : identity.did.uri,
        });

        const test = enbox.using(TestProtocol);
        const other = enbox.using(OtherProtocol);

        expect(test).not.toBe(other);
        expect(test.protocol).toBe('https://example.com/protocols/test');
        expect(other.protocol).toBe('https://example.com/protocols/other');
      });

      it('should cache per Enbox instance, not globally', async () => {
        const identity1 = await testHarness.agent.identity.create({
          metadata  : { name: 'User1' },
          didMethod : 'jwk',
        });
        const identity2 = await testHarness.agent.identity.create({
          metadata  : { name: 'User2' },
          didMethod : 'jwk',
        });

        const enboxA = new Enbox({
          agent        : testHarness.agent,
          connectedDid : identity1.did.uri,
        });
        const enboxB = new Enbox({
          agent        : testHarness.agent,
          connectedDid : identity2.did.uri,
        });

        const fromA = enboxA.using(TestProtocol);
        const fromB = enboxB.using(TestProtocol);

        // Different Enbox instances must NOT share cached TypedEnbox instances.
        expect(fromA).not.toBe(fromB);
      });
    });

    describe('disconnect()', () => {
      it('should stop sync and clear cached TypedEnbox instances', async () => {
        const identity = await testHarness.agent.identity.create({
          metadata  : { name: 'Disconnect' },
          didMethod : 'jwk',
        });

        const enbox = new Enbox({
          agent        : testHarness.agent,
          connectedDid : identity.did.uri,
        });

        const TestProtocolDef = {
          protocol  : 'https://example.com/protocols/disconnect-test',
          published : true,
          types     : { item: {} },
          structure : { item: {} },
        } as const satisfies ProtocolDefinition;

        const TestProtocol = defineProtocol(TestProtocolDef, {} as { item: unknown });

        // Cache a TypedEnbox instance.
        const before = enbox.using(TestProtocol);
        expect(before).toBeDefined();

        // Disconnect clears the cache.
        await enbox.disconnect();

        // After disconnect, calling using() returns a new instance.
        const after = enbox.using(TestProtocol);
        expect(after).not.toBe(before);
      });
    });

    describe('scenarios', () => {
      it('should write records with multiple identities under management', async () => {
        // First launch and initialization.
        await testHarness.agent.initialize({ password: 'test' });

        // Start the Agent, which will decrypt and load the Agent's DID from the vault.
        await testHarness.agent.start({ password: 'test' });

        // Create two identities, each of which is stored in a new tenant.
        const careerIdentity = await testHarness.agent.identity.create({
          metadata  : { name: 'Career' },
          didMethod : 'jwk',
        });
        const socialIdentity = await testHarness.agent.identity.create({
          metadata  : { name: 'Social' },
          didMethod : 'jwk',
        });

        // Install free-for-all protocol for both identities.
        const freeForAllDefinition = {
          protocol  : 'http://free-for-all.xyz',
          published : true,
          types     : { post: {} },
          structure : { post: {} },
        };
        for (const identity of [careerIdentity, socialIdentity]) {
          await testHarness.agent.dwn.processRequest({
            author        : identity.did.uri,
            target        : identity.did.uri,
            messageType   : DwnInterface.ProtocolsConfigure,
            messageParams : { definition: freeForAllDefinition },
          });
        }

        // Instantiate an Enbox instance with the "Career" Identity, write a record, and verify the result.
        const enboxCareer = new Enbox({
          agent        : testHarness.agent,
          connectedDid : careerIdentity.did.uri,
        });
        const careerResult = await (enboxCareer as any)._dwn.records.write({
          data         : 'Hello, world!',
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          schema       : 'foo/bar',
          dataFormat   : 'text/plain',
        });
        expect(careerResult.status.code).toBe(202);
        expect(careerResult.record).toBeDefined();
        expect(careerResult.record.author).toBe(careerIdentity.did.uri);
        expect(await careerResult.record.data.text()).toBe(
          'Hello, world!'
        );

        // Instantiate an Enbox instance with the "Social" Identity, write a record, and verify the result.
        const enboxSocial = new Enbox({
          agent        : testHarness.agent,
          connectedDid : socialIdentity.did.uri,
        });
        const socialResult = await (enboxSocial as any)._dwn.records.write({
          data         : 'Hello, everyone!',
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          schema       : 'foo/bar',
          dataFormat   : 'text/plain',
        });
        expect(socialResult.status.code).toBe(202);
        expect(socialResult.record).toBeDefined();
        expect(socialResult.record.author).toBe(socialIdentity.did.uri);
        expect(await socialResult.record.data.text()).toBe(
          'Hello, everyone!'
        );
      });
    });
  });

  describe('connect()', () => {
    let testHarness: PlatformAgentTestHarness;

    beforeAll(async () => {
      testHarness = await PlatformAgentTestHarness.setup({
        agentClass  : EnboxUserAgent,
        agentStores : 'memory',
      });
    });

    beforeEach(async () => {
      sinon.restore();
      await testHarness.clearStorage();
      await testHarness.createAgentDid();
    });

    afterAll(async () => {
      sinon.restore();
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    it('should create an Enbox instance from raw params', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Raw' },
        didMethod : 'jwk',
      });

      const enbox = Enbox.connect({
        agent        : testHarness.agent,
        connectedDid : identity.did.uri,
      });

      expect(enbox).toBeInstanceOf(Enbox);
      expect(enbox.agent).toBe(testHarness.agent);
    });

    it('should create an Enbox instance with from()', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Raw' },
        didMethod : 'jwk',
      });

      const enbox = Enbox.from({
        agent        : testHarness.agent,
        connectedDid : identity.did.uri,
      });

      expect(enbox).toBeInstanceOf(Enbox);
      expect(enbox.agent).toBe(testHarness.agent);
    });

    it('should create an Enbox instance from raw params with a delegateDid', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Delegate' },
        didMethod : 'jwk',
      });

      const delegateIdentity = await testHarness.agent.identity.create({
        metadata  : { name: 'Delegate DID' },
        didMethod : 'jwk',
      });

      const enbox = Enbox.connect({
        agent        : testHarness.agent,
        connectedDid : identity.did.uri,
        delegateDid  : delegateIdentity.did.uri,
      });

      expect(enbox).toBeInstanceOf(Enbox);
      expect(enbox.agent).toBe(testHarness.agent);
    });

    it('should create an Enbox instance from an AuthSession', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Session' },
        didMethod : 'jwk',
      });

      // Create a mock AuthSession — duck-typed object with agent, did, delegateDid.
      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'Session' },
      };

      const enbox = Enbox.connect({ session: session as any });

      expect(enbox).toBeInstanceOf(Enbox);
      expect(enbox.agent).toBe(testHarness.agent);
    });

    it('should create an Enbox instance from an AuthSession with delegateDid', async () => {
      const connectedIdentity = await testHarness.agent.identity.create({
        metadata  : { name: 'Connected' },
        didMethod : 'jwk',
      });

      const delegateIdentity = await testHarness.agent.identity.create({
        metadata  : { name: 'Delegate' },
        didMethod : 'jwk',
      });

      const session = {
        agent       : testHarness.agent,
        did         : connectedIdentity.did.uri,
        delegateDid : delegateIdentity.did.uri,
        identity    : { didUri: connectedIdentity.did.uri, name: 'Connected' },
      };

      const enbox = Enbox.connect({ session: session as any });

      expect(enbox).toBeInstanceOf(Enbox);
      expect(enbox.agent).toBe(testHarness.agent);
    });

    it('should create an Enbox instance from direct session params', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Direct Session' },
        didMethod : 'jwk',
      });

      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
      };

      const enbox = Enbox.connect(session);

      expect(enbox).toBeInstanceOf(Enbox);
      expect(enbox.agent).toBe(testHarness.agent);
    });

    it('should create an Enbox instance with fromSession()', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Session' },
        didMethod : 'jwk',
      });

      const enbox = Enbox.fromSession({
        agent : testHarness.agent,
        did   : identity.did.uri,
      });

      expect(enbox).toBeInstanceOf(Enbox);
      expect(enbox.agent).toBe(testHarness.agent);
    });

    it('should create a high-level connection through AuthManager', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'High Level' },
        didMethod : 'jwk',
      });

      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'High Level' },
      };
      const connect = sinon.stub().resolves(session);
      const auth = { connect };
      const create = sinon.stub(AuthManager, 'create').resolves(auth as any);

      const result = await Enbox.connect({
        password       : 'test-password',
        createIdentity : true,
        sync           : 'off',
      });

      expect(result.enbox).toBeInstanceOf(Enbox);
      expect(result.session).toBe(session);
      expect(result.auth).toBe(auth);
      expect(create.firstCall.args[0]).toEqual({
        password : 'test-password',
        sync     : 'off',
      });
      expect(connect.firstCall.args[0]).toEqual({
        password       : 'test-password',
        sync           : 'off',
        createIdentity : true,
      });
    });

    it('should pass explicit connect options to AuthManager.connect', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Explicit Connect' },
        didMethod : 'jwk',
      });

      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'Explicit Connect' },
      };
      const connect = sinon.stub().resolves(session);
      const auth = { connect };
      const create = sinon.stub(AuthManager, 'create').resolves(auth as any);

      await Enbox.connect({
        password : 'manager-password',
        connect  : {
          password       : 'connect-password',
          createIdentity : true,
        },
      });

      expect(create.firstCall.args[0]).toEqual({ password: 'manager-password' });
      expect(connect.firstCall.args[0]).toEqual({
        password       : 'connect-password',
        createIdentity : true,
      });
    });

  });

  describe('anonymous()', () => {
    it('should return an anonymous API with a read-only dwn property', () => {
      const anonApi = Enbox.anonymous();
      expect(anonApi).toBeDefined();
      expect(anonApi.dwn).toBeDefined();
    });
  });
});
