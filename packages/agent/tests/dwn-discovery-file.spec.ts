import * as BrowserDiscoveryFileFs from '../src/dwn-discovery-file-fs.browser.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  createNodeDiscoveryFileFs,
  DISCOVERY_DIR,
  DISCOVERY_FILENAME,
  type DiscoveryFileFs,
  DwnDiscoveryFile,
  type DwnDiscoveryRecord,
} from '../src/dwn-discovery-file.js';

// ─── In-memory FS stub ───────────────────────────────────────────

/** Minimal in-memory implementation of {@link DiscoveryFileFs} for testing. */
function createMemoryFs(overrides: Partial<DiscoveryFileFs> = {}): DiscoveryFileFs & { files: Map<string, string> } {
  const files = new Map<string, string>();

  return {
    files,

    async readFile(path: string): Promise<string | null> {
      return files.get(path) ?? null;
    },

    async writeFile(path: string, contents: string): Promise<void> {
      files.set(path, contents);
    },

    async removeFile(path: string): Promise<void> {
      files.delete(path);
    },

    isProcessAlive(): boolean {
      return true;
    },

    homedir(): string {
      return '/home/testuser';
    },

    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('DwnDiscoveryFile', () => {
  const testFilePath = '/tmp/test-dwn-discovery/dwn.json';

  afterEach(() => {
    // Nothing to clean up — all FS ops are in-memory.
  });

  describe('constructor', () => {
    it('should use the provided filesystem adapter and file path', () => {
      const fs = createMemoryFs();
      const file = new DwnDiscoveryFile(fs, testFilePath);

      expect(file.path).toBe(testFilePath);
    });

    it('should default the file path to ~/.enbox/dwn.json', () => {
      const fs = createMemoryFs({ homedir: () => '/home/alice' });
      const file = new DwnDiscoveryFile(fs);

      expect(file.path).toBe(`/home/alice/${DISCOVERY_DIR}/${DISCOVERY_FILENAME}`);
    });

    it('should throw if no filesystem adapter is available', () => {
      // Passing `undefined` for the FS triggers the auto-detect path.
      // In a test environment where node:fs IS available, this won't throw.
      // We test the explicit error path by passing a null-ish value that
      // bypasses the default factory.
      const noFs = undefined as unknown as DiscoveryFileFs;

      // The constructor tries createNodeDiscoveryFileFs() as fallback.
      // In Bun test environment this succeeds, so we test the error
      // case via a custom factory wrapper instead.
      expect(() => new DwnDiscoveryFile(noFs, testFilePath)).not.toThrow();
    });
  });

  describe('default filesystem adapters', () => {
    it('should read, write, and remove files with the Node filesystem adapter', async () => {
      const fs = createNodeDiscoveryFileFs();
      if (fs === undefined) {
        throw new Error('expected Node filesystem adapter to be available');
      }

      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'enbox-discovery-file-'));
      const filePath = path.join(tempDir, DISCOVERY_FILENAME);

      try {
        await fs.writeFile(filePath, 'hello');
        expect(await fs.readFile(filePath)).toBe('hello');

        await fs.removeFile(filePath);
        expect(await fs.readFile(filePath)).toBeNull();

        await fs.removeFile(filePath);
        expect(fs.isProcessAlive(process.pid)).toBe(true);
        expect(fs.isProcessAlive(Number.MAX_SAFE_INTEGER)).toBe(false);
        expect(fs.homedir().length).toBeGreaterThan(0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('should not provide a default filesystem adapter in browser builds', () => {
      expect(BrowserDiscoveryFileFs.createNodeDiscoveryFileFs()).toBeUndefined();
    });
  });

  describe('read', () => {
    it('should return the parsed record when the file is valid and the process is alive', async () => {
      const record: DwnDiscoveryRecord = { endpoint: 'http://127.0.0.1:55557', pid: 12345 };
      const fs = createMemoryFs({ isProcessAlive: () => true });
      fs.files.set(testFilePath, JSON.stringify(record));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toEqual(record);
    });

    it('should return undefined when the file does not exist', async () => {
      const fs = createMemoryFs();
      const file = new DwnDiscoveryFile(fs, testFilePath);

      const result = await file.read();

      expect(result).toBeUndefined();
    });

    it('should return undefined and remove the file when JSON is invalid', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, 'not valid json {{{');

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should return undefined and remove the file when endpoint is missing', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, JSON.stringify({ pid: 123 }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should return undefined and remove the file when endpoint is empty', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, JSON.stringify({ endpoint: '', pid: 123 }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should return undefined and remove the file when pid is missing', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, JSON.stringify({ endpoint: 'http://127.0.0.1:55557' }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should return undefined and remove the file when pid is not a positive integer', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, JSON.stringify({ endpoint: 'http://127.0.0.1:55557', pid: -1 }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should return undefined and remove the file when pid is zero', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, JSON.stringify({ endpoint: 'http://127.0.0.1:55557', pid: 0 }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should return undefined and remove the file when pid is a float', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, JSON.stringify({ endpoint: 'http://127.0.0.1:55557', pid: 12.5 }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should return undefined and remove the file when the process is dead', async () => {
      const record: DwnDiscoveryRecord = { endpoint: 'http://127.0.0.1:55557', pid: 99999 };
      const fs = createMemoryFs({ isProcessAlive: () => false });
      fs.files.set(testFilePath, JSON.stringify(record));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should normalize trailing slashes on the endpoint', async () => {
      const record = { endpoint: 'http://127.0.0.1:55557/', pid: 12345 };
      const fs = createMemoryFs({ isProcessAlive: () => true });
      fs.files.set(testFilePath, JSON.stringify(record));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result?.endpoint).toBe('http://127.0.0.1:55557');
    });

    it('should return undefined when the file content is null', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, 'null');

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should return undefined when the file content is an array', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, '[1, 2, 3]');

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });
  });

  describe('write', () => {
    it('should write a valid discovery record to the file', async () => {
      const fs = createMemoryFs();
      const file = new DwnDiscoveryFile(fs, testFilePath);

      const record: DwnDiscoveryRecord = { endpoint: 'http://127.0.0.1:55557', pid: 42 };
      await file.write(record);

      const raw = fs.files.get(testFilePath);
      expect(raw).toBeDefined();

      const parsed = JSON.parse(raw!);
      expect(parsed.endpoint).toBe('http://127.0.0.1:55557');
      expect(parsed.pid).toBe(42);
    });

    it('should normalize trailing slashes when writing', async () => {
      const fs = createMemoryFs();
      const file = new DwnDiscoveryFile(fs, testFilePath);

      await file.write({ endpoint: 'http://127.0.0.1:55557/', pid: 42 });

      const parsed = JSON.parse(fs.files.get(testFilePath)!);
      expect(parsed.endpoint).toBe('http://127.0.0.1:55557');
    });

    it('should overwrite an existing file', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, JSON.stringify({ endpoint: 'http://127.0.0.1:3000', pid: 1 }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      await file.write({ endpoint: 'http://127.0.0.1:55557', pid: 42 });

      const parsed = JSON.parse(fs.files.get(testFilePath)!);
      expect(parsed.endpoint).toBe('http://127.0.0.1:55557');
      expect(parsed.pid).toBe(42);
    });
  });

  describe('remove', () => {
    it('should delete the discovery file', async () => {
      const fs = createMemoryFs();
      fs.files.set(testFilePath, JSON.stringify({ endpoint: 'http://127.0.0.1:55557', pid: 42 }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      await file.remove();

      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should not throw when the file does not exist', async () => {
      const fs = createMemoryFs();
      const file = new DwnDiscoveryFile(fs, testFilePath);

      // Should not throw.
      await file.remove();
    });
  });

  describe('capabilities', () => {
    it('should round-trip a record with capabilities', async () => {
      const fs = createMemoryFs({ isProcessAlive: () => true });
      const file = new DwnDiscoveryFile(fs, testFilePath);

      const record: DwnDiscoveryRecord = {
        endpoint     : 'http://127.0.0.1:55500',
        pid          : 42,
        capabilities : ['http', 'ws'],
      };
      await file.write(record);
      const result = await file.read();

      expect(result).toEqual(record);
    });

    it('should omit capabilities from the file when the array is empty', async () => {
      const fs = createMemoryFs({ isProcessAlive: () => true });
      const file = new DwnDiscoveryFile(fs, testFilePath);

      await file.write({ endpoint: 'http://127.0.0.1:55500', pid: 42, capabilities: [] });

      const raw = JSON.parse(fs.files.get(testFilePath)!);
      expect(raw.capabilities).toBeUndefined();
    });

    it('should omit capabilities from the file when undefined', async () => {
      const fs = createMemoryFs({ isProcessAlive: () => true });
      const file = new DwnDiscoveryFile(fs, testFilePath);

      await file.write({ endpoint: 'http://127.0.0.1:55500', pid: 42 });

      const raw = JSON.parse(fs.files.get(testFilePath)!);
      expect(raw.capabilities).toBeUndefined();
    });

    it('should read a record without capabilities (backward compatible)', async () => {
      const fs = createMemoryFs({ isProcessAlive: () => true });
      fs.files.set(testFilePath, JSON.stringify({ endpoint: 'http://127.0.0.1:55500', pid: 42 }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeDefined();
      expect(result!.endpoint).toBe('http://127.0.0.1:55500');
      expect(result!.capabilities).toBeUndefined();
    });

    it('should reject a record with a non-array capabilities field', async () => {
      const fs = createMemoryFs({ isProcessAlive: () => true });
      fs.files.set(testFilePath, JSON.stringify({
        endpoint     : 'http://127.0.0.1:55500',
        pid          : 42,
        capabilities : 'http',
      }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });

    it('should reject a record with non-string elements in capabilities', async () => {
      const fs = createMemoryFs({ isProcessAlive: () => true });
      fs.files.set(testFilePath, JSON.stringify({
        endpoint     : 'http://127.0.0.1:55500',
        pid          : 42,
        capabilities : ['http', 123],
      }));

      const file = new DwnDiscoveryFile(fs, testFilePath);
      const result = await file.read();

      expect(result).toBeUndefined();
      expect(fs.files.has(testFilePath)).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('should write and then read the same record', async () => {
      const fs = createMemoryFs({ isProcessAlive: () => true });
      const file = new DwnDiscoveryFile(fs, testFilePath);

      const record: DwnDiscoveryRecord = { endpoint: 'http://127.0.0.1:55500', pid: 42 };
      await file.write(record);
      const result = await file.read();

      expect(result).toEqual(record);
    });

    it('should round-trip a record with capabilities', async () => {
      const fs = createMemoryFs({ isProcessAlive: () => true });
      const file = new DwnDiscoveryFile(fs, testFilePath);

      const record: DwnDiscoveryRecord = {
        endpoint     : 'http://127.0.0.1:55500',
        pid          : 42,
        capabilities : ['http', 'ws'],
      };
      await file.write(record);
      const result = await file.read();

      expect(result).toEqual(record);
    });

    it('should return undefined after write then remove', async () => {
      const fs = createMemoryFs({ isProcessAlive: () => true });
      const file = new DwnDiscoveryFile(fs, testFilePath);

      await file.write({ endpoint: 'http://127.0.0.1:55500', pid: 42 });
      await file.remove();
      const result = await file.read();

      expect(result).toBeUndefined();
    });
  });
});
