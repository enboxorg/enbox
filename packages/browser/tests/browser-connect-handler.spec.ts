import type { BrowserConnectHandlerOptions } from '../src/browser-connect-handler.js';
import type { PortableDid } from '@enbox/dids';
import type { ConnectPermissionRequest, ConnectResult } from '@enbox/connect';

import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DidJwk } from '@enbox/dids';
import {
  buildRedirectReturnUri,
  ConnectProvider,
  generateRedirectResponseSecret,
  parseWalletConnectUri,
} from '@enbox/connect';

import { BrowserConnectHandler } from '../src/browser-connect-handler.js';
import { runConnectModal } from '../src/ui/connect-modal.js';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';
import { PENDING_REDIRECT_STORAGE_KEY, startRedirectConnect } from '../src/redirect-connect.js';

vi.mock('../src/ui/connect-modal.js', { spy: true });

describe('BrowserConnectHandler', () => {
  beforeEach((): void => {
    vi.mocked(runConnectModal).mockReset().mockResolvedValue(undefined);
  });

  afterEach((): void => {
    vi.restoreAllMocks();
  });

  it.each([
    { name: 'default', appIcon: undefined, expected: '/favicon.ico' },
    { name: 'relative', appIcon: 'icons/app.svg', expected: '/icons/app.svg' },
    { name: 'absolute', appIcon: 'https://cdn.example/app.svg', expected: 'https://cdn.example/app.svg' },
  ])('resolves the $name icon against the page origin', async ({ appIcon, expected }): Promise<void> => {
    const handler = BrowserConnectHandler(appIcon === undefined ? {} : { appIcon });
    await handler.requestAccess({ permissionRequests: [] });

    const expectedIcon = expected.startsWith('/') ? `${window.location.origin}${expected}` : expected;
    expect(runConnectModal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runConnectModal).mock.calls[0][0].appIcon).toBe(expectedIcon);
  });

  it('opens the modal synchronously with configured metadata and requested permissions', async (): Promise<void> => {
    const options: BrowserConnectHandlerOptions = {
      appName          : 'My Dapp',
      appIcon          : '/original.svg',
      applicationId    : 'my-dapp',
      wallets          : [{ name: 'Wallet', url: 'https://wallet.example' }],
      walletUrl        : 'https://wallet.example',
      preferredMethod  : 'browser',
      rememberChoice   : false,
      connectServerUrl : 'https://relay.example',
      relayWalletPath  : '/connect/app',
      timeout          : 60_000,
      theme            : { appearance: 'dark' },
    };
    const permissionRequests: ConnectPermissionRequest[] = [{
      moduleDefinition : { module: 'https://app.example/notes', published: false, types: {}, structure: {} },
      permissionScopes : [{ module: 'https://app.example/notes', interface: DwnInterfaceName.Records, method: DwnMethodName.Read }],
    }];
    const delegatePortableDid: PortableDid = {
      uri      : 'did:example:delegate',
      document : { id: 'did:example:delegate' },
      metadata : {},
    };
    const result: ConnectResult = {
      connectedDid       : 'did:example:owner',
      delegatePortableDid,
      delegateGrants     : [],
      sessionRevocations : [],
    };
    vi.mocked(runConnectModal).mockResolvedValue(result);
    const handler = BrowserConnectHandler(options);
    expect(runConnectModal).not.toHaveBeenCalled();

    const pending = handler.requestAccess({
      permissionRequests,
      delegatePortableDid,
      requestType         : 'refresh',
      expectedProviderDid : 'did:example:owner',
    });
    expect(runConnectModal).toHaveBeenCalledTimes(1);
    expect(runConnectModal).toHaveBeenCalledWith({
      ...options,
      appIcon             : `${window.location.origin}/original.svg`,
      permissionRequests,
      delegatePortableDid,
      mode                : 'refresh',
      expectedProviderDid : 'did:example:owner',
    });
    expect(await pending).toBe(result);
  });

  it('defers malformed icon rejection until the request and never opens the modal', async (): Promise<void> => {
    const options = { appIcon: 'http://[' };
    const handler = BrowserConnectHandler(options);

    await expect(handler.requestAccess({ permissionRequests: [] })).rejects.toBeInstanceOf(TypeError);
    expect(runConnectModal).not.toHaveBeenCalled();
  });

  it('validates redirectUri eagerly when creating BrowserConnectHandler', (): void => {
    expect(() => BrowserConnectHandler({ redirectUri: 'http://evil.example/callback' })).toThrow('reply.redirectUri');
    expect(() => BrowserConnectHandler({ redirectUri: 'https://app.example/callback?q=1' })).toThrow('reply.redirectUri');
  });

  it('automatically completes a pending redirect return without mounting the modal and remembers the chosen wallet', async (): Promise<void> => {
    const connectServerUrl = 'https://relay.example/connect';
    const walletBaseUrl = 'https://wallet-one.example.com';
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    let storedRequestJwe = '';
    let storedResponseJwe = '';
    let navigatedTo = '';

    const originalFetch = globalThis.fetch;
    const originalUrl = window.location.href;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === `${connectServerUrl}/par`) {
        storedRequestJwe = (JSON.parse(init!.body as string) as { request: string }).request;
        return new Response(JSON.stringify({ request_uri: `${connectServerUrl}/authorize/r1.jwt`, expires_in: 600 }), { status: 201 });
      }
      if (url.startsWith(`${connectServerUrl}/token/`)) {
        return new Response(storedResponseJwe, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }) as typeof fetch;

    try {
      sessionStorage.removeItem(PENDING_REDIRECT_STORAGE_KEY);
      localStorage.removeItem('enbox:connect:lastChoice');
      localStorage.removeItem('enbox:connect:sessionChoices');

      await startRedirectConnect({
        connectServerUrl,
        walletUrl          : walletBaseUrl,
        walletUri          : `${walletBaseUrl}/connect/app`,
        redirectUri,
        appName            : 'Handler Redirect App',
        permissionRequests : [],
        navigate           : (url): void => { navigatedTo = url; },
      });

      const parsedUri = parseWalletConnectUri(navigatedTo)!;
      const request = await ConnectProvider.openRequest({
        jwe        : storedRequestJwe,
        decryption : { mode: 'dir', requestKey: parsedUri.encryptionKey },
      });
      const owner = await DidJwk.create();
      const delegate = await DidJwk.create();
      const responseSecret = generateRedirectResponseSecret();
      storedResponseJwe = await ConnectProvider.sealApprovedResponse({
        request,
        providerDid : owner.uri,
        signer      : delegate,
        responseSecret,
        approval    : {
          delegateDid         : delegate.uri,
          delegatePortableDid : await delegate.export(),
          delegateGrants      : [],
          sessionRevocations  : [],
        },
      });
      const returnUrl = buildRedirectReturnUri({ redirectUri, state: request.state, responseSecret });
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${new URL(returnUrl).hash}`);

      const handler = BrowserConnectHandler({ redirectUri });
      const result = await handler.requestAccess({ permissionRequests: [] });

      expect(runConnectModal).not.toHaveBeenCalled();
      expect(result?.connectedDid).toBe(owner.uri);
      expect(result?.delegatePortableDid.uri).toBe(delegate.uri);
      expect(window.location.hash).toBe('');
      expect(JSON.parse(localStorage.getItem('enbox:connect:lastChoice') ?? 'null')).toEqual({
        method    : 'redirect',
        walletUrl : walletBaseUrl,
      });
    } finally {
      globalThis.fetch = originalFetch;
      window.history.replaceState(window.history.state, '', originalUrl);
      sessionStorage.removeItem(PENDING_REDIRECT_STORAGE_KEY);
      localStorage.removeItem('enbox:connect:lastChoice');
      localStorage.removeItem('enbox:connect:sessionChoices');
    }
  });
});
