import { TestDataGenerator } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

import {
  dependencyKey,
  hasTerminalDependency,
  isTenantProtocolConfig,
  missingDependencyDetail,
  newestProtocolConfig,
} from '../src/sync-fetch-helpers.js';

describe('sync-fetch-helpers', () => {
  describe('dependency ref helpers', () => {
    it('dependencyKey is stable and distinguishes refs', () => {
      expect(dependencyKey({ type: 'Protocol', protocol: 'p' }))
        .toBe(dependencyKey({ type: 'Protocol', protocol: 'p' }));
      expect(dependencyKey({ type: 'Protocol', protocol: 'p' }))
        .not.toBe(dependencyKey({ type: 'Protocol', protocol: 'q' }));
    });

    it('hasTerminalDependency detects a terminal ref', () => {
      expect(hasTerminalDependency([{ type: 'Protocol', protocol: 'p' }])).toBe(false);
      expect(hasTerminalDependency([{ type: 'Protocol', protocol: 'p', terminal: true }])).toBe(true);
    });

    it('missingDependencyDetail lists each ref', () => {
      const detail = missingDependencyDetail([
        { type: 'Protocol', protocol: 'p' },
        { type: 'Grant', permissionGrantId: 'g' },
      ]);
      expect(detail).toContain('Protocol');
      expect(detail).toContain('Grant');
    });
  });

  describe('protocol config helpers', () => {
    it('newestProtocolConfig picks the latest by timestamp', () => {
      const older = { descriptor: { messageTimestamp: '2024-01-01T00:00:00.000Z' } } as any;
      const newer = { descriptor: { messageTimestamp: '2024-02-01T00:00:00.000Z' } } as any;
      expect(newestProtocolConfig([older, newer])).toBe(newer);
      expect(newestProtocolConfig([newer, older])).toBe(newer);
      expect(newestProtocolConfig([])).toBeUndefined();
    });

    it('isTenantProtocolConfig matches the tenant own config for the protocol', async () => {
      const { message, author } = await TestDataGenerator.generateProtocolsConfigure();
      const protocol = message.descriptor.definition.protocol;

      expect(isTenantProtocolConfig(author.did, protocol)(message)).toBe(true);
      expect(isTenantProtocolConfig('did:example:other', protocol)(message)).toBe(false);
      expect(isTenantProtocolConfig(author.did, 'https://other.example/proto')(message)).toBe(false);
    });
  });
});
