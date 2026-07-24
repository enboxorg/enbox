import { describe, expect, it } from 'bun:test';

import cliPackageJson from '../package.json' with { type: 'json' };

describe('@enbox/cli exports', () => {
  async function getCliExports(): Promise<Record<string, unknown>> {
    return import('../src/index.js') as unknown as Record<string, unknown>;
  }

  it('exports Enbox from @enbox/api', async () => {
    const mod = await getCliExports();
    expect(mod.Enbox).toBeDefined();
    expect(typeof mod.Enbox).toBe('function');
  });

  it('exports recordCodecs from @enbox/api', async () => {
    const [cli, api] = await Promise.all([
      import('../src/index.js'),
      import('@enbox/api'),
    ]);
    expect(cli.recordCodecs).toBe(api.recordCodecs);
  });

  it('exports AuthManager from @enbox/auth', async () => {
    const mod = await getCliExports();
    expect(mod.AuthManager).toBeDefined();
    expect(typeof mod.AuthManager).toBe('function');
  });

  it('exports CliConnectHandler', async () => {
    const mod = await getCliExports();
    expect(mod.CliConnectHandler).toBeDefined();
    expect(typeof mod.CliConnectHandler).toBe('function');
  });

  it('declares a node import root entrypoint', () => {
    expect(cliPackageJson.exports['.'].import).toBe('./dist/esm/index.js');
    expect(cliPackageJson.exports['.'].types).toBe('./dist/types/index.d.ts');
  });
});
