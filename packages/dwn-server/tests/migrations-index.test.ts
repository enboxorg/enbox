import { join } from 'node:path';
import { readdir } from 'node:fs/promises';

import { describe, expect, it } from 'bun:test';

import { allServerMigrations } from '../src/migrations/index.js';

const migrationNamePattern = /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function getMigrationFilenames(migrationsPath: string): Promise<string[]> {
  const entries = await readdir(migrationsPath);
  return entries
    .filter((entry): boolean => entry.endsWith('.ts') && entry !== 'index.ts')
    .sort();
}

function getServerMigrationNames(): string[] {
  return allServerMigrations.map(([name]): string => name);
}

describe('allServerMigrations', (): void => {
  it('should use unique ordered migration names with numeric prefixes', (): void => {
    const names = getServerMigrationNames();

    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);

    for (const name of names) {
      expect(name).toMatch(migrationNamePattern);
    }
  });

  it('should keep migration filenames aligned with persisted migration names', async (): Promise<void> => {
    const migrationsPath = join(import.meta.dir, '..', 'src', 'migrations');
    const filenames = await getMigrationFilenames(migrationsPath);
    const expectedFilenames = getServerMigrationNames().map((name): string => `${name}.ts`);

    expect(filenames).toEqual(expectedFilenames);
  });
});
