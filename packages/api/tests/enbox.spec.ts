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

  describe('fromSession() / connect() / constructor', () => {
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

    it('public constructor returns an instance bound to raw params', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Raw' },
        didMethod : 'jwk',
      });

      const enbox = new Enbox({
        agent        : testHarness.agent,
        connectedDid : identity.did.uri,
      });

      expect(enbox).toBeInstanceOf(Enbox);
      expect(enbox.agent).toBe(testHarness.agent);
    });

    it('public constructor carries delegateDid through', async () => {
      const connectedIdentity = await testHarness.agent.identity.create({
        metadata  : { name: 'Connected' },
        didMethod : 'jwk',
      });

      const delegateIdentity = await testHarness.agent.identity.create({
        metadata  : { name: 'Delegate' },
        didMethod : 'jwk',
      });

      const enbox = new Enbox({
        agent        : testHarness.agent,
        connectedDid : connectedIdentity.did.uri,
        delegateDid  : delegateIdentity.did.uri,
      });

      expect(enbox).toBeInstanceOf(Enbox);
      expect(enbox.agent).toBe(testHarness.agent);
    });

    it('Enbox.fromSession() accepts a minimal { agent, did } shape', async () => {
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

    it('Enbox.fromSession() accepts an AuthSession-shaped object', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Session' },
        didMethod : 'jwk',
      });

      // Duck-typed AuthSession: any extra fields (like `identity`) are ignored.
      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'Session' },
      };

      const enbox = Enbox.fromSession(session);

      expect(enbox).toBeInstanceOf(Enbox);
      expect(enbox.agent).toBe(testHarness.agent);
    });

    it('Enbox.fromSession() carries delegateDid through to the constructor', async () => {
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

      const enbox = Enbox.fromSession(session);

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

    it('should preserve handler connect when local defaults are also provided', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Handler Connect' },
        didMethod : 'jwk',
      });

      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'Handler Connect' },
      };
      const connect = sinon.stub().resolves(session);
      const auth = { connect };
      const create = sinon.stub(AuthManager, 'create').resolves(auth as any);
      const connectHandler = { requestAccess: sinon.stub().resolves(undefined) };
      // Non-empty protocols array — an empty array no longer counts as a
      // handler signal (see `_isHandlerConnect`), so we exercise the real
      // handler-routing path with at least one protocol.
      const protocols: ProtocolDefinition[] = [
        { protocol: 'https://example.com/p', published: true, types: {}, structure: {} } as ProtocolDefinition,
      ];

      await Enbox.connect({
        password       : 'test-password',
        dwnEndpoints   : ['https://dwn.example.com'],
        createIdentity : true,
        metadata       : { name: 'Local Default' },
        sync           : 'off',
        connectHandler,
        protocols,
      });

      expect(create.firstCall.args[0]).toEqual({
        password     : 'test-password',
        sync         : 'off',
        dwnEndpoints : ['https://dwn.example.com'],
        connectHandler,
      });
      // After the API-layer refactor we forward every per-call signal
      // verbatim and let `AuthManager._isLocalConnect` pick the flow.
      // Handler flow ignores local-only keys (`createIdentity`,
      // `metadata`, `recoveryPhrase`) but they're still passed so adding
      // a new per-call option doesn't require coordinated edits here.
      expect(connect.firstCall.args[0]).toEqual({
        protocols,
        connectHandler,
        password       : 'test-password',
        sync           : 'off',
        dwnEndpoints   : ['https://dwn.example.com'],
        createIdentity : true,
        metadata       : { name: 'Local Default' },
      });
    });

    it('should shut down the AuthManager when high-level connect fails', async () => {
      const connectError = new Error('connect failed');
      const connect = sinon.stub().rejects(connectError);
      const shutdown = sinon.stub().resolves();
      const auth = { connect, shutdown };
      sinon.stub(AuthManager, 'create').resolves(auth as any);

      await expect(Enbox.connect({ createIdentity: true })).rejects.toThrow('connect failed');

      expect(shutdown.calledOnce).toBe(true);
    });

    it('should preserve the original connect error when auth.shutdown() also throws', async () => {
      // Regression for the catch-swallow at packages/api/src/enbox.ts:300.
      // When the recovery shutdown fails, the caller must still see the
      // original `connect` rejection, not the shutdown error.
      const connectError = new Error('original connect failure');
      const shutdownError = new Error('shutdown also failed');
      const connect = sinon.stub().rejects(connectError);
      const shutdown = sinon.stub().rejects(shutdownError);
      const auth = { connect, shutdown };
      sinon.stub(AuthManager, 'create').resolves(auth as any);

      await expect(Enbox.connect({ createIdentity: true }))
        .rejects.toThrow('original connect failure');

      expect(shutdown.calledOnce).toBe(true);
    });

    it('should call AuthManager.create with {} and auth.connect with undefined when no options are given', async () => {
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'No-args' },
        didMethod : 'jwk',
      });
      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'No-args' },
      };
      const connect = sinon.stub().resolves(session);
      const auth = { connect };
      const create = sinon.stub(AuthManager, 'create').resolves(auth as any);

      await Enbox.connect();

      expect(create.firstCall.args[0]).toEqual({});
      expect(connect.firstCall.args[0]).toBeUndefined();
    });

    it('per-call password in handler flow is forwarded to auth.connect', async () => {
      // Regression for #3: previously, handler routing silently dropped
      // any per-call password. The agent vault now unlocks with the
      // caller's password override.
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Per-call password' },
        didMethod : 'jwk',
      });
      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'Per-call password' },
      };
      const connect = sinon.stub().resolves(session);
      const auth = { connect };
      const create = sinon.stub(AuthManager, 'create').resolves(auth as any);
      const connectHandler = { requestAccess: sinon.stub().resolves(undefined) };
      const protocols: ProtocolDefinition[] = [
        { protocol: 'https://example.com/p', published: true, types: {}, structure: {} } as ProtocolDefinition,
      ];

      await Enbox.connect({
        password: 'per-call-password',
        protocols,
        connectHandler,
      });

      expect(create.firstCall.args[0]).toEqual({
        password: 'per-call-password',
        connectHandler,
      });
      expect(connect.firstCall.args[0]).toEqual({
        protocols,
        connectHandler,
        password: 'per-call-password',
      });
    });

    it('throws when two concurrent Enbox.connect() calls share the same data path', async () => {
      // Regression for #4. Each call constructs its own AuthManager that
      // would open the same LevelDB path; the API-layer guard turns the
      // ensuing LEVEL_LOCKED into a domain-level error before any I/O.
      let resolveFirstConnect!: (s: any) => void;
      const firstConnectPromise = new Promise((res) => { resolveFirstConnect = res; });
      const firstAuth = {
        connect  : sinon.stub().returns(firstConnectPromise),
        shutdown : sinon.stub().resolves(),
      };
      sinon.stub(AuthManager, 'create').resolves(firstAuth as any);

      const inFlight = Enbox.connect({ password: 'pw' });

      // Second call against the (default) same data path must reject
      // synchronously — not race on the LevelDB lock.
      await expect(Enbox.connect({ password: 'pw' }))
        .rejects.toThrow(/already in progress/);

      // Let the first call complete so we don't leak a hanging promise.
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Concurrent' },
        didMethod : 'jwk',
      });
      resolveFirstConnect({
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'Concurrent' },
      });
      await inFlight;
    });

    it('allows concurrent Enbox.connect() with distinct dataPaths', async () => {
      // The guard is keyed by dataPath. Different paths don't conflict.
      const identityA = await testHarness.agent.identity.create({
        metadata  : { name: 'Path A' },
        didMethod : 'jwk',
      });
      const identityB = await testHarness.agent.identity.create({
        metadata  : { name: 'Path B' },
        didMethod : 'jwk',
      });
      const sessionA = {
        agent       : testHarness.agent,
        did         : identityA.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identityA.did.uri, name: 'Path A' },
      };
      const sessionB = {
        agent       : testHarness.agent,
        did         : identityB.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identityB.did.uri, name: 'Path B' },
      };
      // Two stubs returning different sessions — sufficient for the test.
      const create = sinon.stub(AuthManager, 'create');
      create.onCall(0).resolves({ connect: sinon.stub().resolves(sessionA) } as any);
      create.onCall(1).resolves({ connect: sinon.stub().resolves(sessionB) } as any);

      const [resultA, resultB] = await Promise.all([
        Enbox.connect({ dataPath: '/tmp/path-a' }),
        Enbox.connect({ dataPath: '/tmp/path-b' }),
      ]);

      expect(resultA.session).toBe(sessionA);
      expect(resultB.session).toBe(sessionB);
    });

    it('Enbox.connect({ agent }) does NOT take ownership: enbox.disconnect() leaves caller\'s agent alone', async () => {
      // Regression for adversarial H1: previously, `_ownedAuth = auth` was
      // set unconditionally, so a later `enbox.disconnect()` would
      // `auth.shutdown()` and lock the vault / close the sync engine on
      // a caller-supplied agent. With the fix, ownership is taken only
      // when Enbox constructed the agent + storage itself.
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Caller-owned agent' },
        didMethod : 'jwk',
      });
      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'Caller-owned agent' },
      };
      const shutdown = sinon.stub().resolves();
      const connect = sinon.stub().resolves(session);
      const auth = { connect, shutdown };
      sinon.stub(AuthManager, 'create').resolves(auth as any);

      // Pre-built agent supplied by the caller — Enbox.connect must not
      // take ownership.
      const { enbox } = await Enbox.connect({ agent: testHarness.agent });

      await enbox.disconnect();

      // The caller's AuthManager.shutdown() must NOT have been called by
      // enbox.disconnect(). The caller is responsible for tearing it down.
      expect(shutdown.called).toBe(false);
    });

    it('concurrency guard holds when AuthManager.create takes real async time', async () => {
      // Hardening regression for a reviewer concern that the guard might
      // have a TOCTOU window between `has(key)` and `set(key, ...)`. The
      // claim was: if `AuthManager.create()` does real async work, a
      // second `Enbox.connect()` call on the same tick could pass the
      // has() check before set() ran. That's not how JS async works —
      // the synchronous portion from has() through set() runs as one
      // call-stack frame — but worth pinning the property with a stub
      // that DOES take real async time (50ms), unlike the immediately-
      // resolved stub used in the other concurrency test.
      let createCallCount = 0;
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'TOCTOU' },
        didMethod : 'jwk',
      });
      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'TOCTOU' },
      };
      sinon.stub(AuthManager, 'create').callsFake(async () => {
        createCallCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { connect: sinon.stub().resolves(session), shutdown: sinon.stub().resolves() } as any;
      });

      // Fire two calls on the same synchronous tick. The second must
      // reject synchronously, BEFORE either reaches AuthManager.create.
      const results = await Promise.allSettled([
        Enbox.connect({ password: 'pw' }),
        Enbox.connect({ password: 'pw' }),
      ]);

      // Exactly one call reached AuthManager.create; the other was
      // rejected by the guard before any I/O could happen.
      expect(createCallCount).toBe(1);
      const [first, second] = results;
      expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
      const rejection = first.status === 'rejected' ? first : second as PromiseRejectedResult;
      expect((rejection.reason as Error).message).toMatch(/already in progress/);
    });

    it('Enbox.connect() with default options DOES take AuthManager ownership', async () => {
      // Counterpart to the H1 regression test above: when Enbox constructs
      // the agent + storage itself, ownership transfers so callers don't
      // have to know about AuthManager.
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Enbox-owned' },
        didMethod : 'jwk',
      });
      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'Enbox-owned' },
      };
      const shutdown = sinon.stub().resolves();
      const connect = sinon.stub().resolves(session);
      const auth = { connect, shutdown };
      sinon.stub(AuthManager, 'create').resolves(auth as any);

      const { enbox } = await Enbox.connect({ password: 'pw' });

      await enbox.disconnect();

      // No caller-supplied agent or storage → Enbox owns the AuthManager
      // → enbox.disconnect() tears it down.
      expect(shutdown.calledOnce).toBe(true);
    });

    it('parallel enbox.disconnect() calls share one teardown promise (stopSync runs once)', async () => {
      // Regression for the reviewer-flagged C2: prior to memoization,
      // two concurrent disconnect() calls would each call
      // agent.sync.stopSync (idempotent but redundant) and could race
      // on `_ownedAuth` ownership transfer.
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Parallel disconnect' },
        didMethod : 'jwk',
      });
      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'Parallel disconnect' },
      };
      const shutdown = sinon.stub().resolves();
      const connect = sinon.stub().resolves(session);
      sinon.stub(AuthManager, 'create').resolves({ connect, shutdown } as any);
      const stopSpy = sinon.spy(testHarness.agent.sync, 'stopSync');

      const { enbox } = await Enbox.connect({ password: 'pw' });

      // Fire two parallel disconnects on the same tick.
      await Promise.all([enbox.disconnect(), enbox.disconnect()]);

      // stopSync invoked exactly once thanks to the memoized teardown
      // promise; AuthManager.shutdown also once.
      expect(stopSpy.callCount).toBe(1);
      expect(shutdown.calledOnce).toBe(true);
      stopSpy.restore();
    });

    it('empty protocols array routes to local connect (not handler)', async () => {
      // Regression for #11: protocols:[] carries no permission intent and
      // must not produce a zero-grant "connected" handler session.
      const identity = await testHarness.agent.identity.create({
        metadata  : { name: 'Empty protocols' },
        didMethod : 'jwk',
      });
      const session = {
        agent       : testHarness.agent,
        did         : identity.did.uri,
        delegateDid : undefined,
        identity    : { didUri: identity.did.uri, name: 'Empty protocols' },
      };
      const connect = sinon.stub().resolves(session);
      const auth = { connect };
      sinon.stub(AuthManager, 'create').resolves(auth as any);

      await Enbox.connect({ password: 'pw', protocols: [], createIdentity: true });

      // Local flow forwards local-style keys; no `protocols` array, no
      // connectHandler — empty array was filtered out as a non-signal.
      expect(connect.firstCall.args[0]).toEqual({
        password       : 'pw',
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
