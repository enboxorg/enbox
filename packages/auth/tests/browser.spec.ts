import { describe, expect, it } from 'bun:test';

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
    expect(mod.normalizeProtocolRequests).toBeDefined();
  });

  it('should export only browser-safe password provider factories', async () => {
    const mod = await getBrowserAuthExports();
    const passwordProvider = mod.PasswordProvider as Record<string, unknown>;

    expect(typeof passwordProvider.fromCallback).toBe('function');
    expect(typeof passwordProvider.chain).toBe('function');
    expect(passwordProvider.fromEnv).toBeUndefined();
    expect(passwordProvider.fromTty).toBeUndefined();
    expect(passwordProvider.fromDevTty).toBeUndefined();
  });
});
