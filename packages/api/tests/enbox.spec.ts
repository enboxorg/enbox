import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { PlatformAgentTestHarness } from '@enbox/agent/test';
import {
  AudienceDecryptError as AgentAudienceDecryptError,
  DwnInterface,
  EnboxUserAgent,
} from '@enbox/agent';

import { defineProtocol } from '../src/define-protocol.js';
import { Enbox } from '../src/enbox.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';
import {
  AudienceDecryptError,
  DwnResponseError,
  RecordParentNotFoundError,
  RecordSquashBackstopError,
} from '../src/index.js';
import {
  DwnResponseError as DirectDwnResponseError,
  RecordParentNotFoundError as DirectRecordParentNotFoundError,
  RecordSquashBackstopError as DirectRecordSquashBackstopError,
} from '../src/dwn-response-error.js';

describe('AudienceDecryptError re-export', () => {
  it('re-exports the same class identity as @enbox/agent so instanceof checks work across layers', () => {
    // Reference equality is the point: the api export must be the SAME class object,
    // not a lookalike, or cross-layer instanceof checks would silently fail.
    expect(AudienceDecryptError).toBe(AgentAudienceDecryptError);
    const decryptError = new AudienceDecryptError({
      cause    : 'delivery-missing',
      detail   : 'no delivery covers the record.',
      recordId : 'test-record',
    });
    expect(decryptError).toBeInstanceOf(AgentAudienceDecryptError);
    expect(decryptError.cause).toBe('delivery-missing');
  });
});

describe('DwnResponseError export', () => {
  it('exports the public errors with one class identity', () => {
    expect(DwnResponseError).toBe(DirectDwnResponseError);
    expect(RecordParentNotFoundError).toBe(DirectRecordParentNotFoundError);
    expect(RecordSquashBackstopError).toBe(DirectRecordSquashBackstopError);
    const error = new DwnResponseError('records.query', { code: 401, detail: 'Unauthorized' });
    expect(error).toBeInstanceOf(DirectDwnResponseError);
  });
});

describe('Enbox API', () => {
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
        expect(enbox).toHaveProperty('using');
        expect((enbox as any)._dwn.permissionsApi).toBe(testHarness.agent.permissions);
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

      const TestProtocol = defineProtocol(TestProtocolDef, {
        item: recordCodecs.json<{ name: string }>(),
      });

      const RoleProtocolDef = {
        protocol  : 'https://example.com/protocols/roles',
        published : true,
        types     : {
          member : { dataFormats: ['application/json'] },
          secret : { dataFormats: ['application/json'], encryptionRequired: true },
        },
        structure: {
          member : { $role: true },
          secret : {},
        },
      } as const satisfies ProtocolDefinition;

      const RoleProtocol = defineProtocol(RoleProtocolDef, {
        member : recordCodecs.json<{ name: string }>(),
        secret : recordCodecs.json<{ value: string }>(),
      });

      it('should cache typed instances and wire authored role delivery lifecycles', async () => {
        const identity = await testHarness.agent.identity.create({
          metadata  : { name: 'CacheTest' },
          didMethod : 'jwk',
        });

        const enbox = new Enbox({
          agent        : testHarness.agent,
          connectedDid : identity.did.uri,
        });
        const registerDelivery = sinon.stub(testHarness.agent.dwn, 'registerAudienceKeyDeliveryProtocol');

        const first = enbox.using(TestProtocol);
        const second = enbox.using(TestProtocol);

        expect(first).toBeInstanceOf(TypedEnbox);
        expect(first).toBe(second); // same reference
        expect(registerDelivery.notCalled).toBe(true);

        enbox.using(RoleProtocol);

        expect(registerDelivery.calledOnce).toBe(true);
        expect(registerDelivery.firstCall.args[0]).toMatchObject({
          granteeDid : undefined,
          protocol   : RoleProtocolDef.protocol,
          rolePaths  : ['member'],
          target     : identity.did.uri,
        });
        expect(registerDelivery.firstCall.args[0].signal).toBeInstanceOf(AbortSignal);
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

        const OtherProtocol = defineProtocol(OtherProtocolDef, {
          thing: recordCodecs.json<{ value: number }>(),
        });

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

      it('should not alias distinct codec declarations that share one protocol URI', async () => {
        const identity = await testHarness.agent.identity.create({
          metadata  : { name: 'CodecIsolation' },
          didMethod : 'jwk',
        });
        const enbox = new Enbox({
          agent        : testHarness.agent,
          connectedDid : identity.did.uri,
        });
        const firstProtocol = defineProtocol(TestProtocolDef, {
          item: recordCodecs.json<{ name: string }>(),
        });
        const secondProtocol = defineProtocol(TestProtocolDef, {
          item: recordCodecs.json<{ label: string }>(),
        });

        expect(enbox.using(firstProtocol)).not.toBe(enbox.using(secondProtocol));
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

    describe('close()', () => {
      const CloseProtocolDef = {
        protocol  : 'https://example.com/protocols/close-test',
        published : true,
        types     : { item: {} },
        structure : { item: {} },
      } as const satisfies ProtocolDefinition;

      const CloseProtocol = defineProtocol(CloseProtocolDef, {
        item: recordCodecs.json<unknown>(),
      });

      it('should release only facade-owned resources', async () => {
        const identity = await testHarness.agent.identity.create({
          metadata  : { name: 'Close' },
          didMethod : 'jwk',
        });
        const sessionLifetime = new AbortController();

        const enbox = new Enbox({
          agent        : testHarness.agent,
          connectedDid : identity.did.uri,
          signal       : sessionLifetime.signal,
        });

        // Cache a TypedEnbox instance.
        const typed = enbox.using(CloseProtocol);
        expect(typed).toBeDefined();
        const rawDwn = enbox.dwn;
        expect((enbox as any)._lifetimeSignal.aborted).toBe(false);

        const stopSync = sinon.spy(testHarness.agent.sync, 'stopSync');
        enbox.close();
        enbox.close();

        expect((enbox as any)._lifetimeSignal.aborted).toBe(true);
        expect(sessionLifetime.signal.aborted).toBe(false);
        expect(stopSync.called).toBe(false);
        expect((enbox as any)._typedInstances.size).toBe(0);
        expect(rawDwn).toBeDefined();
        expect(() => enbox.using(CloseProtocol)).toThrow();
        expect(() => enbox.dwn).toThrow();
        expect(() => typed.dwn).toThrow();
        await expect(typed.configure()).rejects.toMatchObject({ name: 'AbortError' });
        await expect(typed.verifyInstalled()).rejects.toMatchObject({ name: 'AbortError' });
      });

      it('should fence a retained typed record after close', async () => {
        const enbox = new Enbox({
          agent        : testHarness.agent,
          connectedDid : testHarness.agent.agentDid.uri,
        });
        const record = await enbox.using(CloseProtocol).records.create('item', {
          data: { value: 'current' },
        });
        const processRequest = sinon.spy(testHarness.agent, 'processDwnRequest');

        enbox.close();

        await expect(record.value()).rejects.toMatchObject({ name: 'AbortError' });
        await expect(record.data.blob()).rejects.toMatchObject({ name: 'AbortError' });
        await expect(record.update({ data: { value: 'updated' } })).rejects.toMatchObject({ name: 'AbortError' });
        await expect(record.delete()).rejects.toMatchObject({ name: 'AbortError' });
        expect(processRequest.called).toBe(false);
      });

      it('should reject a stale typed query before touching the DWN', async () => {
        const enbox = new Enbox({
          agent        : testHarness.agent,
          connectedDid : testHarness.agent.agentDid.uri,
        });
        const typed = enbox.using(CloseProtocol);
        const processRequest = sinon.spy(testHarness.agent, 'processDwnRequest');

        enbox.close();

        await expect(typed.records.query('item')).rejects.toMatchObject({ name: 'AbortError' });
        expect(processRequest.called).toBe(false);
      });

      it('should reject a stale typed create after pending readiness settles', async () => {
        const enbox = new Enbox({
          agent        : testHarness.agent,
          connectedDid : testHarness.agent.agentDid.uri,
        });
        const typed = enbox.using(CloseProtocol);
        let resolveReadiness!: () => void;
        const readiness = new Promise<void>((resolve): void => { resolveReadiness = resolve; });
        const ensureReady = sinon.stub(typed as any, '_autoConfigureOnce').returns(readiness);
        const processRequest = sinon.spy(testHarness.agent, 'processDwnRequest');

        const creating = typed.records.create('item', { data: { value: 'stale' } });
        expect(ensureReady.calledOnce).toBe(true);
        enbox.close();
        resolveReadiness();

        await expect(creating).rejects.toMatchObject({ name: 'AbortError' });
        expect(processRequest.called).toBe(false);
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

  describe('fromSession()', () => {
    let testHarness: PlatformAgentTestHarness;

    beforeAll(async () => {
      testHarness = await PlatformAgentTestHarness.setup({
        agentClass  : EnboxUserAgent,
        agentStores : 'memory',
      });
      await testHarness.createAgentDid();
    });

    afterAll(async () => {
      await testHarness.clearStorage();
      await testHarness.closeStorage();
    });

    it('binds the session primitives and owning lifetime', () => {
      const lifetime = new AbortController();
      const did = testHarness.agent.agentDid.uri;
      const enbox = Enbox.fromSession({
        agent       : testHarness.agent,
        did,
        delegateDid : 'did:jwk:delegate',
        identity    : { didUri: did, name: 'Session' },
        signal      : lifetime.signal,
      });

      expect(enbox.agent).toBe(testHarness.agent);
      expect(enbox.connectedDid).toBe(did);
      expect(enbox.delegateDid).toBe('did:jwk:delegate');
      expect((enbox as any)._lifetimeSignal.aborted).toBe(false);

      lifetime.abort();

      expect((enbox as any)._lifetimeSignal.aborted).toBe(true);
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
