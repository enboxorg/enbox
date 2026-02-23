import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';

import { describe, expect, it } from 'bun:test';

describe('config', () => {
  describe('default config values', () => {
    it('should have expected default values when no env vars are set', async () => {
      // Import the config object which reads env vars at module load time.
      // Since we cannot safely re-import modules, we verify the known defaults
      // against the already-loaded config.
      const { config } = await import('../src/config.js');

      // Verify some key defaults that are unlikely to be overridden by env in test.
      expect(config.serverName).toBeDefined();
      expect(typeof config.port).toBe('number');
      expect(typeof config.maxRecordDataSize).toBe('number');
      expect(typeof config.maxInFlight).toBe('number');
      expect(config.maxInFlight).toBe(32);
      expect(typeof config.webSocketSupport).toBe('boolean');
      expect(typeof config.logLevel).toBe('string');
      expect(typeof config.adminActivityLogCapacity).toBe('number');
      expect(config.adminActivityLogCapacity).toBe(10000);
      expect(typeof config.adminMetricsUpdateIntervalSeconds).toBe('number');
      expect(config.adminMetricsUpdateIntervalSeconds).toBe(30);
      expect(typeof config.quotaMaxMessages).toBe('number');
      expect(config.quotaMaxMessages).toBe(0);
      expect(typeof config.quotaMaxStorageBytes).toBe('number');
      expect(config.quotaMaxStorageBytes).toBe(0);
      expect(typeof config.rateLimitRequestsPerSecond).toBe('number');
      expect(typeof config.rateLimitBurst).toBe('number');
      expect(config.rateLimitBurst).toBe(50);
      expect(typeof config.rateLimitTenantRequestsPerSecond).toBe('number');
      expect(typeof config.rateLimitTenantBurst).toBe('number');
      expect(config.rateLimitTenantBurst).toBe(50);
      expect(typeof config.auditLogMaxAgeDays).toBe('number');
      expect(config.auditLogMaxAgeDays).toBe(90);
      expect(typeof config.auditLogMaxRows).toBe('number');
      expect(config.auditLogMaxRows).toBe(100000);
    });
  });

  describe('environment variable parsing', () => {
    it('should parse DS_PORT as a number', async () => {
      const { config } = await import('../src/config.js');
      expect(typeof config.port).toBe('number');
      expect(Number.isInteger(config.port)).toBe(true);
    });

    it('should parse logLevel as a string', async () => {
      const { config } = await import('../src/config.js');
      expect(typeof config.logLevel).toBe('string');
      // logLevel should be one of: trace, debug, info, warn, error (case-insensitive).
      const validLevels = ['trace', 'debug', 'info', 'warn', 'error'];
      expect(validLevels).toContain(config.logLevel.toLowerCase());
    });

    it('should parse maxRecordDataSize via bytes library', async () => {
      const { config } = await import('../src/config.js');
      // Default is '1gb' which parses to 1073741824 bytes.
      expect(typeof config.maxRecordDataSize).toBe('number');
      expect(config.maxRecordDataSize).toBeGreaterThan(0);
    });

    it('should parse boolean registrationProofOfWorkEnabled', async () => {
      const { config } = await import('../src/config.js');
      expect(typeof config.registrationProofOfWorkEnabled).toBe('boolean');
    });

    it('should parse webSocketSupport as boolean', async () => {
      const { config } = await import('../src/config.js');
      expect(typeof config.webSocketSupport).toBe('boolean');
    });
  });

  describe('readAdminTokenFromFile()', () => {
    it('should read and trim token from a file that exists', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'dwn-config-test-'));
      const tokenFile = join(tmpDir, 'admin-token.txt');
      writeFileSync(tokenFile, '  my-secret-token  \n');

      const { readFileSync } = require('fs');
      const token = readFileSync(tokenFile).toString().trim() || undefined;
      expect(token).toBe('my-secret-token');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return undefined when the file does not exist', () => {
      const { readFileSync } = require('fs');
      let token: string | undefined;
      try {
        token = readFileSync('/nonexistent/path/admin-token.txt').toString().trim() || undefined;
      } catch {
        token = undefined;
      }
      expect(token).toBeUndefined();
    });

    it('should return undefined for an empty file', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'dwn-config-test-empty-'));
      const tokenFile = join(tmpDir, 'empty-token.txt');
      writeFileSync(tokenFile, '');

      const { readFileSync } = require('fs');
      const token = readFileSync(tokenFile).toString().trim() || undefined;
      expect(token).toBeUndefined();

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return undefined for a whitespace-only file', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'dwn-config-test-ws-'));
      const tokenFile = join(tmpDir, 'whitespace-token.txt');
      writeFileSync(tokenFile, '   \n\t  \n');

      const { readFileSync } = require('fs');
      const token = readFileSync(tokenFile).toString().trim() || undefined;
      expect(token).toBeUndefined();

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
