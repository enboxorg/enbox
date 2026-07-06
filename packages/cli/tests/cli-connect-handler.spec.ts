import type { AddressInfo } from 'node:net';
import type { ConnectPermissionRequest, DwnPermissionScope } from '@enbox/agent';
import type { ConnectResult, WalletConnectClientOptions } from '@enbox/auth';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import sinon from 'sinon';

import { Convert } from '@enbox/common';
import { createServer } from 'node:http';
import { DidJwk } from '@enbox/dids';
import { EnboxConnectProtocol } from '@enbox/agent';
import { WalletConnect } from '@enbox/auth';
import { afterEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { CliConnectHandler, DEFAULT_CLI_WALLET_URL } from '../src/cli-connect-handler.js';

const delegateDid = 'did:jwk:delegate';
const connectedDid = 'did:dht:owner';
const requestedScope: DwnPermissionScope = {
  interface : DwnInterfaceName.Records,
  method    : DwnMethodName.Write,
  protocol  : 'https://example.com/protocols/notes',
};
const permissionRequests: ConnectPermissionRequest[] = [{
  protocolDefinition: {
    published : true,
    protocol  : 'https://example.com/protocols/notes',
    types     : {},
    structure : {},
  },
  permissionScopes: [requestedScope],
}];

describe('CliConnectHandler', () => {
  afterEach((): void => {
    sinon.restore();
  });

  it('should complete an approved relay flow and validate the returned grants', async () => {
    let capturedOptions: WalletConnectClientOptions | undefined;
    const result = createConnectResult([createGrant({ scope: requestedScope })]);
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      capturedOptions = options;
      await options.onWalletUriReady('https://wallet.example/connect/app?request_uri=urn:test&encryption_key=test');
      expect(await options.validatePin()).toBe('428113');
      return result;
    });

    const output = createWritableBuffer();
    const authUrls: string[] = [];
    const handler = CliConnectHandler({
      appName                    : 'Test CLI',
      walletUrl                  : 'https://wallet.example',
      connectServerUrl           : 'https://relay.example/connect',
      output,
      onAuthUrl                  : (uri: string): void => { authUrls.push(uri); },
      pinPrompt                  : async (): Promise<string> => '428113',
      qrRenderer                 : async (): Promise<string> => '[qr]',
      timeoutMs                  : 10_000,
      requestedSessionTtlSeconds : 2_592_000,
    });

    const connectResult = await handler.requestAccess({ permissionRequests });

    expect(connectResult).toBe(result);
    expect(capturedOptions?.displayName).toBe('Test CLI');
    expect(capturedOptions?.walletUri).toBe('https://wallet.example/connect/app');
    expect(capturedOptions?.connectServerUrl).toBe('https://relay.example/connect');
    expect(capturedOptions?.timeoutMs).toBe(10_000);
    expect(capturedOptions?.requestedSessionTtlSeconds).toBe(2_592_000);
    expect(authUrls).toEqual(['https://wallet.example/connect/app?request_uri=urn:test&encryption_key=test']);
    expect(output.text()).toContain('[qr]');
    expect(output.text()).toContain('Waiting for approval...');
  });

  it('should complete through an encrypted relay stub and consume relay artifacts once', async () => {
    const relay = await createTestRelay();
    let requestUri = '';
    let tokenUrl = '';

    try {
      const output = createWritableBuffer();
      const handler = CliConnectHandler({
        appName                    : 'Relay CLI',
        walletUrl                  : 'https://wallet.example/connect/app',
        connectServerUrl           : `${relay.url}/connect`,
        output,
        pinPrompt                  : async (): Promise<string> => '428113',
        qrRenderer                 : async (): Promise<string> => '[qr]',
        timeoutMs                  : 1000,
        pollIntervalMs             : 1,
        requestedSessionTtlSeconds : 2_592_000,
        onAuthUrl                  : async (uri: string): Promise<void> => {
          const walletUrl = new URL(uri);
          requestUri = getRequiredSearchParam(walletUrl, 'request_uri');
          const encryptionKey = getRequiredSearchParam(walletUrl, 'encryption_key');
          const connectRequest = await EnboxConnectProtocol.getConnectRequest(requestUri, encryptionKey);

          expect(connectRequest.appName).toBe('Relay CLI');
          expect(connectRequest.requestedSessionTtlSeconds).toBe(2_592_000);

          const delegateBearerDid = await DidJwk.create();
          const delegatePortableDid = await delegateBearerDid.export();
          const clientDidResolution = await DidJwk.resolve(connectRequest.clientDid);
          if (clientDidResolution?.didDocument === undefined) {
            throw new Error('test setup failed to resolve client DID');
          }

          const delegatePublicKeyJwk = delegateBearerDid.document.verificationMethod?.[0].publicKeyJwk;
          if (delegatePublicKeyJwk === undefined) {
            throw new Error('test setup failed to read delegate public key');
          }

          const sharedKey = await EnboxConnectProtocol.deriveSharedKey(delegateBearerDid, clientDidResolution.didDocument);
          const responseObject = await EnboxConnectProtocol.createConnectResponse({
            providerDid    : connectedDid,
            delegateDid    : delegateBearerDid.uri,
            aud            : connectRequest.clientDid,
            nonce          : connectRequest.nonce,
            delegateGrants : [createGrant({ grantee: delegateBearerDid.uri, scope: requestedScope })],
            delegatePortableDid,
          });
          const responseJwt = await EnboxConnectProtocol.signJwt({
            did  : delegateBearerDid,
            data : responseObject,
          });
          if (responseJwt === undefined) {
            throw new Error('test setup failed to sign connect response');
          }

          const encryptedResponse = await EnboxConnectProtocol.encryptResponse({
            jwt           : responseJwt,
            encryptionKey : sharedKey,
            delegatePublicKeyJwk,
            pin           : '428113',
          });

          const callbackResponse = await fetch(connectRequest.callbackUrl, {
            body    : new URLSearchParams({ id_token: encryptedResponse, state: connectRequest.state }).toString(),
            method  : 'POST',
            headers : { 'Content-Type': 'application/x-www-form-urlencoded' },
          });
          expect(callbackResponse.status).toBe(200);
          tokenUrl = `${relay.url}/connect/token/${connectRequest.state}.jwt`;
        },
      });

      const result = await handler.requestAccess({ permissionRequests });

      expect(result?.connectedDid).toBe(connectedDid);
      expect(result?.delegatePortableDid.uri.startsWith('did:jwk:')).toBe(true);
      expect(result?.delegateGrants).toHaveLength(1);
      expect(output.text()).toContain('[qr]');
      expect(relay.requestReads()).toBe(1);
      expect(relay.tokenReads()).toBe(1);
      expect((await fetch(requestUri)).status).toBe(404);
      expect((await fetch(tokenUrl)).status).toBe(404);
    } finally {
      await relay.close();
    }
  });

  it('should open the browser instead of printing a QR code when requested', async () => {
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      await options.onWalletUriReady('https://wallet.example/connect/app?request_uri=urn:test&encryption_key=test');
      return createConnectResult([createGrant({ scope: requestedScope })]);
    });

    const openedUrls: string[] = [];
    const output = createWritableBuffer();
    const handler = CliConnectHandler({
      walletUrl        : 'https://wallet.example',
      connectServerUrl : 'https://relay.example/connect',
      output,
      openBrowser      : true,
      browserOpener    : (uri: string): void => { openedUrls.push(uri); },
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await handler.requestAccess({ permissionRequests });

    expect(openedUrls).toEqual(['https://wallet.example/connect/app?request_uri=urn:test&encryption_key=test']);
    expect(output.text()).toContain('Opening wallet for approval...');
    expect(output.text()).not.toContain('[qr]');
  });

  it('should return undefined when the wallet denies the request', async () => {
    sinon.stub(WalletConnect, 'initClient').resolves(undefined);

    const handler = CliConnectHandler({
      walletUrl        : 'https://wallet.example',
      connectServerUrl : 'https://relay.example/connect',
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await expect(handler.requestAccess({ permissionRequests })).resolves.toBeUndefined();
  });

  it('should surface PIN mismatch failures from the relay client', async () => {
    sinon.stub(WalletConnect, 'initClient').rejects(new Error('failed to decrypt response'));

    const handler = CliConnectHandler({
      walletUrl        : 'https://wallet.example',
      connectServerUrl : 'https://relay.example/connect',
      pinPrompt        : async (): Promise<string> => '000000',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await expect(handler.requestAccess({ permissionRequests })).rejects.toThrow('failed to decrypt response');
  });

  it('should pass polling controls to the relay client', async () => {
    let timeoutMs: number | undefined;
    let pollIntervalMs: number | undefined;
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      timeoutMs = options.timeoutMs;
      pollIntervalMs = options.pollIntervalMs;
      return undefined;
    });

    const handler = CliConnectHandler({
      walletUrl        : 'https://wallet.example',
      connectServerUrl : 'https://relay.example/connect',
      timeoutMs        : 1234,
      pollIntervalMs   : 50,
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await handler.requestAccess({ permissionRequests });

    expect(timeoutMs).toBe(1234);
    expect(pollIntervalMs).toBe(50);
  });

  it('should let the relay client apply the default timeout', async () => {
    let capturedOptions: WalletConnectClientOptions | undefined;
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      capturedOptions = options;
      return undefined;
    });

    const handler = CliConnectHandler({
      walletUrl        : 'https://wallet.example',
      connectServerUrl : 'https://relay.example/connect',
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await handler.requestAccess({ permissionRequests });

    expect(capturedOptions?.timeoutMs).toBeUndefined();
  });

  it('should reject grants issued to a DID other than the returned delegate DID', async () => {
    sinon.stub(WalletConnect, 'initClient').resolves(createConnectResult([
      createGrant({ grantee: 'did:jwk:other', scope: requestedScope }),
    ]));

    const handler = CliConnectHandler({
      walletUrl        : 'https://wallet.example',
      connectServerUrl : 'https://relay.example/connect',
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await expect(handler.requestAccess({ permissionRequests })).rejects.toThrow('Revoke the approved session in your wallet');
  });

  it('should reject grants broader than the requested scope', async () => {
    const broaderScope: DwnPermissionScope = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Write,
    };
    sinon.stub(WalletConnect, 'initClient').resolves(createConnectResult([
      createGrant({ scope: broaderScope }),
    ]));

    const handler = CliConnectHandler({
      walletUrl        : 'https://wallet.example',
      connectServerUrl : 'https://relay.example/connect',
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await expect(handler.requestAccess({ permissionRequests })).rejects.toThrow('outside the requested permission scope');
  });

  it('should allow session revocation grants returned with sessionRevocations metadata', async () => {
    const sessionGrant = createGrant({ grantId: 'grant-1', scope: requestedScope });
    const revocationGrant = createGrant({
      grantId : 'revocation-1',
      scope   : {
        interface : DwnInterfaceName.Records,
        method    : DwnMethodName.Write,
        protocol  : 'https://identity.foundation/dwn/permissions',
        contextId : 'grant-1',
      },
    });
    sinon.stub(WalletConnect, 'initClient').resolves(createConnectResult(
      [sessionGrant, revocationGrant],
      { sessionRevocations: [{ grantId: 'grant-1', revocationGrantId: 'revocation-1' }] },
    ));

    const handler = CliConnectHandler({
      walletUrl        : 'https://wallet.example',
      connectServerUrl : 'https://relay.example/connect',
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    const result = await handler.requestAccess({ permissionRequests });

    expect(result?.delegateGrants).toHaveLength(2);
  });

  it('should prompt for wallet and relay URLs when options are omitted', async () => {
    let capturedOptions: WalletConnectClientOptions | undefined;
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      capturedOptions = options;
      return undefined;
    });

    const prompts: string[] = [];
    const answers = ['', 'https://relay.example/connect'];
    const handler = CliConnectHandler({
      walletPrompt: async (question: string): Promise<string> => {
        prompts.push(question);
        return answers.shift() ?? '';
      },
      connectServerUrlPrompt: async (question: string): Promise<string> => {
        prompts.push(question);
        return answers.shift() ?? '';
      },
      pinPrompt  : async (): Promise<string> => '428113',
      qrRenderer : async (): Promise<string> => '[qr]',
    });

    await handler.requestAccess({ permissionRequests });

    expect(prompts[0]).toBe(`Wallet [${DEFAULT_CLI_WALLET_URL}]: `);
    expect(prompts[1]).toBe('Connect relay URL: ');
    expect(capturedOptions?.walletUri).toBe(`${DEFAULT_CLI_WALLET_URL}/connect/app`);
    expect(capturedOptions?.connectServerUrl).toBe('https://relay.example/connect');
  });

  it('should normalize bare prompted wallet hosts and re-prompt invalid wallet URLs', async () => {
    let capturedOptions: WalletConnectClientOptions | undefined;
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      capturedOptions = options;
      return undefined;
    });

    const prompts: string[] = [];
    const answers = ['http://', 'localhost:5173', 'https://relay.example/connect'];
    const output = createWritableBuffer();
    const handler = CliConnectHandler({
      output,
      walletPrompt: async (question: string): Promise<string> => {
        prompts.push(question);
        return answers.shift() ?? '';
      },
      connectServerUrlPrompt: async (question: string): Promise<string> => {
        prompts.push(question);
        return answers.shift() ?? '';
      },
      pinPrompt  : async (): Promise<string> => '428113',
      qrRenderer : async (): Promise<string> => '[qr]',
    });

    await handler.requestAccess({ permissionRequests });

    expect(prompts).toEqual([
      `Wallet [${DEFAULT_CLI_WALLET_URL}]: `,
      `Wallet [${DEFAULT_CLI_WALLET_URL}]: `,
      'Connect relay URL: ',
    ]);
    expect(capturedOptions?.walletUri).toBe('https://localhost:5173/connect/app');
    expect(output.text()).toContain('invalid wallet URL');
  });

  it('should remember prompted wallet URLs per handler instance', async () => {
    const walletUris: string[] = [];
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      walletUris.push(options.walletUri);
      return undefined;
    });

    const firstHandlerAnswers = ['https://wallet-one.example', ''];
    const firstHandler = CliConnectHandler({
      connectServerUrl : 'https://relay.example/connect',
      walletPrompt     : async (): Promise<string> => firstHandlerAnswers.shift() ?? '',
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });
    const secondHandler = CliConnectHandler({
      connectServerUrl : 'https://relay.example/connect',
      walletPrompt     : async (): Promise<string> => '',
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await firstHandler.requestAccess({ permissionRequests });
    await firstHandler.requestAccess({ permissionRequests });
    await secondHandler.requestAccess({ permissionRequests });

    expect(walletUris).toEqual([
      'https://wallet-one.example/connect/app',
      'https://wallet-one.example/connect/app',
      `${DEFAULT_CLI_WALLET_URL}/connect/app`,
    ]);
  });

  it('should reject configured invalid wallet URLs with a friendly error', async () => {
    const handler = CliConnectHandler({
      walletUrl        : 'http://',
      connectServerUrl : 'https://relay.example/connect',
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await expect(handler.requestAccess({ permissionRequests })).rejects.toThrow('@enbox/cli: invalid wallet URL');
  });

  it('should normalize configured bare relay URLs', async () => {
    let capturedOptions: WalletConnectClientOptions | undefined;
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      capturedOptions = options;
      return undefined;
    });

    const handler = CliConnectHandler({
      walletUrl        : 'https://wallet.example',
      connectServerUrl : 'my-dwn.example/connect',
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await handler.requestAccess({ permissionRequests });

    expect(capturedOptions?.connectServerUrl).toBe('https://my-dwn.example/connect');
  });

  it('should reject configured invalid relay URLs with a friendly error', async () => {
    const handler = CliConnectHandler({
      walletUrl        : 'https://wallet.example',
      connectServerUrl : 'http://',
      pinPrompt        : async (): Promise<string> => '428113',
      qrRenderer       : async (): Promise<string> => '[qr]',
    });

    await expect(handler.requestAccess({ permissionRequests })).rejects.toThrow('@enbox/cli: invalid connect relay URL');
  });

  it('should normalize bare prompted relay hosts and re-prompt invalid relay URLs', async () => {
    let capturedOptions: WalletConnectClientOptions | undefined;
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      capturedOptions = options;
      return undefined;
    });

    const prompts: string[] = [];
    const answers = ['http://', 'my-dwn.example/connect'];
    const output = createWritableBuffer();
    const handler = CliConnectHandler({
      output,
      walletUrl              : 'https://wallet.example',
      connectServerUrlPrompt : async (question: string): Promise<string> => {
        prompts.push(question);
        return answers.shift() ?? '';
      },
      pinPrompt  : async (): Promise<string> => '428113',
      qrRenderer : async (): Promise<string> => '[qr]',
    });

    await handler.requestAccess({ permissionRequests });

    expect(prompts).toEqual([
      'Connect relay URL: ',
      'Connect relay URL: ',
    ]);
    expect(capturedOptions?.connectServerUrl).toBe('https://my-dwn.example/connect');
    expect(output.text()).toContain('invalid connect relay URL');
  });

  it('should use a provider-supplied relay URL before prompting', async () => {
    let capturedOptions: WalletConnectClientOptions | undefined;
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      capturedOptions = options;
      return undefined;
    });

    const handler = CliConnectHandler({
      walletUrl                : 'https://wallet.example',
      connectServerUrlProvider : async (): Promise<string> => 'provider-dwn.example/connect',
      connectServerUrlPrompt   : async (): Promise<string> => { throw new Error('should not prompt'); },
      pinPrompt                : async (): Promise<string> => '428113',
      qrRenderer               : async (): Promise<string> => '[qr]',
    });

    await handler.requestAccess({ permissionRequests });

    expect(capturedOptions?.connectServerUrl).toBe('https://provider-dwn.example/connect');
  });
});

type TestRelay = {
  close: () => Promise<void>;
  requestReads: () => number;
  tokenReads: () => number;
  url: string;
};

type StoredRelayEntry = {
  consumed: boolean;
  value: string;
};

async function createTestRelay(): Promise<TestRelay> {
  const requests = new Map<string, StoredRelayEntry>();
  const tokens = new Map<string, StoredRelayEntry>();
  let requestReadCount = 0;
  let tokenReadCount = 0;
  let nextRequestId = 0;
  let baseUrl = '';

  const server = createServer((request: IncomingMessage, response: ServerResponse): void => {
    void handleRelayRequest({
      baseUrl,
      request,
      requests,
      response,
      tokens,
      nextRequestId: (): string => {
        nextRequestId += 1;
        return `request-${nextRequestId}`;
      },
      incrementRequestReads : (): void => { requestReadCount += 1; },
      incrementTokenReads   : (): void => { tokenReadCount += 1; },
    }).catch((error: unknown): void => {
      writeResponse(response, 500, error instanceof Error ? error.message : String(error));
    });
  });

  await listen(server);
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    url          : baseUrl,
    requestReads : (): number => requestReadCount,
    tokenReads   : (): number => tokenReadCount,
    close        : (): Promise<void> => close(server),
  };
}

async function handleRelayRequest({
  baseUrl,
  request,
  requests,
  response,
  tokens,
  nextRequestId,
  incrementRequestReads,
  incrementTokenReads,
}: {
  baseUrl: string;
  request: IncomingMessage;
  requests: Map<string, StoredRelayEntry>;
  response: ServerResponse;
  tokens: Map<string, StoredRelayEntry>;
  nextRequestId: () => string;
  incrementRequestReads: () => void;
  incrementTokenReads: () => void;
}): Promise<void> {
  const url = new URL(request.url ?? '/', baseUrl);

  if (request.method === 'POST' && url.pathname === '/connect/par') {
    const body = JSON.parse(await readRequestBody(request)) as { request?: string };
    if (body.request === undefined) {
      writeResponse(response, 400, 'missing request');
      return;
    }

    const requestId = nextRequestId();
    requests.set(requestId, { consumed: false, value: body.request });
    writeJson(response, {
      request_uri: `${baseUrl}/connect/authorize/${requestId}.jwt`,
    });
    return;
  }

  const authorizeMatch = url.pathname.match(/^\/connect\/authorize\/([^/]+)\.jwt$/);
  if (request.method === 'GET' && authorizeMatch !== null) {
    const requestId = authorizeMatch[1];
    const stored = requests.get(requestId);
    if (stored === undefined || stored.consumed) {
      writeResponse(response, 404, 'not found');
      return;
    }

    stored.consumed = true;
    incrementRequestReads();
    writeResponse(response, 200, stored.value, 'application/jwt');
    return;
  }

  if (request.method === 'POST' && url.pathname === '/connect/callback') {
    const body = new URLSearchParams(await readRequestBody(request));
    const state = body.get('state');
    const idToken = body.get('id_token');
    if (state === null || idToken === null) {
      writeResponse(response, 400, 'missing response');
      return;
    }

    tokens.set(state, { consumed: false, value: idToken });
    writeResponse(response, 200, 'ok');
    return;
  }

  const tokenMatch = url.pathname.match(/^\/connect\/token\/([^/]+)\.jwt$/);
  if (request.method === 'GET' && tokenMatch !== null) {
    const state = tokenMatch[1];
    const stored = tokens.get(state);
    if (stored === undefined || stored.consumed) {
      writeResponse(response, 404, 'not found');
      return;
    }

    stored.consumed = true;
    incrementTokenReads();
    writeResponse(response, 200, stored.value, 'application/jwt');
    return;
  }

  writeResponse(response, 404, 'not found');
}

function getRequiredSearchParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value === '') {
    throw new Error(`missing ${name} search parameter`);
  }
  return value;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk: Buffer | string): void => {
      body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    request.on('end', (): void => { resolve(body); });
    request.on('error', (error: Error): void => { reject(error); });
  });
}

function writeJson(response: ServerResponse, body: unknown): void {
  writeResponse(response, 200, JSON.stringify(body), 'application/json');
}

function writeResponse(response: ServerResponse, statusCode: number, body: string, contentType = 'text/plain'): void {
  response.writeHead(statusCode, { 'Content-Type': contentType });
  response.end(body);
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: Error): void => { reject(error); });
    server.listen(0, '127.0.0.1', (): void => { resolve(); });
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error): void => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createConnectResult(
  delegateGrants: ConnectResult['delegateGrants'],
  overrides: Partial<ConnectResult> = {},
): ConnectResult {
  return {
    delegatePortableDid: { uri: delegateDid, document: {}, metadata: {} },
    connectedDid,
    delegateGrants,
    ...overrides,
  };
}

function createGrant({
  grantId = 'grant-1',
  grantee = delegateDid,
  scope,
}: {
  grantId?: string;
  grantee?: string;
  scope: DwnPermissionScope;
}): ConnectResult['delegateGrants'][number] {
  return {
    recordId    : grantId,
    contextId   : grantId,
    encodedData : Convert.object({
      dateExpires : '2040-01-01T00:00:00.000000Z',
      delegated   : true,
      scope,
    }).toBase64Url(),
    descriptor: {
      interface    : DwnInterfaceName.Records,
      method       : DwnMethodName.Write,
      protocol     : 'https://identity.foundation/dwn/permissions',
      protocolPath : 'grant',
      recipient    : grantee,
      dateCreated  : '2026-01-01T00:00:00.000000Z',
      dataFormat   : 'application/json',
      dataCid      : 'bafytest',
      dataSize     : 100,
    },
    authorization: {
      signature: {
        signatures: [{
          protected: Convert.object({ kid: `${connectedDid}#key-1` }).toBase64Url(),
        }],
      },
    },
  };
}

function createWritableBuffer(): Writable & { text(): string } {
  let text = '';
  return {
    write(chunk: string | Uint8Array): boolean {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    },
    text(): string {
      return text;
    },
  } as Writable & { text(): string };
}
