import type { CatalogGitReader } from '../src/catalog/catalog-preflight.js';
import type { HistoricalDwnArtifact } from '../src/catalog/types.js';

import { createHash } from 'node:crypto';
import { historicalDwnArtifacts } from '../src/catalog/historical-artifacts.js';
import { runCatalogPreflight } from '../src/catalog/catalog-preflight.js';
import { describe, expect, it } from 'bun:test';

const encoder = new TextEncoder();
const lockContents = encoder.encode('{"lockfileVersion":1}');

function createArtifact(): HistoricalDwnArtifact {
  return {
    build: {
      baseImages : [{ digest: null, reference: 'example.invalid/bun:mutable', stages: ['build', 'runtime'] }],
      context    : '.',
      dockerfile : {
        gitObject : '4444444444444444444444444444444444444444',
        path      : 'Dockerfile',
      },
      installCommand    : ['bun', 'install', '--frozen-lockfile'],
      packageBuildOrder : ['@enbox/dwn-server'],
    },
    capabilities: [{
      evidence: [{
        gitObject : '5555555555555555555555555555555555555555',
        path      : 'packages/dwn-server/src/dwn-server.ts',
      }],
      id            : 'message-processed-observer',
      notes         : 'requires a custom launcher',
      runtimeStatus : 'pending',
      sourceSupport : 'custom-launcher-required',
    }],
    dependencyLock: {
      formatVersion : 1,
      gitObject     : '3333333333333333333333333333333333333333',
      path          : 'bun.lock',
      sha256        : createHash('sha256').update(lockContents).digest('hex'),
    },
    id     : 'test-server',
    launch : {
      configuration  : {},
      customLauncher : null,
      infoEndpoint   : '/info',
      stockCommand   : ['bun', 'packages/dwn-server/dist/esm/src/main.js'],
    },
    packages: {
      '@enbox/dwn-server': {
        sourceTree : '6666666666666666666666666666666666666666',
        version    : '1.2.3',
      },
    },
    qualification: {
      evidence       : [],
      requiredProofs : ['run the server'],
      status         : 'pending',
    },
    role   : 'candidate',
    source : {
      commit          : '1111111111111111111111111111111111111111',
      rootPackageJson : {
        gitObject : '2222222222222222222222222222222222222222',
        path      : 'package.json',
      },
      tree: '7777777777777777777777777777777777777777',
    },
    sourceFiles: [{
      gitObject : '5555555555555555555555555555555555555555',
      path      : 'packages/dwn-server/src/dwn-server.ts',
    }],
    toolchain: { bun: '1.3.14' },
  };
}

function createGitReader(artifact: HistoricalDwnArtifact, lock = lockContents): CatalogGitReader {
  const objects = new Map<string, string>([
    [`${artifact.source.commit}^{commit}`, artifact.source.commit],
    [`${artifact.source.commit}^{tree}`, artifact.source.tree],
    [`${artifact.source.commit}:${artifact.source.rootPackageJson.path}`, artifact.source.rootPackageJson.gitObject],
    [`${artifact.source.commit}:${artifact.dependencyLock.path}`, artifact.dependencyLock.gitObject],
    [`${artifact.source.commit}:${artifact.build.dockerfile.path}`, artifact.build.dockerfile.gitObject],
    [`${artifact.source.commit}:packages/dwn-server`, artifact.packages['@enbox/dwn-server'].sourceTree],
    ...artifact.sourceFiles.map((pin): [string, string] => [`${artifact.source.commit}:${pin.path}`, pin.gitObject]),
  ]);
  const files = new Map<string, Uint8Array>([
    ['bun.lock', lock],
    ['package.json', encoder.encode(JSON.stringify({ packageManager: 'bun@1.3.14' }))],
    ['packages/dwn-server/package.json', encoder.encode(JSON.stringify({ name: '@enbox/dwn-server', version: '1.2.3' }))],
  ]);

  return {
    async readFile(_commit: string, path: string): Promise<Uint8Array | undefined> {
      return files.get(path);
    },
    async resolveObject(specification: string): Promise<string | undefined> {
      return objects.get(specification);
    },
  };
}

describe('Historical artifact catalog preflight', () => {
  it('should verify source, lock, and version pins without claiming runtime qualification', async () => {
    const artifact = createArtifact();
    const report = await runCatalogPreflight({
      artifacts : [artifact],
      git       : createGitReader(artifact),
      mode      : 'source',
      now       : (): Date => new Date('2026-09-20T12:00:00.000Z'),
    });

    expect(report.status).toBe('pass');
    expect(report.checks.every((check): boolean => check.status === 'pass')).toBe(true);
    expect(report.checks.find((check): boolean => check.id === 'test-server.capability-inventory')?.details).toEqual({
      inventory: JSON.stringify({
        'message-processed-observer': {
          runtimeStatus : 'pending',
          sourceSupport : 'custom-launcher-required',
        },
      }),
    });
  });

  it('should reject changed dependency-lock bytes', async () => {
    const artifact = createArtifact();
    const report = await runCatalogPreflight({
      artifacts : [artifact],
      git       : createGitReader(artifact, encoder.encode('changed')),
      mode      : 'source',
    });

    expect(report.status).toBe('fail');
    expect(report.checks.find((check): boolean => check.id === 'test-server.dependency-lock')?.status).toBe('fail');
  });

  it('should block fixture creation while image, launcher, and runtime evidence are absent', async () => {
    const artifact = createArtifact();
    const report = await runCatalogPreflight({
      artifacts : [artifact],
      git       : createGitReader(artifact),
      mode      : 'fixture',
    });

    expect(report.status).toBe('unsupported');
    expect(report.checks.filter((check): boolean => check.status === 'unsupported').map((check): string => check.id)).toEqual([
      'test-server.immutable-base-images',
      'test-server.observer-launcher',
      'test-server.runtime-qualification',
    ]);
  });

  it('should keep the two candidate source closures distinct and unqualified', () => {
    expect(historicalDwnArtifacts.map(({ source }): string => source.commit)).toEqual([
      'f9d159d75e7fd533f7b8db78a15c76f9e51a449e',
      '0ff8d4395bf9940ec888c3be4553b3c0eacde7f9',
    ]);
    const lockHashes = new Set(historicalDwnArtifacts.map(({ dependencyLock }): string => dependencyLock.sha256));
    expect(lockHashes.size).toBe(2);
    expect(historicalDwnArtifacts.every(({ qualification }): boolean => qualification.status === 'pending')).toBe(true);
  });
});
