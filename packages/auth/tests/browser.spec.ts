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
    expect(mod.MemoryStorage).toBeDefined();
    expect(mod.WalletConnect).toBeDefined();
    expect(mod.createDefaultStorage).toBeDefined();
    expect(mod.discoverLocalDwn).toBeDefined();
    expect(mod.normalizeProtocolRequests).toBeDefined();
  });

  it('should not export Node-only password providers', async () => {
    const mod = await getBrowserAuthExports();

    expect(mod.PasswordProvider).toBeUndefined();
  });
});
