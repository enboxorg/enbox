import { describe, expect, it } from 'bun:test';

import agentPackageJson from '../../agent/package.json' with { type: 'json' };
import apiPackageJson from '../../api/package.json' with { type: 'json' };
import browserPackageJson from '../package.json' with { type: 'json' };

type BrowserExportPackageJson = {
  browser?: string;
  exports?: {
    '.'?: {
      browser?: string;
      import?: string;
      types?: string;
    };
  };
  scripts?: Record<string, string>;
};

function rootExport(packageJson: BrowserExportPackageJson): NonNullable<NonNullable<BrowserExportPackageJson['exports']>['.']> {
  const exportMap = packageJson.exports?.['.'];
  if (exportMap === undefined) {
    throw new Error('missing package root export');
  }
  return exportMap;
}

/**
 * Verify that @enbox/browser re-exports the expected symbols from
 * @enbox/api, @enbox/auth, and its own browser-specific modules.
 */
describe('@enbox/browser exports', () => {
  // Lazy-import to work in both node and browser vitest contexts.
  async function getBrowserExports(): Promise<Record<string, unknown>> {
    return import('../src/index.js') as unknown as Record<string, unknown>;
  }

  it('re-exports Enbox from @enbox/api', async () => {
    const mod = await getBrowserExports();
    expect(mod.Enbox).toBeDefined();
    expect(typeof mod.Enbox).toBe('function');
  });

  it('re-exports defineProtocol from @enbox/api', async () => {
    const mod = await getBrowserExports();
    expect(mod.defineProtocol).toBeDefined();
    expect(typeof mod.defineProtocol).toBe('function');
  });

  it('re-exports repository from @enbox/api', async () => {
    const mod = await getBrowserExports();
    expect(mod.repository).toBeDefined();
    expect(typeof mod.repository).toBe('function');
  });

  it('re-exports AuthManager from @enbox/auth', async () => {
    const mod = await getBrowserExports();
    expect(mod.AuthManager).toBeDefined();
    expect(typeof mod.AuthManager).toBe('function');
  });

  it('re-exports AuthSession from @enbox/auth', async () => {
    const mod = await getBrowserExports();
    expect(mod.AuthSession).toBeDefined();
  });

  it('re-exports normalizeProtocolRequests from @enbox/auth', async () => {
    const mod = await getBrowserExports();
    expect(mod.normalizeProtocolRequests).toBeDefined();
    expect(typeof mod.normalizeProtocolRequests).toBe('function');
  });

  it('exports BrowserConnectHandler', async () => {
    const mod = await getBrowserExports();
    expect(mod.BrowserConnectHandler).toBeDefined();
    expect(typeof mod.BrowserConnectHandler).toBe('function');
  });

  it('exports DEFAULT_WALLETS with correct pages.dev URLs', async () => {
    const mod = await getBrowserExports();
    const wallets = mod.DEFAULT_WALLETS as Array<{ name: string; url: string; description?: string }>;
    expect(Array.isArray(wallets)).toBe(true);
    expect(wallets.length).toBe(2);
    expect(wallets[0].url).toBe('https://enbox-wallet.pages.dev');
    expect(wallets[1].url).toBe('https://blue-enbox-wallet.pages.dev');
    expect(wallets[0].description).toBeDefined();
    expect(wallets[1].description).toBeDefined();
  });

  it('exports DWebConnect with initClient and probeWalletSupport', async () => {
    const mod = await getBrowserExports();
    const dw = mod.DWebConnect as Record<string, unknown>;
    expect(dw).toBeDefined();
    expect(typeof dw.initClient).toBe('function');
    expect(typeof dw.probeWalletSupport).toBe('function');
  });

  it('exports showWalletSelector', async () => {
    const mod = await getBrowserExports();
    expect(mod.showWalletSelector).toBeDefined();
    expect(typeof mod.showWalletSelector).toBe('function');
  });

  it('exports WalletConnect from @enbox/auth', async () => {
    const mod = await getBrowserExports();
    expect(mod.WalletConnect).toBeDefined();
  });

  it('declares browser-conditioned root entrypoints for browser-facing packages', () => {
    for (const packageJson of [agentPackageJson, apiPackageJson, browserPackageJson]) {
      expect(packageJson.browser).toBe('./dist/browser.mjs');
      expect(rootExport(packageJson).browser).toBe('./dist/browser.mjs');
    }
  });

  it('builds @enbox/browser as a browser bundle', () => {
    expect(browserPackageJson.scripts?.['build:browser']).toContain('browser-bundle.js');
  });
});
