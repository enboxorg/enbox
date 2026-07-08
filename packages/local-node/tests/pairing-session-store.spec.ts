import { join } from 'node:path';
import { LocalNodePairingSessionFile } from '../src/pairing-session-store.js';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';

describe('LocalNodePairingSessionFile', () => {
  let tempDirs: string[] = [];

  async function createTempFilePath(): Promise<string> {
    const tempDir = await mkdtemp(join(tmpdir(), 'enbox-local-node-sessions-'));
    tempDirs.push(tempDir);
    return join(tempDir, 'sessions.json');
  }

  afterEach(async () => {
    await Promise.all(tempDirs.map(async (tempDir): Promise<void> => {
      await rm(tempDir, { force: true, recursive: true });
    }));
    tempDirs = [];
  });

  it('should return an empty session list when the file is missing', async () => {
    const file = new LocalNodePairingSessionFile(await createTempFilePath());

    expect(await file.read()).toEqual([]);
  });

  it('should write and read origin-bound pairing sessions', async () => {
    const filePath = await createTempFilePath();
    const file = new LocalNodePairingSessionFile(filePath);
    const expectedSessions = [{
      createdAt : 1234,
      origin    : 'https://app.example',
      token     : 'token-1',
    }];
    const sessions = [{
      createdAt : 1234,
      origin    : 'https://app.example',
      token     : 'token-1',
    }, {
      createdAt : 5678,
      token     : 'local-discovery-token',
    }];

    await file.write(sessions);

    expect(await file.read()).toEqual(expectedSessions);
    expect(JSON.parse(await readFile(filePath, 'utf-8'))).toEqual({
      sessions : expectedSessions,
      version  : 1,
    });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it('should remove corrupt or malformed session files', async () => {
    const corruptPath = await createTempFilePath();
    const corruptFile = new LocalNodePairingSessionFile(corruptPath);
    await writeFile(corruptPath, '{');

    expect(await corruptFile.read()).toEqual([]);
    await expect(readFile(corruptPath, 'utf-8')).rejects.toThrow();

    const malformedPath = await createTempFilePath();
    const malformedFile = new LocalNodePairingSessionFile(malformedPath);
    await writeFile(malformedPath, JSON.stringify({
      sessions : [{ createdAt: 1234, token: 'missing-origin' }],
      version  : 1,
    }));

    expect(await malformedFile.read()).toEqual([]);
    await expect(readFile(malformedPath, 'utf-8')).rejects.toThrow();
  });
});
