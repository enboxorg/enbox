import { TestDataGenerator } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

import {
  dependencyKey,
  hasTerminalDependency,
  isTenantModuleConfig,
  missingDependencyDetail,
  newestModuleConfig,
} from '../src/sync-fetch-helpers.js';

describe('sync-fetch-helpers', () => {
  describe('dependency ref helpers', () => {
    it('dependencyKey is stable and distinguishes refs', () => {
      expect(dependencyKey({ type: 'Module', module: 'p' }))
        .toBe(dependencyKey({ type: 'Module', module: 'p' }));
      expect(dependencyKey({ type: 'Module', module: 'p' }))
        .not.toBe(dependencyKey({ type: 'Module', module: 'q' }));
    });

    it('hasTerminalDependency detects a terminal ref', () => {
      expect(hasTerminalDependency([{ type: 'Module', module: 'p' }])).toBe(false);
      expect(hasTerminalDependency([{ type: 'Module', module: 'p', terminal: true }])).toBe(true);
    });

    it('missingDependencyDetail lists each ref', () => {
      const detail = missingDependencyDetail([
        { type: 'Module', module: 'p' },
        { type: 'Grant', permissionGrantId: 'g' },
      ]);
      expect(detail).toContain('Module');
      expect(detail).toContain('Grant');
    });
  });

  describe('module config helpers', () => {
    it('newestModuleConfig picks the latest by timestamp', () => {
      const older = { descriptor: { messageTimestamp: '2024-01-01T00:00:00.000Z' } } as any;
      const newer = { descriptor: { messageTimestamp: '2024-02-01T00:00:00.000Z' } } as any;
      expect(newestModuleConfig([older, newer])).toBe(newer);
      expect(newestModuleConfig([newer, older])).toBe(newer);
      expect(newestModuleConfig([])).toBeUndefined();
    });

    it('isTenantModuleConfig matches the tenant own config for the module', async () => {
      const { message, author } = await TestDataGenerator.generateModulesConfigure();
      const module = message.descriptor.definition.module;

      expect(isTenantModuleConfig(author.did, module)(message)).toBe(true);
      expect(isTenantModuleConfig('did:example:other', module)(message)).toBe(false);
      expect(isTenantModuleConfig(author.did, 'https://other.example/proto')(message)).toBe(false);
    });
  });
});
