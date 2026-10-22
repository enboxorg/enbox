import type { BrowserConnectHandlerOptions } from '../src/browser-connect-handler.js';
import type { PortableDid } from '@enbox/dids';
import type { ConnectPermissionRequest, ConnectResult } from '@enbox/connect';

import { vi } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { BrowserConnectHandler } from '../src/browser-connect-handler.js';
import { runConnectModal } from '../src/ui/connect-modal.js';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

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
      protocolDefinition : { protocol: 'https://app.example/notes', published: false, types: {}, structure: {} },
      permissionScopes   : [{ protocol: 'https://app.example/notes', interface: DwnInterfaceName.Records, method: DwnMethodName.Read }],
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
});
