import type { CatalogGitReader } from '../src/catalog/catalog-preflight.js';
import type { HistoricalDwnArtifact } from '../src/catalog/types.js';
import type {
  CatalogImageRuntime,
  CatalogLocalImage,
  CatalogSourceMaterializer,
  CatalogSourceTreeHasher,
} from '../src/catalog/build.js';

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'bun:test';
import { getHistoricalArtifactBuildKey, prepareHistoricalArtifact } from '../src/catalog/build.js';

const encoder = new TextEncoder();
const lockContents = encoder.encode(JSON.stringify({ lockfileVersion: 1 }));
const lockSha256 = createHash('sha256').update(lockContents).digest('hex');
const pinnedDigest = `sha256:${'a'.repeat(64)}`;
const imageId = `sha256:${'b'.repeat(64)}`;

function createArtifact(immutableBase = false): HistoricalDwnArtifact {
  return {
    build: {
      baseImages: [{
        digest    : immutableBase ? pinnedDigest : null,
        reference : 'example.invalid/bun:1',
        stages    : ['runtime'],
      }],
      context    : '.',
      dockerfile : {
        gitObject : '4444444444444444444444444444444444444444',
        path      : 'Dockerfile',
      },
      installCommand    : ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
      packageBuildOrder : ['@enbox/dwn-server'],
    },
    capabilities   : [],
    dependencyLock : {
      formatVersion : 1,
      gitObject     : '3333333333333333333333333333333333333333',
      path          : 'bun.lock',
      sha256        : lockSha256,
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
      requiredProofs : [],
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
    sourceFiles : [],
    toolchain   : { bun: '1.3.14' },
  };
}

function createGitReader(artifact: HistoricalDwnArtifact): CatalogGitReader {
  const objects = new Map<string, string>([
    [`${artifact.source.commit}^{commit}`, artifact.source.commit],
    [`${artifact.source.commit}^{tree}`, artifact.source.tree],
    [`${artifact.source.commit}:${artifact.source.rootPackageJson.path}`, artifact.source.rootPackageJson.gitObject],
    [`${artifact.source.commit}:${artifact.dependencyLock.path}`, artifact.dependencyLock.gitObject],
    [`${artifact.source.commit}:${artifact.build.dockerfile.path}`, artifact.build.dockerfile.gitObject],
    [`${artifact.source.commit}:packages/dwn-server`, artifact.packages['@enbox/dwn-server'].sourceTree],
  ]);
  const files = new Map<string, Uint8Array>([
    ['bun.lock', lockContents],
    ['package.json', encoder.encode(JSON.stringify({ packageManager: 'bun@1.3.14' }))],
    ['packages/dwn-server/package.json', encoder.encode(JSON.stringify({ name: '@enbox/dwn-server', version: '1.2.3' }))],
  ]);
  return {
    async readFile(_commit, path): Promise<Uint8Array | undefined> {
      return files.get(path);
    },
    async resolveObject(specification): Promise<string | undefined> {
      return objects.get(specification);
    },
  };
}

function dockerfile(immutableBase: boolean): string {
  const base = immutableBase ? `example.invalid/bun:1@${pinnedDigest}` : 'example.invalid/bun:1';
  return `FROM ${base} AS runtime\nRUN bun install --frozen-lockfile --ignore-scripts\n`;
}

function createMaterializer(params: {
  calls: string[];
  immutableBase: boolean;
  lock?: Uint8Array;
}): CatalogSourceMaterializer {
  return {
    async materialize({ commit, destination }): Promise<void> {
      params.calls.push(commit);
      await Promise.all([
        writeFile(join(destination, 'bun.lock'), params.lock ?? lockContents),
        writeFile(join(destination, 'Dockerfile'), dockerfile(params.immutableBase)),
      ]);
    },
  };
}

class FakeImageRuntime implements CatalogImageRuntime {
  public buildCalls = 0;
  public readonly images = new Map<string, CatalogLocalImage>();

  public async build(params: {
    contextArchive: Blob;
    contextPath: string;
    dockerfilePath: string;
    labels: Readonly<Record<string, string>>;
  }): Promise<CatalogLocalImage> {
    this.buildCalls += 1;
    expect(params.contextPath).toContain('source');
    expect(params.contextArchive.size).toBeGreaterThan(0);
    expect(await readFile(join(params.contextPath, params.dockerfilePath), 'utf8')).toContain(`@${pinnedDigest}`);
    const image = { id: imageId, labels: params.labels };
    this.images.set(imageId, image);
    return image;
  }

  public async inspect(reference: string): Promise<CatalogLocalImage | undefined> {
    return this.images.get(reference);
  }

  public async tag(id: string, tag: string): Promise<void> {
    const image = this.images.get(id);
    if (image === undefined) {
      throw new Error(`unknown image '${id}'`);
    }
    this.images.set(tag, image);
  }
}

function createTreeHasher(artifact: HistoricalDwnArtifact, tree = artifact.source.tree): CatalogSourceTreeHasher {
  return {
    async hash(): Promise<string> {
      return tree;
    },
  };
}

let directories: string[] = [];

async function createPaths(): Promise<{ directory: string; outputRoot: string; repositoryRoot: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'enbox-lab-catalog-build-'));
  directories.push(directory);
  const repositoryRoot = join(directory, 'repository');
  const outputRoot = join(directory, 'output');
  await mkdir(repositoryRoot);
  await writeFile(join(repositoryRoot, 'sentinel'), 'untouched');
  return { directory, outputRoot, repositoryRoot };
}

describe('Historical artifact build harness', () => {
  afterEach(async () => {
    await Promise.all(directories.map((directory): Promise<void> => rm(directory, { force: true, recursive: true })));
    directories = [];
  });

  it('should materialize the exact closure and report mutable historical bases as unsupported', async () => {
    const artifact = createArtifact();
    const calls: string[] = [];
    const paths = await createPaths();
    const images = new FakeImageRuntime();
    const result = await prepareHistoricalArtifact({ artifact, ...paths }, {
      git          : createGitReader(artifact),
      images,
      materializer : createMaterializer({ calls, immutableBase: false }),
      now          : (): Date => new Date('2026-09-20T12:00:00.000Z'),
      treeHasher   : createTreeHasher(artifact),
    });

    expect(result.status).toBe('unsupported');
    expect(result.sourceArchivePath).toBe(join(paths.outputRoot, artifact.id, getHistoricalArtifactBuildKey(artifact), 'source.tar'));
    expect(calls).toEqual([artifact.source.commit]);
    expect(images.buildCalls).toBe(0);
    expect((await lstat(result.sourceArchivePath!)).isFile()).toBe(true);
    expect(await readFile(join(paths.repositoryRoot, 'sentinel'), 'utf8')).toBe('untouched');
    expect(result.checks.find((check): boolean => check.id.endsWith('.materialized-lock-closure'))?.status).toBe('pass');
    expect(result.checks.find((check): boolean => check.id.endsWith('.immutable-image-inputs'))?.status).toBe('unsupported');
  });

  it('should build once, assign a closure-derived tag, and reuse the verified image', async () => {
    const artifact = createArtifact(true);
    const calls: string[] = [];
    const paths = await createPaths();
    const images = new FakeImageRuntime();
    const dependencies = {
      git          : createGitReader(artifact),
      images,
      materializer : createMaterializer({ calls, immutableBase: true }),
      treeHasher   : createTreeHasher(artifact),
    };

    const first = await prepareHistoricalArtifact({ artifact, ...paths }, dependencies);
    const second = await prepareHistoricalArtifact({ artifact, ...paths }, dependencies);

    expect(first.status).toBe('pass');
    expect(first.image?.id).toBe(imageId);
    expect(first.image?.immutableReference).toBe(imageId);
    expect(first.image?.tag).toBe(
      `enbox-lab/historical-test-server:${getHistoricalArtifactBuildKey(artifact).slice(0, 32)}-${imageId.slice('sha256:'.length)}`,
    );
    expect(second.status).toBe('pass');
    expect(second.image).toEqual(first.image);
    expect(calls).toEqual([artifact.source.commit]);
    expect(images.buildCalls).toBe(2);
    expect(second.checks.find((check): boolean => check.id.endsWith('.immutable-local-image'))?.details?.tagReused).toBe(true);
  });

  it('should fail closed when a deterministic image tag has conflicting closure labels', async () => {
    const artifact = createArtifact(true);
    const paths = await createPaths();
    const images = new FakeImageRuntime();
    const tag = `enbox-lab/historical-test-server:${getHistoricalArtifactBuildKey(artifact).slice(0, 32)}-${imageId.slice('sha256:'.length)}`;
    images.images.set(tag, { id: `sha256:${'c'.repeat(64)}`, labels: { 'org.enbox.lab.build-key': 'different' } });
    const result = await prepareHistoricalArtifact({ artifact, ...paths }, {
      git          : createGitReader(artifact),
      images,
      materializer : createMaterializer({ calls: [], immutableBase: true }),
      treeHasher   : createTreeHasher(artifact),
    });

    expect(result.status).toBe('fail');
    expect(result.image).toBeNull();
    expect(images.buildCalls).toBe(1);
    expect(result.checks.find((check): boolean => check.id.endsWith('.immutable-local-image'))?.summary).toContain('occupied');
  });

  it('should reject changed materialized lock bytes before invoking Docker', async () => {
    const artifact = createArtifact(true);
    const paths = await createPaths();
    const images = new FakeImageRuntime();
    const result = await prepareHistoricalArtifact({ artifact, ...paths }, {
      git          : createGitReader(artifact),
      images,
      materializer : createMaterializer({
        calls         : [],
        immutableBase : true,
        lock          : encoder.encode(JSON.stringify({ lockfileVersion: 1, changed: true })),
      }),
      treeHasher: createTreeHasher(artifact),
    });

    expect(result.status).toBe('fail');
    expect(images.buildCalls).toBe(0);
    expect(result.checks.find((check): boolean => check.id.endsWith('.materialized-lock-closure'))?.status).toBe('fail');
  });

  it('should reject a sealed context whose complete Git tree differs from the source pin', async () => {
    const artifact = createArtifact(true);
    const paths = await createPaths();
    const images = new FakeImageRuntime();
    const result = await prepareHistoricalArtifact({ artifact, ...paths }, {
      git          : createGitReader(artifact),
      images,
      materializer : createMaterializer({ calls: [], immutableBase: true }),
      treeHasher   : createTreeHasher(artifact, '8888888888888888888888888888888888888888'),
    });

    expect(result.status).toBe('fail');
    expect(images.buildCalls).toBe(0);
    expect(result.checks.find((check): boolean => check.id.endsWith('.materialized-source-tree'))?.status).toBe('fail');
  });

  it('should reject an output root inside the repository before materializing source', async () => {
    const artifact = createArtifact();
    const paths = await createPaths();
    const calls: string[] = [];
    const result = await prepareHistoricalArtifact({
      artifact,
      outputRoot     : join(paths.repositoryRoot, 'generated'),
      repositoryRoot : paths.repositoryRoot,
    }, {
      git          : createGitReader(artifact),
      materializer : createMaterializer({ calls, immutableBase: false }),
    });

    expect(result.status).toBe('fail');
    expect(result.sourceArchivePath).toBeNull();
    expect(calls).toEqual([]);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].id).toBe('test-server.isolated-output');
  });

  it('should resolve symlinks before enforcing worktree isolation', async () => {
    const artifact = createArtifact();
    const paths = await createPaths();
    const calls: string[] = [];
    const redirectedOutput = join(paths.directory, 'redirected-output');
    await symlink(paths.repositoryRoot, redirectedOutput, 'dir');
    const result = await prepareHistoricalArtifact({
      artifact,
      outputRoot     : join(redirectedOutput, 'generated'),
      repositoryRoot : paths.repositoryRoot,
    }, {
      git          : createGitReader(artifact),
      materializer : createMaterializer({ calls, immutableBase: false }),
    });

    expect(result.status).toBe('fail');
    expect(calls).toEqual([]);
    expect(result.checks[0].id).toBe('test-server.isolated-output');
  });

  it('should reject a dangling output symlink that targets an uncreated repository path', async () => {
    const artifact = createArtifact();
    const paths = await createPaths();
    const calls: string[] = [];
    const redirectedOutput = join(paths.directory, 'dangling-output');
    await symlink(join(paths.repositoryRoot, 'not-created'), redirectedOutput, 'dir');
    const result = await prepareHistoricalArtifact({
      artifact,
      outputRoot     : join(redirectedOutput, 'generated'),
      repositoryRoot : paths.repositoryRoot,
    }, {
      git          : createGitReader(artifact),
      materializer : createMaterializer({ calls, immutableBase: false }),
    });

    expect(result.status).toBe('fail');
    expect(calls).toEqual([]);
    expect(result.checks[0].id).toBe('test-server.isolated-output');
  });
});
