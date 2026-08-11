import { describe, expect, it } from 'bun:test';

import type { PasswordProvider as BrowserPasswordProvider, PasswordContext } from '../src/browser.js';

type BrowserPasswordProviderNamespace = {
  chain(providers: BrowserPasswordProvider[]): BrowserPasswordProvider;
  fromCallback(callback: (context: PasswordContext) => Promise<string>): BrowserPasswordProvider;
  fromDevTty?: unknown;
  fromEnv?: unknown;
  fromTty?: unknown;
};

describe('@enbox/auth/browser', () => {
  async function getBrowserAuthExports(): Promise<Record<string, unknown>> {
    return import('../src/browser.js') as unknown as Record<string, unknown>;
  }

  it('should export the browser-safe auth surface', async () => {
    const mod = await getBrowserAuthExports();

    expect(mod.AuthManager).toBeDefined();
    expect(mod.AuthSession).toBeDefined();
    expect(mod.BrowserStorage).toBeDefined();
    expect(mod.LevelStorage).toBeDefined();
    expect(mod.MemoryStorage).toBeDefined();
    expect(mod.PasswordProvider).toBeDefined();
    expect(mod.WalletConnect).toBeDefined();
    expect(mod.createDefaultStorage).toBeDefined();
    expect(mod.discoverLocalDwn).toBeDefined();
    expect(mod.normalizePermissionPolicy).toBeDefined();
    expect(mod.normalizeProtocolRequests).toBeDefined();
  });

  it('should export only browser-safe password provider factories', async () => {
    const mod = await getBrowserAuthExports();
    const passwordProvider = mod.PasswordProvider as BrowserPasswordProviderNamespace;

    expect(typeof passwordProvider.fromCallback).toBe('function');
    expect(typeof passwordProvider.chain).toBe('function');
    expect(passwordProvider.fromEnv).toBeUndefined();
    expect(passwordProvider.fromTty).toBeUndefined();
    expect(passwordProvider.fromDevTty).toBeUndefined();
  });

  it('should support browser-safe password provider behavior', async () => {
    const mod = await getBrowserAuthExports();
    const passwordProvider = mod.PasswordProvider as BrowserPasswordProviderNamespace;
    const contexts: PasswordContext[] = [];
    const callbackProvider: BrowserPasswordProvider = passwordProvider.fromCallback(async (context) => {
      contexts.push(context);
      return 'browser-password';
    });

    await expect(callbackProvider.getPassword({ reason: 'create' })).resolves.toBe('browser-password');
    expect(contexts).toEqual([{ reason: 'create' }]);

    const chainedProvider = passwordProvider.chain([
      passwordProvider.fromCallback(async () => { throw new Error('not available'); }),
      passwordProvider.fromCallback(async () => 'fallback-password'),
    ]);

    await expect(chainedProvider.getPassword({ reason: 'unlock' })).resolves.toBe('fallback-password');
    expect(() => passwordProvider.chain([])).toThrow('at least one provider is required');
  });
});
