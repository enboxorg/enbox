import { afterAll, describe, expect, it } from 'bun:test';

import { rm } from 'node:fs/promises';

import { EnboxUserAgent } from '../src/enbox-user-agent.js';

describe('EnboxUserAgent.shutdown()', () => {
  it('should tear down components in dependency order', async () => {
    const calls: string[] = [];
    const agent = await EnboxUserAgent.create({
      agentVault: {
        lock  : async (): Promise<void> => { calls.push('vault.lock'); },
        close : async (): Promise<void> => { calls.push('vault.close'); },
      } as any,
      cryptoApi      : {} as any,
      didApi         : { close: async (): Promise<void> => { calls.push('did.close'); } } as any,
      dwnApi         : { close: async (): Promise<void> => { calls.push('dwn.close'); } } as any,
      identityApi    : {} as any,
      keyManager     : {} as any,
      permissionsApi : {} as any,
      rpcClient      : { close: async (): Promise<void> => { calls.push('rpc.close'); } } as any,
      secretsApi     : { close: async (): Promise<void> => { calls.push('secrets.close'); } } as any,
      syncApi        : {
        stopSync : async (timeout: number): Promise<void> => { calls.push(`sync.stopSync:${timeout}`); },
        close    : async (options: { timeout: number }): Promise<void> => { calls.push(`sync.close:${options.timeout}`); },
      } as any,
    });

    await agent.shutdown({ syncStopTimeoutMs: 1234 });

    expect(calls).toEqual([
      'sync.stopSync:1234',
      'sync.close:1234',
      'rpc.close',
      'vault.lock',
      'dwn.close',
      'did.close',
      'vault.close',
      'secrets.close',
    ]);
  });

  it('should complete when every component throws', async () => {
    const failing = async (): Promise<never> => { throw new Error('teardown failure'); };
    const agent = await EnboxUserAgent.create({
      agentVault     : { lock: failing, close: failing } as any,
      cryptoApi      : {} as any,
      didApi         : { close: failing } as any,
      dwnApi         : { close: failing } as any,
      identityApi    : {} as any,
      keyManager     : {} as any,
      permissionsApi : {} as any,
      rpcClient      : { close: failing } as any,
      secretsApi     : { close: failing } as any,
      syncApi        : { stopSync: failing, close: failing } as any,
    });

    await agent.shutdown();
  });

  describe('store lock release', () => {
    const dataPath = '__TESTDATA__/enbox-user-agent-shutdown-reopen';

    afterAll(async () => {
      await rm(dataPath, { force: true, recursive: true });
    });

    it('should release store locks so the same dataPath reopens in-process', async () => {
      const first = await EnboxUserAgent.create({ dataPath });
      expect(await first.firstLaunch()).toBe(true);
      await first.shutdown();

      // Before shutdown released the vault, DWN store, and resolver cache
      // LevelDB handles, this reopen wedged or failed with LEVEL_LOCKED.
      const second = await EnboxUserAgent.create({ dataPath });
      expect(await second.firstLaunch()).toBe(true);
      await second.shutdown();
    });
  });
});
