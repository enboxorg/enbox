import type { ConnectPermissionRequest, DwnPermissionScope } from '@enbox/agent';
import type { ConnectResult, WalletConnectClientOptions } from '@enbox/auth';

import sinon from 'sinon';

import { Convert } from '@enbox/common';
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

  it('should use a provider-supplied relay URL before prompting', async () => {
    let capturedOptions: WalletConnectClientOptions | undefined;
    sinon.stub(WalletConnect, 'initClient').callsFake(async (options: WalletConnectClientOptions): Promise<ConnectResult | undefined> => {
      capturedOptions = options;
      return undefined;
    });

    const handler = CliConnectHandler({
      walletUrl                : 'https://wallet.example',
      connectServerUrlProvider : async (): Promise<string> => 'https://relay.example/connect',
      connectServerUrlPrompt   : async (): Promise<string> => { throw new Error('should not prompt'); },
      pinPrompt                : async (): Promise<string> => '428113',
      qrRenderer               : async (): Promise<string> => '[qr]',
    });

    await handler.requestAccess({ permissionRequests });

    expect(capturedOptions?.connectServerUrl).toBe('https://relay.example/connect');
  });
});

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
