import type { EnboxUserAgent } from '@enbox/agent';
import type { ServerInfo } from '@enbox/dwn-clients';
import type { DidRegistrationResult, DidResolutionResult } from '@enbox/dids';
import type { RegistrationOptions, RegistrationTokenData } from '../src/types.js';

import sinon from 'sinon';
import { afterEach, describe, expect, test } from 'bun:test';

import { DwnRegistrar } from '@enbox/dwn-clients';
import { Convert, MemoryStore } from '@enbox/common';
import { HdIdentityVault, VaultBackedSecretStore } from '@enbox/agent';

import { AuthManager } from '../src/auth-manager.js';
import { DwnTenantRegistrationError } from '../src/errors.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';
import { createMockAgent, createMockIdentity } from './helpers/mock-agent.js';

const endpoint = 'https://dwn.example.com';
const secondEndpoint = 'https://second.example.com';
const ownerDid = 'did:dht:testuser123';
const token: RegistrationTokenData = { registrationToken: 'saved-token' };

function info(requirements: string[] = ['proof-of-work-sha256-v0']): ServerInfo {
  return {
    registrationRequirements : requirements,
    maxFileSize              : 10_000_000,
    server                   : '@enbox/dwn-server',
    sdkVersion               : '0.0.0',
    url                      : endpoint,
    version                  : '0.0.0',
    webSocketSupport         : false,
    providerAuth             : requirements.includes('provider-auth-v0') ? {
      authorizeUrl : 'https://provider.example/authorize?plan=paid',
      tokenUrl     : 'https://provider.example/token',
      refreshUrl   : 'https://provider.example/refresh',
    } : undefined,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail): void => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function setTokens(agent: EnboxUserAgent, tokens: Record<string, RegistrationTokenData>): Promise<void> {
  await agent.secrets.put(STORAGE_KEYS.REGISTRATION_TOKENS, Convert.string(JSON.stringify(tokens)).toUint8Array());
}

async function getTokens(agent: EnboxUserAgent): Promise<Record<string, RegistrationTokenData>> {
  const bytes = await agent.secrets.get(STORAGE_KEYS.REGISTRATION_TOKENS);
  return bytes === undefined ? {} : JSON.parse(Convert.uint8Array(bytes).toString());
}

async function managerFor(
  agent: EnboxUserAgent,
  registration?: RegistrationOptions,
  storage = new MemoryStorage(),
): Promise<AuthManager> {
  return AuthManager.create({ agent, registration, storage });
}

describe('AuthManager.registerDwnTenants', (): void => {
  afterEach((): void => { sinon.restore(); });
  test('registers only the requested owner DID × endpoint pairs and deduplicates input', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info() });
    const register = sinon.stub(DwnRegistrar, 'registerTenant').resolves();
    const manager = await managerFor(agent);
    const result = await manager.registerDwnTenants({ dids: [ownerDid, ownerDid], dwnEndpoints: [endpoint, `${endpoint}/`, secondEndpoint] });
    expect(register.args.map((args) => args.slice(0, 2))).toEqual([[endpoint, ownerDid], [secondEndpoint, ownerDid]]);
    expect(result).toEqual({ registered: [{ did: ownerDid, endpoint }, { did: ownerDid, endpoint: secondEndpoint }], failed: [] });
  });

  test('accepts the agent DID without adding another identity implicitly', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info([]) });
    const manager = await managerFor(agent);
    expect((await manager.registerDwnTenants({ dids: [agent.agentDid.uri], dwnEndpoints: [endpoint] })).registered)
      .toEqual([{ did: agent.agentDid.uri, endpoint }]);
  });

  test('rejects unowned and delegated DIDs before server or credential requests', async (): Promise<void> => {
    const delegate = createMockIdentity({ metadata: { name: 'Delegate', tenant: 'did:dht:testagent', connectedDid: 'did:dht:foreign' } });
    const agent = createMockAgent({ identityList: async () => [delegate] });
    const serverInfo = sinon.spy(agent.rpc, 'getServerInfo');
    const credentials = sinon.spy(agent.secrets, 'get');
    const manager = await managerFor(agent);
    for (const did of ['did:dht:foreign', ownerDid]) {
      await expect(manager.registerDwnTenants({ dids: [did], dwnEndpoints: [endpoint] })).rejects.toThrow('managed owner DID');
    }
    expect(serverInfo.called).toBe(false);
    expect(credentials.called).toBe(false);
  });

  test('rejects empty or invalid topology before network requests', async (): Promise<void> => {
    const agent = createMockAgent();
    const network = sinon.spy(agent.rpc, 'getServerInfo');
    const manager = await managerFor(agent);
    for (const options of [
      { dids: [], dwnEndpoints: [endpoint] },
      { dids: [ownerDid], dwnEndpoints: [] },
      { dids: [ownerDid], dwnEndpoints: [`${endpoint}?secret=1`] },
      { dids: ['invalid'], dwnEndpoints: [endpoint] },
    ]) {
      await expect(manager.registerDwnTenants(options)).rejects.toThrow(TypeError);
    }
    expect(network.called).toBe(false);
  });

  test('rejects a locked vault before reading absent credentials', async (): Promise<void> => {
    const agent = createMockAgent({ vaultIsLocked: (): boolean => true });
    const credentials = sinon.spy(agent.secrets, 'get');
    const manager = await managerFor(agent);
    await expect(manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })).rejects.toThrow('unlocked vault');
    expect(credentials.called).toBe(false);
  });

  test('fails closed for corrupt or unreadable encrypted credentials', async (): Promise<void> => {
    const agent = createMockAgent();
    const network = sinon.spy(agent.rpc, 'getServerInfo');
    const manager = await managerFor(agent);
    for (const value of ['{', '{"https://dwn.example.com":{"registrationToken":false}}']) {
      await agent.secrets.put(STORAGE_KEYS.REGISTRATION_TOKENS, Convert.string(value).toUint8Array());
      await expect(manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })).rejects.toThrow('credentials');
    }
    sinon.stub(agent.secrets, 'get').rejects(new Error('cannot decrypt'));
    await expect(manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })).rejects.toThrow('credentials');
    expect(network.called).toBe(false);
  });

  test('uses encrypted saved provider tokens without requiring a UI callback', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    await setTokens(agent, { [endpoint]: token });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    const manager = await managerFor(agent);
    await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
    expect(register.args).toEqual([[endpoint, ownerDid, token.registrationToken]]);
  });

  for (const persistTokens of [false, true]) {
    const source = persistTokens ? 'encrypted' : 'caller-managed';
    const rawEndpoint = 'https://DWN.example.com:443/tenant///';
    const canonicalEndpoint = `${endpoint}/tenant`;
    test(`reuses ${source} credentials for a normalized endpoint without authorization or refresh`, async (): Promise<void> => {
      const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
      const saved = {
        ...token, expiresAt: Date.now() + 60_000, refreshToken: 'unused-refresh', refreshUrl: 'https://provider.example/refresh?account=1',
      };
      const credentials = { [rawEndpoint]: saved, 'https://SECOND.example.com/': { registrationToken: 'other' } };
      if (persistTokens) { await setTokens(agent, credentials); }
      const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
      const refresh = sinon.stub(DwnRegistrar, 'refreshRegistrationToken');
      const authorize = sinon.stub().rejects(new Error('Unexpected provider authorization'));
      let observed: Record<string, RegistrationTokenData> | undefined;
      const manager = await managerFor(agent, {
        persistTokens,
        registrationTokens     : persistTokens ? undefined : credentials,
        onProviderAuthRequired : authorize,
        onRegistrationTokens   : (tokens): void => { observed = tokens; },
      });

      const result = await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [rawEndpoint] });

      expect(result.registered).toEqual([{ did: ownerDid, endpoint: canonicalEndpoint }]);
      expect(register.args).toEqual([[canonicalEndpoint, ownerDid, token.registrationToken]]);
      expect(refresh.called || authorize.called).toBe(false);
      expect(observed).toEqual({ [canonicalEndpoint]: saved, [secondEndpoint]: { registrationToken: 'other' } });
      expect(Object.keys(credentials)).toEqual([rawEndpoint, 'https://SECOND.example.com/']);
    });
    test(`coalesces identical normalized ${source} credentials`, async (): Promise<void> => {
      const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
      const credentials = { [endpoint]: token, 'https://DWN.example.com/': { ...token } };
      if (persistTokens) { await setTokens(agent, credentials); }
      const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
      const authorize = sinon.stub().rejects(new Error('Unexpected provider authorization'));
      const refresh = sinon.stub(DwnRegistrar, 'refreshRegistrationToken');
      let observed: Record<string, RegistrationTokenData> | undefined;
      const manager = await managerFor(agent, {
        persistTokens,
        registrationTokens     : persistTokens ? undefined : credentials,
        onProviderAuthRequired : authorize,
        onRegistrationTokens   : (tokens): void => { observed = tokens; },
      });

      await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint, 'https://DWN.example.com/'] });

      expect(register.args).toEqual([[endpoint, ownerDid, token.registrationToken]]);
      expect(observed).toEqual({ [endpoint]: token });
      expect(authorize.called || refresh.called).toBe(false);
    });

    for (const conflicting of [
      { ...token, registrationToken: 'different' },
      { ...token, refreshToken: 'different' },
      { ...token, refreshUrl: 'https://provider.example/refresh' },
      { ...token, expiresAt: 0 },
    ]) {
      test(`rejects conflicting normalized ${source} credentials '${JSON.stringify(conflicting)}' before network or UI`, async (): Promise<void> => {
        const agent = createMockAgent();
        const credentials = { [endpoint]: token, 'https://DWN.example.com/': conflicting, [secondEndpoint]: token };
        if (persistTokens) { await setTokens(agent, credentials); }
        const network = sinon.spy(agent.rpc, 'getServerInfo');
        const write = sinon.spy(agent.secrets, 'put');
        const authorize = sinon.stub();
        const refresh = sinon.stub(DwnRegistrar, 'refreshRegistrationToken');
        const manager = await managerFor(agent, {
          persistTokens,
          registrationTokens     : persistTokens ? undefined : credentials,
          onProviderAuthRequired : authorize,
        });

        await expect(manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })).rejects.toThrow('credentials');

        expect(network.called || authorize.called || refresh.called || write.called).toBe(false);
        if (persistTokens) { expect(await getTokens(agent)).toEqual(credentials); }
      });
    }

    test(`rejects invalid ${source} credential endpoints before network or UI`, async (): Promise<void> => {
      const agent = createMockAgent();
      const credentials = { [endpoint]: token, [`${endpoint}?secret=1`]: token };
      if (persistTokens) { await setTokens(agent, credentials); }
      const network = sinon.spy(agent.rpc, 'getServerInfo');
      const authorize = sinon.stub();
      const manager = await managerFor(agent, {
        persistTokens,
        registrationTokens     : persistTokens ? undefined : credentials,
        onProviderAuthRequired : authorize,
      });

      await expect(manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })).rejects.toThrow('credentials');

      expect(network.called || authorize.called).toBe(false);
    });
  }

  test('refreshes multi-slash encrypted credentials with the full provider URL and preserves other endpoints', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const refreshUrl = 'https://PROVIDER.example/refresh/?account=1#session';
    await setTokens(agent, {
      'https://DWN.example.com/tenant//' : { ...token, expiresAt: 0, refreshToken: 'refresh', refreshUrl },
      'https://SECOND.example.com/'      : { registrationToken: 'other' },
    });
    const refresh = sinon.stub(DwnRegistrar, 'refreshRegistrationToken').resolves({ tokenType: 'Bearer', registrationToken: 'rotated' });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    const authorize = sinon.stub().rejects(new Error('Unexpected provider authorization'));
    const manager = await managerFor(agent, { onProviderAuthRequired: authorize });

    await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: ['https://DWN.example.com/tenant//'] });
    await manager.registerDwnTenants({ dids: [agent.agentDid.uri], dwnEndpoints: [`${endpoint}/tenant`] });

    expect(refresh.args).toEqual([[refreshUrl, 'refresh']]);
    expect(register.args).toEqual([
      [`${endpoint}/tenant`, ownerDid, 'rotated'],
      [`${endpoint}/tenant`, agent.agentDid.uri, 'rotated'],
    ]);
    expect(authorize.called).toBe(false);
    expect(await getTokens(agent)).toEqual({
      [`${endpoint}/tenant`] : { registrationToken: 'rotated', refreshToken: 'refresh', refreshUrl },
      [secondEndpoint]       : { registrationToken: 'other' },
    });
  });

  test('uses caller-owned OAuth UI and saves exchanged credentials before tenant registration', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    sinon.stub(DwnRegistrar, 'exchangeAuthCode').resolves({ tokenType: 'Bearer', registrationToken: 'exchanged' });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').callsFake(async (): Promise<void> => {
      expect((await getTokens(agent))[endpoint].registrationToken).toBe('exchanged');
    });
    const manager = await managerFor(agent, {
      onProviderAuthRequired: async (params) => {
        const url = new URL(params.authorizeUrl);
        expect(url.searchParams.get('plan')).toBe('paid');
        expect(url.searchParams.get('redirect_uri')).toBe(endpoint);
        expect(url.searchParams.get('state')).toBe(params.state);
        return { code: 'code', state: params.state };
      },
    });
    await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
    expect(register.callCount).toBe(1);
  });

  test('rejects a provider CSRF mismatch without exchanging code or registering', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const exchange = sinon.stub(DwnRegistrar, 'exchangeAuthCode');
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken');
    const manager = await managerFor(agent, { onProviderAuthRequired: async () => ({ code: 'code', state: 'wrong' }) });
    const error = await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DwnTenantRegistrationError);
    expect((error as DwnTenantRegistrationError).result.failed[0].error).toBeInstanceOf(Error);
    expect(exchange.called || register.called).toBe(false);
  });

  test('falls back to PoW only when the server advertises it', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (url): Promise<ServerInfo> => info(url === endpoint
      ? ['provider-auth-v0'] : ['provider-auth-v0', 'proof-of-work-sha256-v0']) });
    const register = sinon.stub(DwnRegistrar, 'registerTenant').resolves();
    const manager = await managerFor(agent);
    const error = await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint, secondEndpoint] })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DwnTenantRegistrationError);
    expect((error as DwnTenantRegistrationError).result.registered).toEqual([{ did: ownerDid, endpoint: secondEndpoint }]);
    expect(register.args.map((args) => args.slice(0, 2))).toEqual([[secondEndpoint, ownerDid]]);
  });

  test('reports all failed pairs and keeps successful refreshes after partial registration failures', async (): Promise<void> => {
    const otherOwner = 'did:dht:other';
    const agent = createMockAgent({
      identityList     : async () => [createMockIdentity(), createMockIdentity({ did: { uri: otherOwner } })],
      rpcGetServerInfo : async (url): Promise<ServerInfo> => {
        if (url === secondEndpoint) { throw new Error('endpoint unavailable'); }
        return info(['provider-auth-v0']);
      },
    });
    await setTokens(agent, { [endpoint]: { ...token, expiresAt: 0, refreshToken: 'old', refreshUrl: 'https://provider.example/refresh' } });
    sinon.stub(DwnRegistrar, 'refreshRegistrationToken').resolves({ tokenType: 'Bearer', registrationToken: 'refreshed', refreshToken: 'new-refresh' });
    sinon.stub(DwnRegistrar, 'registerTenantWithToken').callsFake(async (_url, did): Promise<void> => {
      if (did === ownerDid) { throw new Error('quota'); }
    });
    let observed: Record<string, RegistrationTokenData> | undefined;
    const manager = await managerFor(agent, { onRegistrationTokens: (tokens): void => { observed = tokens; } });
    const error = await manager.registerDwnTenants({ dids: [ownerDid, otherOwner], dwnEndpoints: [endpoint, secondEndpoint] })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DwnTenantRegistrationError);
    const result = (error as DwnTenantRegistrationError).result;
    expect(result.registered).toEqual([{ did: otherOwner, endpoint }]);
    expect(result.failed.map(({ did, endpoint: url }) => [did, url])).toEqual([
      [ownerDid, endpoint], [ownerDid, secondEndpoint], [otherOwner, secondEndpoint],
    ]);
    expect((await getTokens(agent))[endpoint].refreshToken).toBe('new-refresh');
    expect(observed?.[endpoint].registrationToken).toBe('refreshed');
  });

  test('coalesces concurrent requests for the same agent/DID/endpoint', async (): Promise<void> => {
    const started = deferred<void>();
    const release = deferred<void>();
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info() });
    const register = sinon.stub(DwnRegistrar, 'registerTenant').callsFake(async (): Promise<void> => {
      started.resolve();
      await release.promise;
    });
    const manager = await managerFor(agent);
    const first = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
    await started.promise;
    const second = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
    // The second call waits for the same lifecycle mutation before joining the flight.
    release.resolve();
    await Promise.all([first, second]);
    expect(register.callCount).toBe(1);
  });

  test('merges concurrent endpoint token writes and preserves unrelated credentials', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    await setTokens(agent, { 'https://untouched.example': token });
    sinon.stub(DwnRegistrar, 'exchangeAuthCode').callsFake(async (_tokenUrl, _code, redirectUri) => ({ tokenType: 'Bearer', registrationToken: redirectUri }));
    sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    const firstUi = deferred<void>();
    const secondUi = deferred<void>();
    const release = deferred<void>();
    const manager = await managerFor(agent, {
      onProviderAuthRequired: async (params) => {
        (params.dwnEndpoint === endpoint ? firstUi : secondUi).resolve();
        await release.promise;
        return { code: 'code', state: params.state };
      },
    });
    const first = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
    const second = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [secondEndpoint] });
    await Promise.all([firstUi.promise, secondUi.promise]);
    release.resolve();
    await Promise.all([first, second]);
    expect(await getTokens(agent)).toMatchObject({
      [endpoint]                  : { registrationToken: endpoint },
      [secondEndpoint]            : { registrationToken: secondEndpoint },
      'https://untouched.example' : token,
    });
  });

  test('supports deliberate caller-owned token persistence without reading or writing encrypted tokens', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const read = sinon.spy(agent.secrets, 'get');
    const write = sinon.spy(agent.secrets, 'put');
    sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    let observed: Record<string, RegistrationTokenData> | undefined;
    const manager = await managerFor(agent, {
      persistTokens        : false,
      registrationTokens   : { [endpoint]: token },
      onRegistrationTokens : (tokens): void => { observed = tokens; },
    });
    await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
    expect(read.called || write.called).toBe(false);
    expect(observed).toEqual({ [endpoint]: token });
  });

  for (const callbackFails of [false, true]) {
    test(`reuses the latest caller-managed credentials after ${callbackFails ? 'failed' : 'successful'} persistence`, async (): Promise<void> => {
      const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
      const refresh = sinon.stub(DwnRegistrar, 'refreshRegistrationToken').resolves({
        tokenType: 'Bearer', registrationToken: 'new', refreshToken: 'rotated', expiresIn: 3_600,
      });
      const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
      const observed: string[] = [];
      const manager = await managerFor(agent, {
        persistTokens        : false,
        registrationTokens   : { [endpoint]: { ...token, expiresAt: 0, refreshToken: 'old', refreshUrl: 'https://provider.example/refresh' } },
        onRegistrationTokens : (tokens): void => {
          observed.push(tokens[endpoint].refreshToken!);
          if (callbackFails && observed.length === 1) { throw new Error('caller persistence unavailable'); }
        },
      });
      const first = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
      if (callbackFails) {
        await expect(first).rejects.toThrow('caller persistence unavailable');
      } else {
        await first;
      }
      await manager.registerDwnTenants({ dids: [agent.agentDid.uri], dwnEndpoints: [endpoint] });
      expect(refresh.callCount).toBe(1);
      expect(register.args.map((args) => args[2])).toEqual(['new', 'new']);
      expect(observed).toEqual(['rotated', 'rotated']);
    });
  }

  for (const rotate of [false, true]) {
    test(`isolates current ${rotate ? 'rotated' : 'seeded'} credentials from caller mutation`, async (): Promise<void> => {
      const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
      const seed = { registrationToken: 'seed', expiresAt: rotate ? 0 : undefined, refreshToken: 'R1', refreshUrl: 'https://provider.example/refresh' };
      sinon.stub(DwnRegistrar, 'refreshRegistrationToken').resolves({ tokenType: 'Bearer', registrationToken: 'new', refreshToken: 'R2', expiresIn: 3_600 });
      const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
      const manager = await managerFor(agent, {
        persistTokens        : false,
        registrationTokens   : { [endpoint]: seed },
        onRegistrationTokens : (tokens): void => { tokens[endpoint].registrationToken = 'callback mutation'; },
      });
      await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
      seed.registrationToken = 'configuration mutation';
      await manager.registerDwnTenants({ dids: [agent.agentDid.uri], dwnEndpoints: [endpoint] });
      expect(register.args.map((args) => args[2])).toEqual(rotate ? ['new', 'new'] : ['seed', 'seed']);
    });
  }

  for (const manualRotation of [false, true]) {
    for (const lateJoin of [false, true]) {
      test(`keeps newer ${manualRotation ? 'manual' : 'encrypted'} credentials when an old pair is joined ${lateJoin ? 'after' : 'before'} rotation`, async (): Promise<void> => {
        let now = Date.now();
        sinon.stub(Date, 'now').callsFake((): number => now);
        const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
        await setTokens(agent, {
          [endpoint]       : { registrationToken: 'T1', refreshToken: 'R1', refreshUrl: 'https://provider.example/refresh', expiresAt: now + 100 },
          [secondEndpoint] : token,
        });
        const entered = deferred<void>();
        const release = deferred<void>();
        const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').callsFake(async (_url, did): Promise<void> => {
          if (did === ownerDid) { entered.resolve(); await release.promise; }
        });
        const refresh = sinon.stub(DwnRegistrar, 'refreshRegistrationToken').resolves({
          tokenType: 'Bearer', registrationToken: 'T2', refreshToken: 'R2', expiresIn: 3_600,
        });
        const observed: string[] = [];
        const manager = await managerFor(agent, { onRegistrationTokens: (tokens): void => { observed.push(tokens[endpoint].refreshToken!); } });
        const rotating = manualRotation ? await managerFor(agent, { persistTokens: false }) : manager;
        const request = { dids: [ownerDid], dwnEndpoints: [endpoint] };
        const first = manager.registerDwnTenants(request);
        await entered.promise;
        let joined: Promise<unknown> | undefined;
        if (!lateJoin) {
          joined = manager.registerDwnTenants(request);
          await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
        }
        now += 1_000;
        await rotating.registerDwnTenants({ dids: [agent.agentDid.uri], dwnEndpoints: [endpoint] });
        if (lateJoin) { joined = manager.registerDwnTenants(request); }
        release.resolve();
        await Promise.all([first, joined]);
        expect(refresh.callCount).toBe(1);
        expect(register.callCount).toBe(2);
        expect(observed.every((value): boolean => value === 'R2')).toBe(true);
        expect((await getTokens(agent))[endpoint]).toMatchObject({ registrationToken: 'T2', refreshToken: 'R2' });
        expect((await getTokens(agent))[secondEndpoint]).toEqual(token);
      });
    }
  }

  test('prefers fresh external encrypted credentials over a cached manual rotation', async (): Promise<void> => {
    let now = Date.now();
    sinon.stub(Date, 'now').callsFake((): number => now);
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    await setTokens(agent, {
      [endpoint]: { registrationToken: 'T1', refreshToken: 'R1', refreshUrl: 'https://provider.example/refresh', expiresAt: now + 100 },
    });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    sinon.stub(DwnRegistrar, 'refreshRegistrationToken').resolves({ tokenType: 'Bearer', registrationToken: 'T2', refreshToken: 'R2', expiresIn: 3_600 });
    const manager = await managerFor(agent);
    await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
    now += 1_000;
    const manual = await managerFor(agent, { persistTokens: false });
    await manual.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
    await setTokens(agent, { [endpoint]: { registrationToken: 'external' }, [secondEndpoint]: token });
    await manager.registerDwnTenants({ dids: [agent.agentDid.uri], dwnEndpoints: [endpoint] });
    expect(register.lastCall.args[2]).toBe('external');
    expect(await getTokens(agent)).toEqual({ [endpoint]: { registrationToken: 'external' }, [secondEndpoint]: token });
  });

  test('respects external deletion and still fails closed for corrupt encrypted storage after caching credentials', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    await setTokens(agent, { [endpoint]: token });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    const manager = await managerFor(agent);
    const request = { dids: [ownerDid], dwnEndpoints: [endpoint] };
    await manager.registerDwnTenants(request);
    await agent.secrets.delete(STORAGE_KEYS.REGISTRATION_TOKENS);
    await expect(manager.registerDwnTenants(request)).rejects.toBeInstanceOf(DwnTenantRegistrationError);
    expect(await agent.secrets.get(STORAGE_KEYS.REGISTRATION_TOKENS)).toBeUndefined();
    await agent.secrets.put(STORAGE_KEYS.REGISTRATION_TOKENS, Convert.string('{').toUint8Array());
    await expect(manager.registerDwnTenants(request)).rejects.toThrow('credentials');
    expect(register.callCount).toBe(1);
  });

  for (const manual of [false, true]) {
    test(`clearStorage forgets ${manual ? 'manual seeds' : 'encrypted cached credentials'}`, async (): Promise<void> => {
      const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
      if (!manual) { await setTokens(agent, { [endpoint]: token }); }
      const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
      const manager = await managerFor(agent, manual ? { persistTokens: false, registrationTokens: { [endpoint]: token } } : undefined);
      const request = { dids: [ownerDid], dwnEndpoints: [endpoint] };
      await manager.registerDwnTenants(request);
      await manager.disconnect({ clearStorage: true });
      await expect(manager.registerDwnTenants(request)).rejects.toBeInstanceOf(DwnTenantRegistrationError);
      expect(register.callCount).toBe(1);
      expect(await agent.secrets.get(STORAGE_KEYS.REGISTRATION_TOKENS)).toBeUndefined();
    });
  }

  test('clearStorage forgets construction seeds before their first registration', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    const manager = await managerFor(agent, { persistTokens: false, registrationTokens: { [endpoint]: token } });
    await manager.disconnect({ clearStorage: true });
    await expect(manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })).rejects.toBeInstanceOf(DwnTenantRegistrationError);
    expect(register.called).toBe(false);
  });

  test('clearStorage drains a shared agent encrypted write before erasing it and allows fresh authorization', async (): Promise<void> => {
    const vault = new HdIdentityVault({ store: new MemoryStore(), keyDerivationWorkFactor: 1 });
    vault.didResolver = {
      resolve: async (): Promise<DidResolutionResult> =>
        ({ didDocument: null, didDocumentMetadata: {}, didResolutionMetadata: { error: 'notFound' } }),
      publish: async (): Promise<DidRegistrationResult> => ({ didDocumentMetadata: { published: true } }),
    };
    await vault.initialize({ password: 'test-password', dwnEndpoints: [endpoint] });
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    agent.agentDid = await vault.getDid();
    agent.vault = vault;
    agent.secrets = new VaultBackedSecretStore({ vault, store: new MemoryStore() });
    const entered = deferred<void>();
    const release = deferred<void>();
    const encrypt = vault.encryptData.bind(vault);
    sinon.stub(vault, 'encryptData').callsFake(async (params): Promise<string> => {
      entered.resolve();
      await release.promise;
      return encrypt(params);
    });
    const exchange = sinon.stub(DwnRegistrar, 'exchangeAuthCode');
    exchange.onFirstCall().resolves({ tokenType: 'Bearer', registrationToken: 'erased' });
    exchange.onSecondCall().resolves({ tokenType: 'Bearer', registrationToken: 'fresh' });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    const observe = sinon.spy();
    const eraser = await managerFor(agent);
    const manager = await managerFor(agent, {
      onProviderAuthRequired : async (params) => ({ code: 'code', state: params.state }),
      onRegistrationTokens   : observe,
    });
    const request = { dids: [agent.agentDid.uri], dwnEndpoints: [endpoint] };
    const pending = manager.registerDwnTenants(request).catch((error: unknown) => error);
    await entered.promise;
    let erased = false;
    const erasing = eraser.disconnect({ clearStorage: true }).then((): void => { erased = true; });
    try {
      await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
      expect(erased).toBe(false);
      release.resolve();
      await erasing;
      expect(await pending).toBeInstanceOf(Error);
      expect(await agent.secrets.get(STORAGE_KEYS.REGISTRATION_TOKENS)).toBeUndefined();
      expect(register.called || observe.called).toBe(false);
      expect((await manager.registerDwnTenants(request)).registered).toEqual([{ did: agent.agentDid.uri, endpoint }]);
      expect(register.calledOnceWithExactly(endpoint, agent.agentDid.uri, 'fresh')).toBe(true);
      expect(await getTokens(agent)).toEqual({ [endpoint]: { registrationToken: 'fresh', refreshUrl: 'https://provider.example/refresh' } });
      expect(exchange.calledTwice && observe.calledOnce).toBe(true);
    } finally {
      release.resolve();
      await Promise.all([pending, erasing]);
    }
  });

  test('a credential persistence callback can erase its own manager without deadlocking', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    await setTokens(agent, { [endpoint]: token });
    sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    const manager = await managerFor(agent, {
      onRegistrationTokens: async (): Promise<void> => { await manager.disconnect({ clearStorage: true }); },
    });
    await expect(manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })).rejects.toThrow('invalidated');
    expect(await agent.secrets.get(STORAGE_KEYS.REGISTRATION_TOKENS)).toBeUndefined();
  });

  test('does not open provider UI after invalidation while an encrypted read unwinds', async (): Promise<void> => {
    let discovered = false;
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => {
      discovered = true;
      return info(['provider-auth-v0']);
    } });
    const entered = deferred<void>();
    const release = deferred<void>();
    const ui = sinon.stub().callsFake(async (params) => ({ code: 'code', state: params.state }));
    const manager = await managerFor(agent, { onProviderAuthRequired: ui });
    sinon.stub(agent.secrets, 'get').callsFake(async (): Promise<undefined> => {
      if (discovered) { entered.resolve(); await release.promise; }
      return undefined;
    });
    const pending = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] }).catch((error: unknown) => error);
    await entered.promise;
    const locking = manager.lock();
    release.resolve();
    await locking;
    expect((await pending as Error).message).toContain('invalidated');
    expect(ui.called).toBe(false);
  });

  test('does not write credentials when invalidated during the encrypted commit read', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const entered = deferred<void>();
    const release = deferred<void>();
    let exchanged = false;
    sinon.stub(agent.secrets, 'get').callsFake(async (): Promise<undefined> => {
      if (exchanged) { entered.resolve(); await release.promise; }
      return undefined;
    });
    sinon.stub(DwnRegistrar, 'exchangeAuthCode').callsFake(async () => {
      exchanged = true;
      return { tokenType: 'Bearer', registrationToken: 'new' };
    });
    const writes = sinon.spy(agent.secrets, 'put');
    const manager = await managerFor(agent, { onProviderAuthRequired: async (params) => ({ code: 'code', state: params.state }) });
    const pending = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] }).catch((error: unknown) => error);
    await entered.promise;
    const locking = manager.lock();
    release.resolve();
    await locking;
    expect((await pending as Error).message).toContain('invalidated');
    expect(writes.called).toBe(false);
  });


  test('teardown completes while OAuth UI waits and prevents late exchange, writes and callbacks', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const started = deferred<void>();
    const release = deferred<void>();
    const exchange = sinon.stub(DwnRegistrar, 'exchangeAuthCode');
    const write = sinon.spy(agent.secrets, 'put');
    const observe = sinon.spy();
    const manager = await managerFor(agent, {
      onRegistrationTokens   : observe,
      onProviderAuthRequired : async (params) => {
        started.resolve();
        await release.promise;
        return { code: 'late-code', state: params.state };
      },
    });
    const pending = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] }).catch((failure: unknown) => failure);
    await started.promise;
    await manager.disconnect({ clearStorage: true });
    release.resolve();
    expect((await pending as Error).message).toContain('invalidated');
    expect(exchange.called || write.called || observe.called).toBe(false);
  });

  test('rechecks ownership after provider UI before registering a deleted identity', async (): Promise<void> => {
    let present = true;
    const agent = createMockAgent({
      identityGet      : async () => present ? createMockIdentity() : undefined,
      rpcGetServerInfo : async (): Promise<ServerInfo> => info(['provider-auth-v0']),
    });
    sinon.stub(DwnRegistrar, 'exchangeAuthCode').resolves({ tokenType: 'Bearer', registrationToken: 'new' });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken');
    const manager = await managerFor(agent, {
      onProviderAuthRequired: async (params) => { present = false; return { code: 'code', state: params.state }; },
    });
    await expect(manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })).rejects.toBeInstanceOf(DwnTenantRegistrationError);
    expect(register.called).toBe(false);
  });

  test('stops before tenant registration if saving rotated credentials fails', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    sinon.stub(DwnRegistrar, 'exchangeAuthCode').resolves({ tokenType: 'Bearer', registrationToken: 'new' });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken');
    sinon.stub(agent.secrets, 'put').rejects(new Error('disk unavailable'));
    const manager = await managerFor(agent, {
      onProviderAuthRequired: async (params) => ({ code: 'code', state: params.state }),
    });
    await expect(manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })).rejects.toThrow('credentials');
    expect(register.called).toBe(false);
  });

  test('a rejected vault connection cancels pending registration at other endpoints', async (): Promise<void> => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const agent = createMockAgent({
      firstLaunch             : async (): Promise<boolean> => true,
      identityGetDwnEndpoints : async (): Promise<string[]> => [endpoint, secondEndpoint],
      rpcGetServerInfo        : async (): Promise<ServerInfo> => info(['provider-auth-v0']),
    });
    const exchange = sinon.stub(DwnRegistrar, 'exchangeAuthCode').callsFake(async (_url, code) => ({
      tokenType: 'Bearer', registrationToken: code,
    }));
    const write = sinon.stub(agent.secrets, 'put').resolves();
    write.onFirstCall().rejects(new Error('disk unavailable'));
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    const manager = await managerFor(agent, {
      onProviderAuthRequired: async (params) => {
        if (params.dwnEndpoint === secondEndpoint) {
          entered.resolve();
          await release.promise;
        } else {
          await entered.promise;
        }
        return { code: params.dwnEndpoint, state: params.state };
      },
    });
    try {
      await expect(manager.connectVault({ password: 'test-password', sync: 'off' })).rejects.toThrow('credentials');
      expect(write.callCount).toBe(1);
      release.resolve();
      // Drain the released approval's continuations before checking for abandoned work.
      await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
      expect(exchange.args.map((args) => args[1])).toEqual([endpoint]);
      expect(write.callCount).toBe(1);
      expect(register.called).toBe(false);
    } finally {
      release.resolve();
      await manager.shutdown();
    }
  });

  test('releases failed tenant flights so an explicit retry can succeed', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info() });
    const register = sinon.stub(DwnRegistrar, 'registerTenant');
    register.onFirstCall().rejects(new Error('temporary network failure'));
    register.onSecondCall().resolves();
    const manager = await managerFor(agent);
    const request = { dids: [ownerDid], dwnEndpoints: [endpoint] };
    await expect(manager.registerDwnTenants(request)).rejects.toBeInstanceOf(DwnTenantRegistrationError);
    expect((await manager.registerDwnTenants(request)).failed).toEqual([]);
    expect(register.callCount).toBe(2);
  });

  test('coalesces provider authorization shared by concurrent owner registrations', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const entered = deferred<void>();
    const release = deferred<void>();
    let authorizationCount = 0;
    const exchange = sinon.stub(DwnRegistrar, 'exchangeAuthCode').resolves({ tokenType: 'Bearer', registrationToken: 'shared' });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    const manager = await managerFor(agent, {
      onProviderAuthRequired: async (params) => {
        authorizationCount++;
        entered.resolve();
        await release.promise;
        return { code: 'code', state: params.state };
      },
    });
    const first = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
    await entered.promise;
    const second = manager.registerDwnTenants({ dids: [agent.agentDid.uri], dwnEndpoints: [endpoint] });
    release.resolve();
    await Promise.all([first, second]);
    expect(authorizationCount).toBe(1);
    expect(exchange.callCount).toBe(1);
    expect(register.callCount).toBe(2);
  });

  for (const stage of ['exchange', 'refresh', 'tenant'] as const) {
    test(`lock completes while ${stage} HTTP is pending and prevents late token writes and callbacks`, async (): Promise<void> => {
      const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
      if (stage === 'refresh') {
        await setTokens(agent, { [endpoint]: { ...token, expiresAt: 0, refreshToken: 'old', refreshUrl: 'https://provider.example/refresh' } });
      }
      const entered = deferred<void>();
      const release = deferred<void>();
      const pendingToken = async (): Promise<{ tokenType: string; registrationToken: string }> => {
        entered.resolve();
        await release.promise;
        return { tokenType: 'Bearer', registrationToken: 'late' };
      };
      const exchange = sinon.stub(DwnRegistrar, 'exchangeAuthCode');
      if (stage === 'exchange') { exchange.callsFake(pendingToken); } else { exchange.resolves({ tokenType: 'Bearer', registrationToken: 'new' }); }
      const refresh = sinon.stub(DwnRegistrar, 'refreshRegistrationToken');
      if (stage === 'refresh') { refresh.callsFake(pendingToken); }
      const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken');
      if (stage === 'tenant') {
        register.callsFake(async (): Promise<void> => { entered.resolve(); await release.promise; });
      }
      const writes = sinon.spy(agent.secrets, 'put');
      const observe = sinon.spy();
      const manager = await managerFor(agent, {
        onProviderAuthRequired : async (params) => ({ code: 'code', state: params.state }),
        onRegistrationTokens   : observe,
      });
      const pending = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] }).catch((failure: unknown) => failure);
      await entered.promise;
      const writesBeforeLock = writes.callCount;
      await manager.lock();
      expect(manager.state).toBe('locked');
      release.resolve();
      expect((await pending as Error).message).toContain('invalidated');
      expect(writes.callCount).toBe(writesBeforeLock);
      expect(observe.called).toBe(false);
      expect(register.callCount).toBe(stage === 'tenant' ? 1 : 0);
    });
  }

  test('session replacement invalidates pending authorization even without a generation change', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const entered = deferred<void>();
    const release = deferred<void>();
    const exchange = sinon.stub(DwnRegistrar, 'exchangeAuthCode');
    const manager = await managerFor(agent, {
      onProviderAuthRequired: async (params) => {
        entered.resolve();
        await release.promise;
        return { code: 'code', state: params.state };
      },
    });
    const pending = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] }).catch((failure: unknown) => failure);
    await entered.promise;
    await manager.connectVault({ password: 'test-password', sync: 'off' });
    release.resolve();
    expect((await pending as Error).message).toContain('invalidated');
    expect(exchange.called).toBe(false);
    await manager.disconnect();
  });


  test('handles a rejected HTTP response abandoned by teardown during dispatch', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const response = deferred<{ tokenType: string; registrationToken: string }>();
    let teardown: Promise<void> | undefined;
    sinon.stub(DwnRegistrar, 'exchangeAuthCode').callsFake(() => {
      teardown = manager.lock();
      return response.promise;
    });
    const writes = sinon.spy(agent.secrets, 'put');
    const manager = await managerFor(agent, {
      onProviderAuthRequired: async (params) => ({ code: 'code', state: params.state }),
    });
    const failure = await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })
      .catch((error: unknown) => error);
    expect((failure as Error).message).toContain('invalidated');
    await teardown;
    response.reject(new Error('remote response failed after teardown'));
    await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
    expect(writes.called).toBe(false);
  });


  test('identity creation rejects registration failure without committing a session', async (): Promise<void> => {
    let created = false;
    const identity = createMockIdentity();
    const agent = createMockAgent({
      identityList     : async () => created ? [identity] : [],
      identityCreate   : async () => { created = true; return identity; },
      rpcGetServerInfo : async () => { throw new Error('registration endpoint offline'); },
    });
    const storage = new MemoryStorage();
    const manager = await managerFor(agent, {}, storage);
    await expect(manager.connectVault({ password: 'test-password', sync: 'off', createIdentity: true }))
      .rejects.toBeInstanceOf(DwnTenantRegistrationError);
    expect(created).toBe(true);
    expect(manager.session).toBeUndefined();
    expect(manager.state).toBe('unlocked');
    expect(await storage.get(STORAGE_KEYS.SESSION)).toBeNull();
  });

  test('coalesced partial failures report refreshed caller-managed credentials to every observer', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const entered = deferred<void>();
    const release = deferred<void>();
    sinon.stub(DwnRegistrar, 'refreshRegistrationToken').resolves({ tokenType: 'Bearer', registrationToken: 'new', refreshToken: 'rotated' });
    const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken').callsFake(async (): Promise<void> => {
      entered.resolve();
      await release.promise;
      throw new Error('tenant quota exceeded');
    });
    const observed: Array<Record<string, RegistrationTokenData>> = [];
    const manager = await managerFor(agent, {
      persistTokens        : false,
      registrationTokens   : { [endpoint]: { ...token, expiresAt: 0, refreshToken: 'old', refreshUrl: 'https://provider.example/refresh' } },
      onRegistrationTokens : (tokens): void => { observed.push(tokens); },
    });
    const request = { dids: [ownerDid], dwnEndpoints: [endpoint] };
    const first = manager.registerDwnTenants(request).catch((error: unknown) => error);
    await entered.promise;
    const second = manager.registerDwnTenants(request).catch((error: unknown) => error);
    release.resolve();
    const failures = await Promise.all([first, second]);
    expect(failures.every((error): boolean => error instanceof DwnTenantRegistrationError)).toBe(true);
    expect(register.callCount).toBe(1);
    expect(observed).toHaveLength(2);
    expect(observed.map((tokens): string | undefined => tokens[endpoint].refreshToken)).toEqual(['rotated', 'rotated']);
  });


  test('reserves overlapping pair flights before asynchronous endpoint discovery begins', async (): Promise<void> => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let infoRequests = 0;
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => {
      infoRequests++;
      entered.resolve();
      await release.promise;
      return info();
    } });
    const register = sinon.stub(DwnRegistrar, 'registerTenant').resolves();
    const manager = await managerFor(agent);
    const request = { dids: [ownerDid], dwnEndpoints: [endpoint] };
    const first = manager.registerDwnTenants(request);
    const second = manager.registerDwnTenants(request);
    await entered.promise;
    release.resolve();
    await Promise.all([first, second]);
    expect(infoRequests).toBe(1);
    expect(register.callCount).toBe(1);
  });

  for (const shareFailingPair of [false, true]) {
    test(`joining a manual-persistence ${shareFailingPair ? 'failed pair' : 'token refresh'} honors encrypted persistence`, async (): Promise<void> => {
      const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
      const entered = deferred<void>();
      const release = deferred<void>();
      const refreshed = { tokenType: 'Bearer', registrationToken: 'rotated', refreshToken: 'new-refresh' };
      const refresh = sinon.stub(DwnRegistrar, 'refreshRegistrationToken');
      const register = sinon.stub(DwnRegistrar, 'registerTenantWithToken');
      if (shareFailingPair) {
        refresh.resolves(refreshed);
        register.callsFake(async (): Promise<void> => { entered.resolve(); await release.promise; throw new Error('quota'); });
      } else {
        refresh.callsFake(async () => { entered.resolve(); await release.promise; return refreshed; });
        register.resolves();
      }
      const manual = await managerFor(agent, {
        persistTokens      : false,
        registrationTokens : { [endpoint]: { ...token, expiresAt: 0, refreshToken: 'old', refreshUrl: 'https://provider.example/refresh' } },
      });
      const encrypted = await managerFor(agent);
      const first = manual.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] }).catch((error: unknown) => error);
      await entered.promise;
      const second = encrypted.registerDwnTenants({ dids: [shareFailingPair ? ownerDid : agent.agentDid.uri], dwnEndpoints: [endpoint] })
        .catch((error: unknown) => error);
      // Let the joining request finish its local preflight while HTTP stays pending.
      await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
      release.resolve();
      const outcomes = await Promise.all([first, second]);
      expect(outcomes.every((outcome): boolean => (outcome instanceof DwnTenantRegistrationError) === shareFailingPair)).toBe(true);
      expect((await getTokens(agent))[endpoint]).toMatchObject({ registrationToken: 'rotated', refreshToken: 'new-refresh' });
      expect(refresh.callCount).toBe(1);
      expect(register.callCount).toBe(shareFailingPair ? 1 : 2);
    });
  }

  test('awaits caller-owned credential persistence and propagates its failure', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const rotated = { registrationToken: 'rotated-token', refreshToken: 'rotated-refresh' };
    const refresh = sinon.stub(DwnRegistrar, 'refreshRegistrationToken').resolves({ tokenType: 'Bearer', ...rotated });
    sinon.stub(DwnRegistrar, 'registerTenantWithToken').resolves();
    const started = deferred<void>();
    const release = deferred<void>();
    const persistenceError = new Error('caller token store unavailable');
    const observed: Array<Record<string, RegistrationTokenData>> = [];
    let rejectPersistence = true;
    const manager = await managerFor(agent, {
      persistTokens        : false,
      registrationTokens   : { [endpoint]: { ...token, expiresAt: 0, refreshToken: 'old', refreshUrl: 'https://provider.example/refresh' } },
      onRegistrationTokens : async (tokens): Promise<void> => {
        observed.push(tokens);
        if (rejectPersistence) {
          started.resolve();
          await release.promise;
          throw persistenceError;
        }
      },
    });
    let settled = false;
    const pending = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })
      .then((): void => { settled = true; }, (error: unknown) => { settled = true; return error; });
    await started.promise;
    expect(settled).toBe(false);
    expect(observed[0][endpoint]).toMatchObject(rotated);
    release.resolve();
    expect(await pending).toBe(persistenceError);
    rejectPersistence = false;
    expect((await manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] })).failed).toEqual([]);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(observed[0]);
    expect(refresh.calledOnce).toBe(true);
  });

  test('keeps rotated refresh credentials when an older persistence callback is pending', async (): Promise<void> => {
    let now = Date.now();
    sinon.stub(Date, 'now').callsFake((): number => now);
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info(['provider-auth-v0']) });
    const entered = deferred<void>();
    const release = deferred<void>();
    const rotatedRegistered = deferred<void>();
    const initial = { registrationToken: 'T1', refreshToken: 'R1', refreshUrl: 'https://provider.example/refresh', expiresAt: now + 100 };
    let persisted: Record<string, RegistrationTokenData> = {};
    sinon.stub(DwnRegistrar, 'refreshRegistrationToken').resolves({
      tokenType: 'Bearer', registrationToken: 'T2', refreshToken: 'R2', expiresIn: 3_600,
    });
    sinon.stub(DwnRegistrar, 'registerTenantWithToken').callsFake(async (_endpoint, _did, credential): Promise<void> => {
      if (credential === 'T2') { rotatedRegistered.resolve(); }
    });
    const manager = await managerFor(agent, {
      persistTokens        : false,
      registrationTokens   : { [endpoint]: initial },
      onRegistrationTokens : async (tokens): Promise<void> => {
        if (tokens[endpoint].refreshToken === 'R1') {
          entered.resolve();
          await release.promise;
        }
        persisted = tokens;
      },
    });
    const first = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
    await entered.promise;
    now += 1_000;
    const second = manager.registerDwnTenants({ dids: [agent.agentDid.uri], dwnEndpoints: [endpoint] });
    await rotatedRegistered.promise;
    // Finish runnable registration continuations while the earlier persistence remains blocked.
    await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
    release.resolve();
    await Promise.all([first, second]);
    expect(persisted[endpoint]).toMatchObject({ registrationToken: 'T2', refreshToken: 'R2' });
  });


  test('lock cancels native PoW registration before a registration POST', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info() });
    const entered = deferred<void>();
    const release = deferred<void>();
    const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (url): Promise<Response> => {
      const address = String(url);
      if (address.endsWith('terms-of-service')) { return new Response('Terms of service'); }
      if (address.endsWith('proof-of-work')) {
        return Response.json({ challengeNonce: 'challenge', maximumAllowedHashValue: 'f'.repeat(64) });
      }
      throw new Error('Registration POST must not be dispatched after lock.');
    });
    sinon.stub(DwnRegistrar, 'generateNonce').callsFake(async (): Promise<string> => {
      entered.resolve();
      await release.promise;
      return '0'.repeat(64);
    });
    const manager = await managerFor(agent);
    const pending = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] }).catch((error: unknown) => error);
    await entered.promise;
    await manager.lock();
    release.resolve();
    expect((await pending as Error).message).toContain('invalidated');
    expect(fetch.callCount).toBe(2);
    expect(fetch.args.every(([, init]): boolean => init?.method !== 'POST')).toBe(true);
  });

  test('clearStorage cancels another manager\'s native PoW registration on the same agent', async (): Promise<void> => {
    const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info() });
    const entered = deferred<void>();
    const release = deferred<void>();
    const fetch = sinon.stub(globalThis, 'fetch').callsFake(async (url): Promise<Response> => {
      if (String(url).endsWith('proof-of-work')) {
        return Response.json({ challengeNonce: 'challenge', maximumAllowedHashValue: 'f'.repeat(64) });
      }
      return new Response('Terms of service');
    });
    const generateNonce = DwnRegistrar.generateNonce.bind(DwnRegistrar);
    sinon.stub(DwnRegistrar, 'generateNonce').callsFake(async (): Promise<string> => {
      entered.resolve();
      await release.promise;
      return generateNonce();
    });
    const manager = await managerFor(agent);
    const eraser = await managerFor(agent);
    const pending = manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] }).catch((error: unknown) => error);
    await entered.promise;
    try {
      await eraser.disconnect({ clearStorage: true });
    } finally {
      release.resolve();
    }
    expect(await pending).toBeInstanceOf(Error);
    expect(fetch.callCount).toBe(2);
    expect(fetch.args.every(([, init]): boolean => init?.method !== 'POST')).toBe(true);
  });

  for (const invalidFirst of [true, false]) {
    test(`an invalid batch cannot poison a valid overlapping request (${invalidFirst ? 'invalid' : 'valid'} first)`, async (): Promise<void> => {
      const agent = createMockAgent({ rpcGetServerInfo: async (): Promise<ServerInfo> => info() });
      const register = sinon.stub(DwnRegistrar, 'registerTenant').resolves();
      const manager = await managerFor(agent);
      const invalidRequest = (): Promise<unknown> => manager.registerDwnTenants({
        dids: [ownerDid, 'did:dht:foreign'], dwnEndpoints: [endpoint],
      }).catch((error: unknown) => error);
      const validRequest = (): Promise<unknown> => manager.registerDwnTenants({ dids: [ownerDid], dwnEndpoints: [endpoint] });
      const first = invalidFirst ? invalidRequest() : validRequest();
      const second = invalidFirst ? validRequest() : invalidRequest();
      const outcomes = await Promise.all([first, second]);
      const invalid = outcomes[invalidFirst ? 0 : 1];
      const valid = outcomes[invalidFirst ? 1 : 0];
      expect((invalid as Error).message).toContain('locally managed owner DID');
      expect(valid).toEqual({ registered: [{ did: ownerDid, endpoint }], failed: [] });
      expect(register.callCount).toBe(1);
      expect(register.firstCall.args.slice(0, 2)).toEqual([endpoint, ownerDid]);
    });
  }

});
