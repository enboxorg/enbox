import type { ProviderAuthPlugin } from '../../src/registration/provider-auth-plugin.js';

import { DwnServerErrorCode } from '../../src/dwn-error.js';
import { join } from 'path';
import { loadProviderAuthPlugin } from '../../src/registration/provider-auth-plugin.js';
import { tmpdir } from 'os';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';

describe('loadProviderAuthPlugin', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'provider-auth-plugin-test-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should load a plugin that exports a default class', async () => {
    const pluginPath = join(tmpDir, 'class-plugin.ts');
    writeFileSync(pluginPath, `
      export default class TestPlugin {
        async validateRegistrationToken(token) {
          return { isValid: token === 'valid-token', accountId: 'acct-1' };
        }
      }
    `);

    const plugin = await loadProviderAuthPlugin(pluginPath);
    expect(typeof plugin.validateRegistrationToken).toBe('function');

    const validResult = await plugin.validateRegistrationToken('valid-token');
    expect(validResult.isValid).toBe(true);
    expect(validResult.accountId).toBe('acct-1');

    const invalidResult = await plugin.validateRegistrationToken('bad-token');
    expect(invalidResult.isValid).toBe(false);
  });

  it('should load a plugin that exports a default plain object', async () => {
    const pluginPath = join(tmpDir, 'object-plugin.ts');
    writeFileSync(pluginPath, `
      export default {
        async validateRegistrationToken(token) {
          return { isValid: true, metadata: { plan: 'pro' } };
        }
      };
    `);

    const plugin = await loadProviderAuthPlugin(pluginPath);
    expect(typeof plugin.validateRegistrationToken).toBe('function');

    const result = await plugin.validateRegistrationToken('any-token');
    expect(result.isValid).toBe(true);
    expect(result.metadata).toEqual({ plan: 'pro' });
  });

  it('should throw ProviderAuthPluginLoadFailed when the module path does not exist', async () => {
    const badPath = join(tmpDir, 'nonexistent-plugin.ts');

    try {
      await loadProviderAuthPlugin(badPath);
      expect.unreachable('should have thrown');
    } catch (error: any) {
      expect(error.code).toBe(DwnServerErrorCode.ProviderAuthPluginLoadFailed);
      expect(error.message).toContain('Failed to load provider auth plugin');
    }
  });

  it('should throw ProviderAuthPluginLoadFailed when the module has no default export', async () => {
    const pluginPath = join(tmpDir, 'no-default-plugin.ts');
    writeFileSync(pluginPath, `
      export const plugin = {
        async validateRegistrationToken(token) {
          return { isValid: true };
        }
      };
    `);

    try {
      await loadProviderAuthPlugin(pluginPath);
      expect.unreachable('should have thrown');
    } catch (error: any) {
      expect(error.code).toBe(DwnServerErrorCode.ProviderAuthPluginLoadFailed);
      expect(error.message).toContain('does not have a default export');
    }
  });

  it('should throw ProviderAuthPluginLoadFailed when the default export lacks validateRegistrationToken', async () => {
    const pluginPath = join(tmpDir, 'bad-interface-plugin.ts');
    writeFileSync(pluginPath, `
      export default {
        someOtherMethod() { return true; }
      };
    `);

    try {
      await loadProviderAuthPlugin(pluginPath);
      expect.unreachable('should have thrown');
    } catch (error: any) {
      expect(error.code).toBe(DwnServerErrorCode.ProviderAuthPluginLoadFailed);
      expect(error.message).toContain('does not implement validateRegistrationToken');
    }
  });

  describe('ProviderAuthPlugin interface', () => {
    it('should support returning validation result with detail on failure', async () => {
      const plugin: ProviderAuthPlugin = {
        async validateRegistrationToken(_token: string) {
          return {
            isValid : false,
            detail  : 'Token expired at 2025-01-01T00:00:00Z',
          };
        }
      };

      const result = await plugin.validateRegistrationToken('expired-token');
      expect(result.isValid).toBe(false);
      expect(result.detail).toBe('Token expired at 2025-01-01T00:00:00Z');
      expect(result.accountId).toBeUndefined();
      expect(result.metadata).toBeUndefined();
    });

    it('should support returning validation result with all optional fields', async () => {
      const plugin: ProviderAuthPlugin = {
        async validateRegistrationToken(_token: string) {
          return {
            isValid   : true,
            accountId : 'acct-42',
            metadata  : { plan: 'enterprise', quota: '100gb' },
          };
        }
      };

      const result = await plugin.validateRegistrationToken('valid');
      expect(result.isValid).toBe(true);
      expect(result.accountId).toBe('acct-42');
      expect(result.metadata).toEqual({ plan: 'enterprise', quota: '100gb' });
    });
  });
});
