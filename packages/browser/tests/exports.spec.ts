import { describe, expect, it } from 'bun:test';

import agentPackageJson from '../../agent/package.json' with { type: 'json' };
import apiPackageJson from '../../api/package.json' with { type: 'json' };
import authPackageJson from '../../auth/package.json' with { type: 'json' };
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

  it('re-exports recordCodecs from @enbox/api', async () => {
    const [browser, api] = await Promise.all([
      getBrowserExports(),
      import('@enbox/api'),
    ]);
    expect(browser.recordCodecs).toBe(api.recordCodecs);
  });

  it('re-exports the canonical Record class from @enbox/api', async () => {
    const [browser, api] = await Promise.all([
      getBrowserExports(),
      import('@enbox/api'),
    ]);
    expect(browser.Record).toBe(api.Record);
  });

  it('re-exports API error classes from @enbox/api', async () => {
    const [browser, api] = await Promise.all([
      getBrowserExports(),
      import('@enbox/api'),
    ]);
    expect(browser.ContextNotReadyError).toBe(api.ContextNotReadyError);
    expect(browser.ContextRetiredError).toBe(api.ContextRetiredError);
    expect(browser.DwnResponseError).toBe(api.DwnResponseError);
    expect(browser.RecordConflictError).toBe(api.RecordConflictError);
    expect(browser.RecordParentNotFoundError).toBe(api.RecordParentNotFoundError);
    expect(browser.RecordSquashBackstopError).toBe(api.RecordSquashBackstopError);
    expect(browser.RecordValidationError).toBe(api.RecordValidationError);
  });

  it('re-exports protocolContextKey from @enbox/api', async () => {
    const [browser, api] = await Promise.all([
      getBrowserExports(),
      import('@enbox/api'),
    ]);
    expect(browser.protocolContextKey).toBe(api.protocolContextKey);
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

  it('exports the ordered default wallet catalog', async () => {
    const mod = await getBrowserExports();
    const wallets = mod.DEFAULT_WALLETS as Array<{ name: string; url: string; description?: string }>;
    expect(wallets).toEqual([
      {
        name        : 'Enbox',
        url         : 'https://enbox-wallet.pages.dev',
        description : 'Manage your digital identity and data',
      },
      {
        name        : 'Prism',
        url         : 'https://prism-wallet.pages.dev',
        description : 'A clear view into your digital identity',
      },
      {
        name        : 'Matcha',
        url         : 'https://matcha-wallet.pages.dev',
        description : 'A fresh approach to digital identity',
      },
      {
        name        : 'Sumi',
        url         : 'https://sumi-wallet.pages.dev',
        description : 'A refined home for your digital identity',
      },
      {
        name        : 'Taffy',
        url         : 'https://taffy-wallet.pages.dev',
        description : 'A playful take on your digital identity',
      },
      {
        name        : 'Astoria',
        url         : 'https://astoria-wallet.pages.dev',
        description : 'A grand home for your digital identity',
      },
      {
        name        : 'Quay',
        url         : 'https://quay-id.pages.dev',
        description : 'A safe harbor for your digital identity',
      },
      {
        name        : 'Quoin',
        url         : 'https://quoin-id.pages.dev',
        description : 'A cornerstone for your digital identity',
      },
    ]);
  });

  it('exports the popup connect flow and transports', async () => {
    const mod = await getBrowserExports();
    expect(typeof mod.connectViaPopup).toBe('function');
    expect(typeof mod.PopupClientTransport).toBe('function');
    expect(typeof mod.WalletPostMessageTransport).toBe('function');
    expect(typeof mod.PopupWindowClosedError).toBe('function');
  });

  it('re-exports the connect kernel provider surface for wallets', async () => {
    const mod = await getBrowserExports();
    expect(typeof mod.ConnectProvider).toBe('function');
    expect(mod.CONNECT_DENIED_TOKEN).toBe('DENIED');
  });

  it('exports runConnectModal', async () => {
    const mod = await getBrowserExports();
    expect(mod.runConnectModal).toBeDefined();
    expect(typeof mod.runConnectModal).toBe('function');
  });

  it('exports WalletConnect from @enbox/auth', async () => {
    const mod = await getBrowserExports();
    expect(mod.WalletConnect).toBeDefined();
  });

  it('declares browser-conditioned root entrypoints for browser-facing packages', () => {
    for (const packageJson of [agentPackageJson, apiPackageJson, authPackageJson, browserPackageJson]) {
      expect(packageJson.browser).toBe('./dist/browser.mjs');
      expect(rootExport(packageJson).browser).toBe('./dist/browser.mjs');
    }
  });

  it('builds @enbox/browser as a browser bundle', () => {
    expect(browserPackageJson.scripts?.['build:browser']).toContain('browser-bundle.js');
  });
});
