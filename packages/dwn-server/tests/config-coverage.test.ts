import { describe, expect, it } from 'bun:test';

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';

/**
 * Tests for `readAdminTokenFromFile` (config.ts lines 233-236).
 *
 * The function is only called at module load time when `DWN_ADMIN_TOKEN_FILE`
 * is set. Because Bun caches modules, re-importing in the same process doesn't
 * re-execute the top-level code. We use `Bun.spawn` to run a fresh process
 * that imports config with the env var set and prints `config.adminToken`.
 */
describe('config — readAdminTokenFromFile coverage', () => {
  const serverDir = join(import.meta.dir, '..');

  it('should read adminToken from file when DWN_ADMIN_TOKEN_FILE is set', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dwn-config-cov-'));
    const tokenFile = join(tmpDir, 'token.txt');
    writeFileSync(tokenFile, '  file-based-token  \n');

    const proc = Bun.spawn(
      ['bun', '-e', 'import { config } from "./src/config.js"; process.stdout.write(JSON.stringify({ t: config.adminToken }))'],
      {
        cwd    : serverDir,
        env    : { ...process.env, DWN_ADMIN_TOKEN: '', DWN_ADMIN_TOKEN_FILE: tokenFile },
        stdout : 'pipe',
        stderr : 'pipe',
      },
    );

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Subprocess failed (exit ${exitCode}): ${stderr}`);
    }

    const result = JSON.parse(output);
    expect(result.t).toBe('file-based-token');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return undefined adminToken when DWN_ADMIN_TOKEN_FILE points to nonexistent file', async () => {
    const proc = Bun.spawn(
      ['bun', '-e', 'import { config } from "./src/config.js"; process.stdout.write(JSON.stringify({ t: config.adminToken ?? null }))'],
      {
        cwd    : serverDir,
        env    : { ...process.env, DWN_ADMIN_TOKEN: '', DWN_ADMIN_TOKEN_FILE: '/nonexistent/path/token.txt' },
        stdout : 'pipe',
        stderr : 'pipe',
      },
    );

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Subprocess failed (exit ${exitCode}): ${stderr}`);
    }

    const result = JSON.parse(output);
    expect(result.t).toBeNull();
  });

  it('should return undefined adminToken when DWN_ADMIN_TOKEN_FILE points to empty file', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'dwn-config-cov-empty-'));
    const tokenFile = join(tmpDir, 'empty.txt');
    writeFileSync(tokenFile, '');

    const proc = Bun.spawn(
      ['bun', '-e', 'import { config } from "./src/config.js"; process.stdout.write(JSON.stringify({ t: config.adminToken ?? null }))'],
      {
        cwd    : serverDir,
        env    : { ...process.env, DWN_ADMIN_TOKEN: '', DWN_ADMIN_TOKEN_FILE: tokenFile },
        stdout : 'pipe',
        stderr : 'pipe',
      },
    );

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Subprocess failed (exit ${exitCode}): ${stderr}`);
    }

    const result = JSON.parse(output);
    expect(result.t).toBeNull();

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
