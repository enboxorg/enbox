import { join } from 'node:path';
import { runDoctor } from '../src/doctor.js';
import { tmpdir } from 'node:os';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'bun:test';

describe('Lab doctor', () => {
  it('should pass when pinned prerequisites are available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-doctor-'));
    const executable = join(directory, 'chromium');
    await writeFile(executable, '');
    await chmod(executable, 0o700);

    try {
      const report = await runDoctor({
        architecture          : 'arm64',
        browserExecutablePath : executable,
        now                   : (): Date => new Date('2026-09-20T12:00:00.000Z'),
        platform              : 'darwin',
        runCommand            : async (command): Promise<{ exitCode: number; stderr: string; stdout: string }> => ({
          exitCode : 0,
          stderr   : '',
          stdout   : command[0] === 'bun' ? '1.3.14' : 'available',
        }),
      });

      expect(report.status).toBe('pass');
      expect(report.checks).toHaveLength(5);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('should fail when Docker cannot reach its daemon', async () => {
    const report = await runDoctor({
      architecture          : 'x64',
      browserExecutablePath : '/missing/chromium',
      platform              : 'linux',
      runCommand            : async (command): Promise<{ exitCode: number; stderr: string; stdout: string }> => command[0] === 'bun'
        ? { exitCode: 0, stderr: '', stdout: '1.3.14' }
        : { exitCode: 1, stderr: 'permission denied', stdout: '' },
    });

    expect(report.status).toBe('fail');
    expect(report.checks.find((check): boolean => check.id === 'docker-engine')).toMatchObject({
      status  : 'fail',
      summary : 'Docker Engine is unavailable',
    });
  });

  it('should report unsupported platforms distinctly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-doctor-'));
    const executable = join(directory, 'chromium');
    await writeFile(executable, '');
    await chmod(executable, 0o700);

    try {
      const report = await runDoctor({
        architecture          : 's390x',
        browserExecutablePath : executable,
        platform              : 'freebsd',
        runCommand            : async (command): Promise<{ exitCode: number; stderr: string; stdout: string }> => ({
          exitCode : 0,
          stderr   : '',
          stdout   : command[0] === 'bun' ? '1.3.14' : 'available',
        }),
      });

      expect(report.status).toBe('unsupported');
      expect(report.checks.find((check): boolean => check.id === 'platform')?.status).toBe('unsupported');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
