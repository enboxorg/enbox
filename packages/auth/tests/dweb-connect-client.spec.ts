import { describe, expect, test } from 'bun:test';

import { DWebConnect } from '../src/dweb-connect-client.js';

describe('DWebConnect', () => {
  describe('initClient', () => {
    test('throws in non-browser environment', async () => {
      // Bun test runner has no `window` by default.
      const originalWindow = globalThis.window;
      try {
        // @ts-ignore
        delete globalThis.window;

        await expect(
          DWebConnect.initClient({
            walletUrl          : 'https://wallet.example.com',
            permissionRequests : [],
          })
        ).rejects.toThrow('only available in browser');
      } finally {
        // @ts-ignore
        globalThis.window = originalWindow;
      }
    });
  });

  describe('probeWalletSupport', () => {
    test('returns false in non-browser environment', async () => {
      const originalWindow = globalThis.window;
      try {
        // @ts-ignore
        delete globalThis.window;

        const result = await DWebConnect.probeWalletSupport(
          'https://wallet.example.com',
          'did:dht:test123',
        );
        expect(result).toBe(false);
      } finally {
        // @ts-ignore
        globalThis.window = originalWindow;
      }
    });
  });
});
