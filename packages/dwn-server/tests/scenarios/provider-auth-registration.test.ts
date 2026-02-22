import type { DwnServerConfig } from '../../src/config.js';
import type { Persona } from '@enbox/dwn-sdk-js';
import type { RegistrationManager } from '../../src/registration/registration-manager.js';
import type { JsonRpcRequest, JsonRpcResponse, RegistrationData, RegistrationRequest, ServerInfo } from '@enbox/dwn-clients';
import type { ProviderAuthPlugin, ProviderAuthValidationResult } from '../../src/registration/provider-auth-plugin.js';

import { config } from '../../src/config.js';
import { createJsonRpcRequest } from '@enbox/dwn-clients';
import { createRecordsWriteMessage } from '../utils.js';
import { DwnServer } from '../../src/dwn-server.js';
import { DwnServerErrorCode } from '../../src/dwn-error.js';
import { ProofOfWork } from '../../src/registration/proof-of-work.js';
import { useFakeTimers } from 'sinon';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, Jws, ProtocolsConfigure, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { DidDht, DidKey, UniversalResolver } from '@enbox/dids';

/**
 * In-memory mock ProviderAuthPlugin for testing.
 * Accepts any token starting with 'valid-' and returns an account ID derived from the token.
 */
class MockProviderAuthPlugin implements ProviderAuthPlugin {
  public async validateRegistrationToken(token: string): Promise<ProviderAuthValidationResult> {
    if (token.startsWith('valid-')) {
      return {
        isValid   : true,
        accountId : `acct-${token.slice(6)}`, // e.g. 'valid-alice' → 'acct-alice'
        metadata  : { tier: 'paid' },
      };
    }

    return {
      isValid : false,
      detail  : `Invalid token: ${token}`,
    };
  }
}

describe('Provider auth registration scenarios', () => {
  let dwnMessageEndpoint: string;
  let registrationEndpoint: string;
  let infoEndpoint: string;

  let alice: Persona;
  let registrationManager: RegistrationManager;
  let clock: ReturnType<typeof useFakeTimers>;
  let dwnServer: DwnServer;
  const dwnServerConfig: DwnServerConfig = { ...config, port: 0 };

  beforeAll(async () => {
    clock = useFakeTimers({ shouldAdvanceTime: true });

    alice = await TestDataGenerator.generateDidKeyPersona();

    // SQLite in-memory to avoid LevelDB conflicts.
    dwnServerConfig.messageStore = 'sqlite://';
    dwnServerConfig.dataStore = 'sqlite://';
    dwnServerConfig.resumableTaskStore = 'sqlite://';
    dwnServerConfig.stateIndex = 'sqlite://';
    dwnServerConfig.packageJsonPath = './package.json';

    // Registration config — enable both PoW and provider auth.
    dwnServerConfig.registrationStoreUrl = 'sqlite://';
    dwnServerConfig.registrationProofOfWorkEnabled = true;
    dwnServerConfig.termsOfServiceFilePath = './tests/fixtures/terms-of-service.txt';
    dwnServerConfig.registrationProofOfWorkInitialMaxHash =
      '0FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';

    // Provider auth config.
    dwnServerConfig.providerAuthEnabled = true;
    dwnServerConfig.providerAuthAuthorizeUrl = 'https://auth.example.com/authorize';
    dwnServerConfig.providerAuthTokenUrl = 'https://auth.example.com/token';
    dwnServerConfig.providerAuthRefreshUrl = 'https://auth.example.com/refresh';
    dwnServerConfig.providerAuthManagementUrl = 'https://auth.example.com/manage';

    // Also update the global config singleton (used by HttpApi#handleInfo).
    config.providerAuthEnabled = true;
    config.providerAuthAuthorizeUrl = 'https://auth.example.com/authorize';
    config.providerAuthTokenUrl = 'https://auth.example.com/token';
    config.providerAuthRefreshUrl = 'https://auth.example.com/refresh';
    config.providerAuthManagementUrl = 'https://auth.example.com/manage';
    config.registrationProofOfWorkEnabled = true;
    config.termsOfServiceFilePath = './tests/fixtures/terms-of-service.txt';

    // Avoid LevelDB cache conflicts.
    const didResolver = new UniversalResolver({
      didResolvers: [DidDht, DidKey],
    });

    dwnServer = new DwnServer({ config: dwnServerConfig, didResolver });

    // Inject the mock plugin before starting the server.
    // We need to access the private registrationManager after it's created by start(),
    // but the plugin is loaded via config during start(). Since we can't easily provide
    // a plugin path to an in-memory class, we'll hook into the flow by starting the
    // server and then injecting the plugin directly.
    await dwnServer.start();
    registrationManager = dwnServer.registrationManager;

    // Inject mock provider auth plugin directly.
    registrationManager['providerAuthPlugin'] = new MockProviderAuthPlugin();

    const baseUrl = `http://localhost:${dwnServer.httpServer.port}`;
    dwnMessageEndpoint = baseUrl;
    registrationEndpoint = `${baseUrl}/registration`;
    infoEndpoint = `${baseUrl}/info`;
  });

  afterAll(async () => {
    clock.restore();
  });

  it('should include provider-auth-v0 in /info registrationRequirements and providerAuth URLs', async () => {
    const response = await fetch(infoEndpoint);
    expect(response.status).toBe(200);

    const serverInfo = await response.json() as ServerInfo;
    expect(serverInfo.registrationRequirements).toContain('provider-auth-v0');
    expect(serverInfo.registrationRequirements).toContain('proof-of-work-sha256-v0');
    expect(serverInfo.providerAuth).toBeDefined();
    expect(serverInfo.providerAuth!.authorizeUrl).toBe('https://auth.example.com/authorize');
    expect(serverInfo.providerAuth!.tokenUrl).toBe('https://auth.example.com/token');
    expect(serverInfo.providerAuth!.refreshUrl).toBe('https://auth.example.com/refresh');
    expect(serverInfo.providerAuth!.managementUrl).toBe('https://auth.example.com/manage');
  });

  it('should register a tenant with a valid provider auth token', async () => {
    // 1. Alice sends a registration request with a valid provider auth token and ToS hash.
    const registrationRequest: RegistrationRequest = {
      registrationData: {
        did                : alice.did,
        termsOfServiceHash : registrationManager.getTermsOfServiceHash(),
      },
      providerAuth: { registrationToken: 'valid-alice' },
    };

    const response = await fetch(registrationEndpoint, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(registrationRequest),
    });
    expect(response.status).toBe(200);

    // 2. Alice can now write to the DWN.
    await installDefaultTestProtocolViaHttp(dwnMessageEndpoint, alice);
    const { jsonRpcRequest, dataBytes } = await generateRecordsWriteJsonRpcRequest(alice);
    const writeResponse = await fetch(dwnMessageEndpoint, {
      method  : 'POST',
      headers : { 'dwn-request': JSON.stringify(jsonRpcRequest) },
      body    : new Blob([dataBytes]),
    });
    const writeBody = await writeResponse.json() as JsonRpcResponse;
    expect(writeResponse.status).toBe(200);
    expect(writeBody.result.reply.status.code).toBe(202);
  });

  it('should register a second DID under the same account using the same token', async () => {
    const bob = await TestDataGenerator.generateDidKeyPersona();

    // Register Bob with the same token (reuse for multi-DID accounts).
    const registrationRequest: RegistrationRequest = {
      registrationData: {
        did                : bob.did,
        termsOfServiceHash : registrationManager.getTermsOfServiceHash(),
      },
      providerAuth: { registrationToken: 'valid-alice' },
    };

    const response = await fetch(registrationEndpoint, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(registrationRequest),
    });
    expect(response.status).toBe(200);

    // Verify both Alice and Bob are under the same account.
    const store = registrationManager.getRegistrationStore()!;
    const tenants = await store.getTenantsForAccount('acct-alice');
    const dids = tenants.map((t) => t.did);
    expect(dids).toContain(alice.did);
    expect(dids).toContain(bob.did);
  });

  it('should reject a registration request with an invalid provider auth token', async () => {
    const carol = await TestDataGenerator.generateDidKeyPersona();

    const registrationRequest: RegistrationRequest = {
      registrationData : { did: carol.did },
      providerAuth     : { registrationToken: 'bad-token' },
    };

    const response = await fetch(registrationEndpoint, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(registrationRequest),
    });
    const body = await response.json() as any;
    expect(response.status).toBe(400);
    expect(body.code).toBe(DwnServerErrorCode.ProviderAuthTokenInvalid);
    expect(body.message).toContain('Invalid token');
  });

  it('should reject a registration request with neither providerAuth nor proofOfWork', async () => {
    const dan = await TestDataGenerator.generateDidKeyPersona();

    const registrationRequest: RegistrationRequest = {
      registrationData: { did: dan.did },
    };

    const response = await fetch(registrationEndpoint, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(registrationRequest),
    });
    const body = await response.json() as any;
    expect(response.status).toBe(400);
    expect(body.code).toBe(DwnServerErrorCode.RegistrationRequestMissingCredentials);
  });

  it('should accept provider auth with ToS hash when server has ToS configured', async () => {
    const eve = await TestDataGenerator.generateDidKeyPersona();
    const tosHash = registrationManager.getTermsOfServiceHash()!;

    const registrationRequest: RegistrationRequest = {
      registrationData: {
        did                : eve.did,
        termsOfServiceHash : tosHash,
      },
      providerAuth: { registrationToken: 'valid-eve' },
    };

    const response = await fetch(registrationEndpoint, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(registrationRequest),
    });
    expect(response.status).toBe(200);
  });

  it('should reject provider auth with wrong ToS hash when both server and request have a hash', async () => {
    const frank = await TestDataGenerator.generateDidKeyPersona();

    const registrationRequest: RegistrationRequest = {
      registrationData: {
        did                : frank.did,
        termsOfServiceHash : 'wrong-hash',
      },
      providerAuth: { registrationToken: 'valid-frank' },
    };

    const response = await fetch(registrationEndpoint, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(registrationRequest),
    });
    const body = await response.json() as any;
    expect(response.status).toBe(400);
    expect(body.code).toBe(DwnServerErrorCode.RegistrationManagerInvalidOrOutdatedTermsOfServiceHash);
  });

  it('should accept provider auth without ToS hash even when server has ToS configured', async () => {
    // Provider auth does not require ToS if the client omits the hash.
    const grace = await TestDataGenerator.generateDidKeyPersona();

    const registrationRequest: RegistrationRequest = {
      registrationData : { did: grace.did },
      providerAuth     : { registrationToken: 'valid-grace' },
    };

    const response = await fetch(registrationEndpoint, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(registrationRequest),
    });
    expect(response.status).toBe(200);
  });

  it('should store provider-auth registration metadata in the registration store', async () => {
    const heidi = await TestDataGenerator.generateDidKeyPersona();

    const registrationRequest: RegistrationRequest = {
      registrationData : { did: heidi.did },
      providerAuth     : { registrationToken: 'valid-heidi' },
    };

    await fetch(registrationEndpoint, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(registrationRequest),
    });

    const store = registrationManager.getRegistrationStore()!;
    const tenant = await store.getTenantRegistration(heidi.did);
    expect(tenant).toBeDefined();
    expect(tenant!.accountId).toBe('acct-heidi');
    expect(tenant!.registrationType).toBe('provider-auth');
    expect(tenant!.registeredAt).toBeDefined();

    const metadata = JSON.parse(tenant!.metadata!);
    expect(metadata.tier).toBe('paid');
  });

  it('should reject provider auth when the plugin is removed (simulating ProviderAuthNotEnabled)', async () => {
    const ivan = await TestDataGenerator.generateDidKeyPersona();

    // Temporarily remove the plugin.
    const originalPlugin = registrationManager['providerAuthPlugin'];
    registrationManager['providerAuthPlugin'] = undefined;

    const registrationRequest: RegistrationRequest = {
      registrationData : { did: ivan.did },
      providerAuth     : { registrationToken: 'valid-ivan' },
    };

    const response = await fetch(registrationEndpoint, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(registrationRequest),
    });
    const body = await response.json() as any;
    expect(response.status).toBe(400);
    expect(body.code).toBe(DwnServerErrorCode.ProviderAuthNotEnabled);

    // Restore the plugin.
    registrationManager['providerAuthPlugin'] = originalPlugin;
  });

  it('should allow PoW registration to coexist with provider auth (freemium model)', async () => {
    // PoW registration should still work when provider auth is also enabled.
    const julia = await TestDataGenerator.generateDidKeyPersona();
    const termsOfService = registrationManager.getTermsOfService()!;
    const { challengeNonce, maximumAllowedHashValue } = registrationManager.getProofOfWorkChallenge();

    const registrationData: RegistrationData = {
      did                : julia.did,
      termsOfServiceHash : ProofOfWork.hashAsHexString([termsOfService]),
    };

    const responseNonce = ProofOfWork.findQualifiedResponseNonce({
      challengeNonce,
      maximumAllowedHashValue,
      requestData: JSON.stringify(registrationData),
    });

    const registrationRequest: RegistrationRequest = {
      registrationData,
      proofOfWork: {
        challengeNonce,
        responseNonce,
      },
    };

    const response = await fetch(registrationEndpoint, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(registrationRequest),
    });
    expect(response.status).toBe(200);

    // Verify it was stored as proof-of-work type.
    const store = registrationManager.getRegistrationStore()!;
    const tenant = await store.getTenantRegistration(julia.did);
    expect(tenant).toBeDefined();
    expect(tenant!.registrationType).toBe('proof-of-work');
  });

  it('should not allow a non-tenant to write to the DWN', async () => {
    const nonTenant = await TestDataGenerator.generateDidKeyPersona();
    const { jsonRpcRequest, dataBytes } = await generateRecordsWriteJsonRpcRequest(nonTenant);
    const response = await fetch(dwnMessageEndpoint, {
      method  : 'POST',
      headers : { 'dwn-request': JSON.stringify(jsonRpcRequest) },
      body    : new Blob([dataBytes]),
    });
    const body = await response.json() as JsonRpcResponse;
    expect(response.status).toBe(200);
    expect(body.result.reply.status.code).toBe(401);
    expect(body.result.reply.status.detail).toBe('Not a registered tenant.');
  });
});

// ---------------------------------------------------------------------------
// Helpers (same as registration.test.ts)
// ---------------------------------------------------------------------------

async function installDefaultTestProtocolViaHttp(endpoint: string, persona: Persona): Promise<void> {
  const protocolsConfigure = await ProtocolsConfigure.create({
    definition: {
      protocol  : 'http://test-protocol.xyz',
      published : false,
      types     : { testRecord: {} },
      structure : { testRecord: {} },
    },
    signer: Jws.createSigner(persona),
  });

  const requestId = uuidv4();
  const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
    message : protocolsConfigure.toJSON(),
    target  : persona.did,
  });

  const response = await fetch(endpoint, {
    method  : 'POST',
    headers : { 'dwn-request': JSON.stringify(jsonRpcRequest) },
  });
  const responseBody = await response.json() as JsonRpcResponse;
  const { code, detail } = responseBody.result.reply.status;
  if (code !== 202) {
    throw new Error(`Failed to install default test protocol via HTTP: ${code} ${detail}`);
  }
}

async function generateRecordsWriteJsonRpcRequest(persona: Persona): Promise<{
  jsonRpcRequest: JsonRpcRequest;
  dataBytes: Uint8Array;
}> {
  const { recordsWrite, dataStream } = await createRecordsWriteMessage(persona);

  const requestId = uuidv4();
  const jsonRpcRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
    message : recordsWrite.toJSON(),
    target  : persona.did,
  });

  const dataBytes = await DataStream.toBytes(dataStream);
  return { jsonRpcRequest, dataBytes };
}
