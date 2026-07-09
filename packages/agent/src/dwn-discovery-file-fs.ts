import type { DiscoveryFileFs } from './dwn-discovery-file.js';

/**
 * Creates a {@link DiscoveryFileFs} backed by Node.js / Bun built-in modules.
 * Returns `undefined` when those modules are unavailable.
 */
export function createNodeDiscoveryFileFs(): DiscoveryFileFs | undefined {
  try {
    const nodeRequire = require;
    const fs = nodeRequire('node:fs/promises') as {
      chmod(path: string, mode: number): Promise<void>;
      readFile(path: string, encoding: string): Promise<string>;
      writeFile(path: string, data: string, options: { encoding: string; mode?: number }): Promise<void>;
      mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
      unlink(path: string): Promise<void>;
    };
    const path = nodeRequire('node:path') as {
      dirname(path: string): string;
    };
    const os = nodeRequire('node:os') as {
      homedir(): string;
    };

    return {
      async readFile(filePath: string): Promise<string | null> {
        try {
          return await fs.readFile(filePath, 'utf-8');
        } catch {
          return null;
        }
      },

      async writeFile(filePath: string, contents: string): Promise<void> {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        try {
          // Restrict a legacy file before replacing its contents so a newly
          // written bearer token is never briefly exposed under the old mode.
          await fs.chmod(filePath, 0o600);
        } catch (error: unknown) {
          const errorCode = typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined;
          if (errorCode !== 'ENOENT') {
            throw error;
          }
        }

        // mode 0o600: owner read/write only; this file may contain a bearer token.
        await fs.writeFile(filePath, contents, { encoding: 'utf-8', mode: 0o600 });
        // `mode` only applies when creating a file, so explicitly repair the
        // permissions when replacing a legacy discovery file as well.
        await fs.chmod(filePath, 0o600);
      },

      async removeFile(filePath: string): Promise<void> {
        try {
          await fs.unlink(filePath);
        } catch {
          // Ignore ENOENT; the file was already gone.
        }
      },

      isProcessAlive(pid: number): boolean {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },

      homedir(): string {
        return os.homedir();
      },
    };
  } catch {
    return undefined;
  }
}
