import { describe, expect, test } from 'bun:test';

import type { HdIdentityVault } from '@enbox/agent';

import { AuthEventEmitter } from '../src/events.js';
import { VaultManager } from '../src/vault/vault-manager.js';

function createMockVault(overrides: Partial<Record<string, any>> = {}): HdIdentityVault {
  return {
    isInitialized  : overrides.isInitialized ?? (async (): Promise<boolean> => true),
    isLocked       : overrides.isLocked ?? ((): boolean => false),
    unlock         : overrides.unlock ?? (async (): Promise<void> => {}),
    lock           : overrides.lock ?? (async (): Promise<void> => {}),
    changePassword : overrides.changePassword ?? (async (): Promise<void> => {}),
    backup         : overrides.backup ?? (async (): Promise<{ data: string }> => ({ data: 'backup-data' })),
    restore        : overrides.restore ?? (async (): Promise<void> => {}),
  } as unknown as HdIdentityVault;
}

describe('VaultManager', () => {
  test('raw getter returns the underlying vault', () => {
    const emitter = new AuthEventEmitter();
    const mockVault = createMockVault();
    const manager = new VaultManager(mockVault, emitter);

    expect(manager.raw).toBe(mockVault);
  });

  test('isInitialized() delegates to vault', async () => {
    const emitter = new AuthEventEmitter();
    const mockVault = createMockVault({ isInitialized: async () => false });
    const manager = new VaultManager(mockVault, emitter);

    expect(await manager.isInitialized()).toBe(false);
  });

  test('isInitialized() returns true when vault is initialized', async () => {
    const emitter = new AuthEventEmitter();
    const mockVault = createMockVault({ isInitialized: async () => true });
    const manager = new VaultManager(mockVault, emitter);

    expect(await manager.isInitialized()).toBe(true);
  });

  test('isLocked getter delegates to vault', () => {
    const emitter = new AuthEventEmitter();
    const mockVault = createMockVault({ isLocked: () => true });
    const manager = new VaultManager(mockVault, emitter);

    expect(manager.isLocked).toBe(true);
  });

  test('unlock() calls vault.unlock and emits vault-unlocked', async () => {
    const emitter = new AuthEventEmitter();
    const unlockCalls: any[] = [];
    const mockVault = createMockVault({
      unlock: async (params: any): Promise<void> => { unlockCalls.push(params); },
    });
    const manager = new VaultManager(mockVault, emitter);

    const events: string[] = [];
    emitter.on('vault-unlocked', () => { events.push('unlocked'); });

    await manager.unlock('my-password');

    expect(unlockCalls).toHaveLength(1);
    expect(unlockCalls[0]).toEqual({ password: 'my-password' });
    expect(events).toEqual(['unlocked']);
  });

  test('lock() calls vault.lock and emits vault-locked', async () => {
    const emitter = new AuthEventEmitter();
    let lockCalled = false;
    const mockVault = createMockVault({
      lock: async (): Promise<void> => { lockCalled = true; },
    });
    const manager = new VaultManager(mockVault, emitter);

    const events: string[] = [];
    emitter.on('vault-locked', () => { events.push('locked'); });

    await manager.lock();

    expect(lockCalled).toBe(true);
    expect(events).toEqual(['locked']);
  });

  test('changePassword() delegates to vault', async () => {
    const emitter = new AuthEventEmitter();
    const changeCalls: any[] = [];
    const mockVault = createMockVault({
      changePassword: async (params: any): Promise<void> => { changeCalls.push(params); },
    });
    const manager = new VaultManager(mockVault, emitter);

    await manager.changePassword('old-pass', 'new-pass');

    expect(changeCalls).toHaveLength(1);
    expect(changeCalls[0]).toEqual({ oldPassword: 'old-pass', newPassword: 'new-pass' });
  });

  test('backup() returns vault backup', async () => {
    const emitter = new AuthEventEmitter();
    const backupData = { data: 'my-backup' } as any;
    const mockVault = createMockVault({
      backup: async () => backupData,
    });
    const manager = new VaultManager(mockVault, emitter);

    const result = await manager.backup();
    expect(result).toBe(backupData);
  });

  test('restore() delegates to vault', async () => {
    const emitter = new AuthEventEmitter();
    const restoreCalls: any[] = [];
    const mockVault = createMockVault({
      restore: async (params: any): Promise<void> => { restoreCalls.push(params); },
    });
    const manager = new VaultManager(mockVault, emitter);

    const backup = { data: 'backup-data', dateCreated: '2026-01-01', size: 100 } as any;
    await manager.restore(backup, 'my-password');

    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]).toEqual({ backup, password: 'my-password' });
  });
});
