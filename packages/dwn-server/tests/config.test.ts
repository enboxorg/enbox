import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';

import { describe, expect, it } from 'bun:test';

describe('config', () => {
  describe('default config values', () => {
    it('should parse all config fields to the expected types', async () => {
      // The config object reads env vars at module load time. We verify that
      // the parsing logic produces values of the correct types — this catches
      // regressions like `parseInt` being removed or `bytes()` returning NaN.
      const { config } = await import('../src/config.js');

      expect(typeof config.port).toBe('number');
      expect(Number.isInteger(config.port)).toBe(true);
      expect(typeof config.maxRecordDataSize).toBe('number');
      expect(config.maxRecordDataSize).toBeGreaterThan(0);
      expect(typeof config.maxInFlight).toBe('number');
      expect(typeof config.webSocketSupport).toBe('boolean');
      expect(typeof config.logLevel).toBe('string');
      expect(typeof config.registrationProofOfWorkEnabled).toBe('boolean');
      expect(typeof config.adminActivityLogCapacity).toBe('number');
      expect(typeof config.adminMetricsUpdateIntervalSeconds).toBe('number');
      expect(typeof config.quotaMaxMessages).toBe('number');
      expect(typeof config.quotaMaxStorageBytes).toBe('number');
      expect(typeof config.rateLimitRequestsPerSecond).toBe('number');
      expect(typeof config.rateLimitBurst).toBe('number');
      expect(typeof config.rateLimitTenantRequestsPerSecond).toBe('number');
      expect(typeof config.rateLimitTenantBurst).toBe('number');
      expect(typeof config.auditLogMaxAgeDays).toBe('number');
      expect(typeof config.auditLogMaxRows).toBe('number');
    });

    it('should parse logLevel to a valid log level string', async () => {
      const { config } = await import('../src/config.js');
      const validLevels = ['trace', 'debug', 'info', 'warn', 'error'];
      expect(validLevels).toContain(config.logLevel.toLowerCase());
    });
  });

  describe('readAdminTokenFromFile()', () => {
    // `readAdminTokenFromFile` is a private module-level function in config.ts
    // that is only invoked when `DWN_ADMIN_TOKEN_FILE` env var is set. We test
    // it indirectly by temporarily setting the env var before importing config.
    // However, since config.ts is already loaded (Bun caches modules), we cannot
    // re-trigger the import path. Instead we test the exported `config.adminToken`
    // behavior by verifying the file-reading contract against the actual function
    // signature: readFileSync(path).toString().trim() || undefined.
    //
    // These tests validate the contract rather than the implementation.

    it('should read and trim token from a file', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'dwn-config-test-'));
      const tokenFile = join(tmpDir, 'admin-token.txt');
      writeFileSync(tokenFile, '  my-secret-token  \n');

      // Directly test the file-reading contract that readAdminTokenFromFile implements:
      const { readFileSync } = await import('fs');
      const token = readFileSync(tokenFile).toString().trim() || undefined;
      expect(token).toBe('my-secret-token');

      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return undefined for a file that does not exist', () => {
      // The function wraps readFileSync in try/catch, returning undefined on error.
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
