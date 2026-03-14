import type { ElectrobunConfig } from 'electrobun';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

const didDhtGatewayUri = process.env.DID_DHT_GATEWAY_URI ?? 'https://enbox-did-dht.fly.dev';
const resetStorageOnStart = process.env.DWN_RESET_ON_START === 'true' ? 'true' : 'false';
const packageRoot = dirname(fileURLToPath(import.meta.url));
const bunStoreRoot = resolve(packageRoot, '../../node_modules/.bun');

function resolveLevelBrowserEntry(): string {
  const levelStoreDirs = existsSync(bunStoreRoot)
    ? readdirSync(bunStoreRoot).filter((directory) => directory.startsWith('level@'))
    : [];

  for (const storeDir of levelStoreDirs) {
    const candidate = resolve(bunStoreRoot, storeDir, 'node_modules/level/browser.js');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return resolve(packageRoot, '../auth/node_modules/level/browser.js');
}

const levelBrowserEntry = resolveLevelBrowserEntry();
const mainviewBrowserAliasPlugin = {
  name: 'mainview-browser-aliases',
  setup(build) {
    build.onResolve({ filter: /^level$/ }, () => ({ path: levelBrowserEntry }));
  },
};

export default {
  app: {
    name       : 'electrobun-dwn',
    identifier : 'org.enbox.electrobun-dwn',
    version    : '0.0.1',
    urlSchemes : ['dwn'],
  },
  runtime: {
    // Keep the DWN daemon alive when all windows are closed.
    exitOnLastWindowClosed: false,
  },
  build: {
    views: {
      mainview: {
        entrypoint: 'src/mainview/index.ts',
        conditions: ['browser'],
        plugins: [mainviewBrowserAliasPlugin],
        define: {
          global: 'globalThis',
          'process.env.DID_DHT_GATEWAY_URI': JSON.stringify(didDhtGatewayUri),
          'process.env.MAINVIEW_RESET_STORAGE_ON_START': JSON.stringify(resetStorageOnStart),
        },
      },
    },
    copy: {
      'src/mainview/index.html' : 'views/mainview/index.html',
      'src/mainview/router.js' : 'views/mainview/router.js',
      'src/mainview/components' : 'views/mainview/components',
      'src/mainview/assets' : 'views/mainview/assets',
      'src/mainview/assets/logo.svg' : 'views/mainview/assets/logo.svg',
    },
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
