#!/usr/bin/env bun

import type { CatalogGitReader } from './catalog-preflight.js';
import type { Dirent } from 'node:fs';
import type { HistoricalDwnArtifact } from './types.js';
import type { LabCheck, LabProofReport, LabProofStatus } from '../proof-result.js';

import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';

import { createProofReport } from '../proof-result.js';
import { createCatalogGitReader, runCatalogPreflight } from './catalog-preflight.js';
import { getHistoricalDwnArtifact, historicalDwnArtifacts } from './historical-artifacts.js';

export type CatalogCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type CatalogLocalImage = {
  id: string;
  labels: Readonly<Record<string, string>>;
};

export interface CatalogImageRuntime {
  build(params: {
    contextArchive: Blob;
    contextPath: string;
    dockerfilePath: string;
    labels: Readonly<Record<string, string>>;
  }): Promise<CatalogLocalImage>;
  inspect(reference: string): Promise<CatalogLocalImage | undefined>;
  tag(imageId: string, tag: string): Promise<void>;
}

export interface CatalogSourceMaterializer {
  materialize(params: {
    commit: string;
    destination: string;
    repositoryRoot: string;
  }): Promise<void>;
}

export interface CatalogSourceTreeHasher {
  hash(contextPath: string): Promise<string>;
}

export type HistoricalArtifactBuildDependencies = {
  git?: CatalogGitReader;
  images?: CatalogImageRuntime;
  materializer?: CatalogSourceMaterializer;
  now?: () => Date;
  treeHasher?: CatalogSourceTreeHasher;
};

export type HistoricalArtifactBuildOptions = {
  artifact: HistoricalDwnArtifact;
  outputRoot: string;
  repositoryRoot: string;
};

export type PreparedHistoricalImage = {
  id: string;
  immutableReference: string;
  tag: string;
};

export type HistoricalArtifactBuildResult = LabProofReport & {
  artifactId: string;
  buildKey: string;
  image: PreparedHistoricalImage | null;
  sourceArchivePath: string | null;
};

type MaterializationResult = {
  archive: Blob;
  archivePath: string;
  cleanup(): Promise<void>;
  contextPath: string;
};

type ImagePreparationResult = {
  checks: LabCheck[];
  image: PreparedHistoricalImage | null;
};

type DockerImageInspect = {
  Config?: {
    Labels?: Record<string, string> | null;
  };
  Id?: string;
};

const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;

const usage = `bun packages/lab/src/catalog/build.ts --artifact <id> --output <path> [options]

Materializes one historical candidate from its exact Git commit, verifies its pinned
source and dependency-lock closure, and prepares a content-addressed local image.

Options:
  --artifact <id>       Catalog artifact to prepare (required).
  --output <path>       Preparation root outside the repository (required).
  --repository <path>   Git repository containing the pinned commit (default: cwd).
  --json                Print the versioned JSON result.
  -h, --help            Show help.

An unsupported result is expected while a historical Dockerfile or one of its base
images is not digest-pinned. The command never rewrites the historical source.
`;

type CliOptions = {
  artifactId?: string;
  json: boolean;
  outputRoot?: string;
  repositoryRoot: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCommand(
  command: string[],
  cwd?: string,
  stdin?: Blob,
): Promise<CatalogCommandResult> {
  const child = Bun.spawn(command, {
    cwd,
    stderr : 'pipe',
    stdin  : stdin ?? 'ignore',
    stdout : 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
}

function expectCommand(command: string[], result: CatalogCommandResult): void {
  if (result.exitCode !== 0) {
    throw new Error(`${command.slice(0, 3).join(' ')} failed (${result.exitCode}): ${result.stderr || result.stdout || 'no output'}`);
  }
}

/** Materializes a source tree through `git archive`; it never creates a checkout or worktree. */
export function createGitArchiveMaterializer(): CatalogSourceMaterializer {
  return {
    async materialize(params): Promise<void> {
      const archivePath = join(dirname(params.destination), 'source.tar');
      const archiveCommand = [
        'git', 'archive', '--format=tar', `--output=${archivePath}`, params.commit,
      ];

      try {
        expectCommand(archiveCommand, await runCommand(archiveCommand, params.repositoryRoot));
        const extractCommand = ['tar', '-xf', archivePath, '-C', params.destination];
        expectCommand(extractCommand, await runCommand(extractCommand));
      } finally {
        await rm(archivePath, { force: true });
      }
    },
  };
}

function parseDockerImageInspect(stdout: string): CatalogLocalImage {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0] !== 'object' || parsed[0] === null) {
    throw new Error('docker image inspect returned an unexpected response');
  }

  const inspected = parsed[0] as DockerImageInspect;
  if (typeof inspected.Id !== 'string' || !IMAGE_ID_PATTERN.test(inspected.Id)) {
    throw new Error('docker image inspect did not return a content-addressed image ID');
  }

  return {
    id     : inspected.Id,
    labels : inspected.Config?.Labels ?? {},
  };
}

/** Creates the local Docker adapter used after all immutable-input checks pass. */
export function createDockerImageRuntime(): CatalogImageRuntime {
  return {
    async build(params): Promise<CatalogLocalImage> {
      const labelArguments = Object.entries(params.labels)
        .sort(([left], [right]): number => left.localeCompare(right))
        .flatMap(([key, value]): string[] => ['--label', `${key}=${value}`]);
      const command = [
        'docker', 'build', '--quiet', '--load', '--file', params.dockerfilePath,
        ...labelArguments,
        '-',
      ];
      const result = await runCommand(command, undefined, params.contextArchive);
      expectCommand(command, result);
      const imageId = result.stdout.split('\n').map((line): string => line.trim()).filter(Boolean).at(-1);
      if (imageId === undefined || !IMAGE_ID_PATTERN.test(imageId)) {
        throw new Error('docker build did not return a content-addressed image ID');
      }
      const image = await this.inspect(imageId);
      if (image === undefined) {
        throw new Error(`docker build returned image '${imageId}', but it cannot be inspected`);
      }
      return image;
    },
    async inspect(reference): Promise<CatalogLocalImage | undefined> {
      const command = ['docker', 'image', 'inspect', reference];
      const result = await runCommand(command);
      if (result.exitCode !== 0) {
        if (/no such (image|object)|does not exist/iu.test(result.stderr)) {
          return undefined;
        }
        expectCommand(command, result);
      }
      return parseDockerImageInspect(result.stdout);
    },
    async tag(imageId, tag): Promise<void> {
      const command = ['docker', 'image', 'tag', imageId, tag];
      expectCommand(command, await runCommand(command));
    },
  };
}

function buildDescriptor(artifact: HistoricalDwnArtifact): string {
  return JSON.stringify({
    baseImages     : artifact.build.baseImages,
    commit         : artifact.source.commit,
    dockerfile     : artifact.build.dockerfile,
    installCommand : artifact.build.installCommand,
    lock           : artifact.dependencyLock,
    toolchain      : artifact.toolchain,
    tree           : artifact.source.tree,
  });
}

/** Returns the stable identity for the complete source, lock, toolchain, and base-image recipe. */
export function getHistoricalArtifactBuildKey(artifact: HistoricalDwnArtifact): string {
  return createHash('sha256').update(buildDescriptor(artifact)).digest('hex');
}

function safeArtifactId(id: string): string {
  const normalized = id.toLowerCase().replaceAll(/[^a-z0-9_.-]/gu, '-');
  let start = 0;
  let end = normalized.length;
  while (start < end && (normalized[start] === '.' || normalized[start] === '-')) {
    start += 1;
  }
  while (end > start && (normalized[end - 1] === '.' || normalized[end - 1] === '-')) {
    end -= 1;
  }
  const value = normalized.slice(start, end);
  if (value.length === 0) {
    throw new Error(`Artifact ID '${id}' cannot form a local image name`);
  }
  return value;
}

async function resolvePotentialPath(path: string, symlinkDepth = 0): Promise<string> {
  if (symlinkDepth > 40) {
    throw new Error(`Too many symbolic links while resolving '${path}'`);
  }
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missingSegments.reverse());
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      try {
        const stats = await lstat(cursor);
        if (stats.isSymbolicLink()) {
          const linkTarget = await readlink(cursor);
          const target = resolve(dirname(cursor), linkTarget, ...missingSegments.reverse());
          return resolvePotentialPath(target, symlinkDepth + 1);
        }
      } catch (lstatError: unknown) {
        if ((lstatError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw lstatError;
        }
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function outputIsInsideRepository(outputRoot: string, repositoryRoot: string): Promise<boolean> {
  const [canonicalOutput, canonicalRepository] = await Promise.all([
    resolvePotentialPath(outputRoot),
    realpath(repositoryRoot),
  ]);
  const relation = relative(canonicalRepository, canonicalOutput);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

type GitTreeEntry = {
  digest: Buffer;
  isTree: boolean;
  mode: string;
  name: string;
};

function gitObjectDigest(type: 'blob' | 'tree', body: Buffer): Buffer {
  const header = Buffer.from(`${type} ${body.byteLength}\0`);
  return createHash('sha1').update(header).update(body).digest();
}

function gitTreeSortKey(entry: Pick<GitTreeEntry, 'isTree' | 'name'>): Buffer {
  return Buffer.concat([Buffer.from(entry.name), Buffer.from(entry.isTree ? '/' : '\0')]);
}

async function hashGitTreeEntry(parentPath: string, entry: Dirent): Promise<GitTreeEntry | undefined> {
  const path = join(parentPath, entry.name);
  if (entry.isDirectory()) {
    const children = await hashGitTreeEntries(path);
    if (children.length === 0) {
      return undefined;
    }
    return {
      digest : gitTreeDigest(children),
      isTree : true,
      mode   : '40000',
      name   : entry.name,
    };
  }
  if (entry.isSymbolicLink()) {
    return {
      digest : gitObjectDigest('blob', Buffer.from(await readlink(path))),
      isTree : false,
      mode   : '120000',
      name   : entry.name,
    };
  }
  if (!entry.isFile()) {
    throw new Error(`Unsupported filesystem entry '${path}' in materialized Git tree`);
  }
  const [contents, stats] = await Promise.all([readFile(path), lstat(path)]);
  return {
    digest : gitObjectDigest('blob', contents),
    isTree : false,
    mode   : (stats.mode & 0o111) === 0 ? '100644' : '100755',
    name   : entry.name,
  };
}

async function hashGitTreeEntries(path: string): Promise<GitTreeEntry[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const hashed = await Promise.all(entries.map((entry): Promise<GitTreeEntry | undefined> => hashGitTreeEntry(path, entry)));
  return hashed.filter((entry): entry is GitTreeEntry => entry !== undefined)
    .sort((left, right): number => Buffer.compare(gitTreeSortKey(left), gitTreeSortKey(right)));
}

function gitTreeDigest(entries: GitTreeEntry[]): Buffer {
  const body = Buffer.concat(entries.flatMap((entry): Buffer[] => [
    Buffer.from(`${entry.mode} ${entry.name}\0`),
    entry.digest,
  ]));
  return gitObjectDigest('tree', body);
}

/** Hashes an exported directory with Git's SHA-1 tree encoding without modifying a Git object database. */
export function createCatalogSourceTreeHasher(): CatalogSourceTreeHasher {
  return {
    async hash(contextPath): Promise<string> {
      return gitTreeDigest(await hashGitTreeEntries(contextPath)).toString('hex');
    },
  };
}

async function materializeSource(
  artifact: HistoricalDwnArtifact,
  buildKey: string,
  options: HistoricalArtifactBuildOptions,
  materializer: CatalogSourceMaterializer,
): Promise<MaterializationResult> {
  const artifactRoot = join(resolve(options.outputRoot), safeArtifactId(artifact.id));
  const preparationRoot = join(artifactRoot, buildKey);
  await mkdir(preparationRoot, { recursive: true });
  const archivePath = join(preparationRoot, 'source.tar');
  let archiveBytes: Buffer;

  try {
    const archiveStats = await lstat(archivePath);
    if (!archiveStats.isFile()) {
      throw new Error(`Cached source archive '${archivePath}' is not a regular file`);
    }
    archiveBytes = await readFile(archivePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    const stagingRoot = await mkdtemp(join(preparationRoot, '.materialize-'));
    const rawContext = join(stagingRoot, 'source');
    const stagingArchive = join(stagingRoot, 'source.tar');
    try {
      await mkdir(rawContext);
      await materializer.materialize({
        commit         : artifact.source.commit,
        destination    : rawContext,
        repositoryRoot : options.repositoryRoot,
      });
      const sealCommand = ['tar', '-cf', stagingArchive, '-C', rawContext, '.'];
      expectCommand(sealCommand, await runCommand(sealCommand));
      archiveBytes = await readFile(stagingArchive);
      try {
        await link(stagingArchive, archivePath);
      } catch (writeError: unknown) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw writeError;
        }
        const archiveStats = await lstat(archivePath);
        if (!archiveStats.isFile()) {
          throw new Error(`Cached source archive '${archivePath}' is not a regular file`);
        }
        archiveBytes = await readFile(archivePath);
      }
    } finally {
      await rm(stagingRoot, { force: true, recursive: true });
    }
  }

  const verificationRoot = await mkdtemp(join(preparationRoot, '.verify-'));
  const verificationArchive = join(verificationRoot, 'source.tar');
  const contextPath = join(verificationRoot, 'source');
  try {
    await Promise.all([
      mkdir(contextPath),
      writeFile(verificationArchive, archiveBytes),
    ]);
    const extractCommand = ['tar', '-xf', verificationArchive, '-C', contextPath];
    expectCommand(extractCommand, await runCommand(extractCommand));
    await rm(verificationArchive, { force: true });
    const archiveBuffer = Uint8Array.from(archiveBytes).buffer;
    return {
      archive: new Blob([archiveBuffer]),
      archivePath,
      async cleanup(): Promise<void> {
        await rm(verificationRoot, { force: true, recursive: true });
      },
      contextPath,
    };
  } catch (error: unknown) {
    await rm(verificationRoot, { force: true, recursive: true });
    throw error;
  }
}

function readLockfileVersion(contents: Uint8Array): number | undefined {
  const text = new TextDecoder().decode(contents);
  const match = /^\s*\{\s*"lockfileVersion"\s*:\s*(\d+)\s*(?:,|\})/u.exec(text);
  return match === null ? undefined : Number(match[1]);
}

async function verifyMaterializedClosure(
  artifact: HistoricalDwnArtifact,
  materialization: MaterializationResult,
  treeHasher: CatalogSourceTreeHasher,
): Promise<{ checks: LabCheck[]; dockerfile: string | undefined }> {
  const lockPath = join(materialization.contextPath, artifact.dependencyLock.path);
  const dockerfilePath = join(materialization.contextPath, artifact.build.dockerfile.path);
  const checks: LabCheck[] = [{
    details: {
      commit : artifact.source.commit,
      method : 'git-archive-sealed-tar',
      tree   : artifact.source.tree,
    },
    id      : `${artifact.id}.materialization`,
    status  : 'pass',
    summary : 'Fresh candidate context was materialized and sealed outside the repository',
  }];

  try {
    const actualTree = await treeHasher.hash(materialization.contextPath);
    const treeMatches = actualTree === artifact.source.tree;
    checks.push({
      details : { actual: actualTree, expected: artifact.source.tree },
      id      : `${artifact.id}.materialized-source-tree`,
      status  : treeMatches ? 'pass' : 'fail',
      summary : treeMatches
        ? 'Sealed build context exactly matches the pinned Git tree'
        : 'Sealed build context does not match the pinned Git tree',
    });
    const [lockStats, dockerfileStats] = await Promise.all([lstat(lockPath), lstat(dockerfilePath)]);
    if (!lockStats.isFile() || !dockerfileStats.isFile()) {
      throw new Error('the lockfile and Dockerfile must both be regular files');
    }
    const [lockContents, dockerfile] = await Promise.all([readFile(lockPath), readFile(dockerfilePath, 'utf8')]);
    const actualHash = createHash('sha256').update(lockContents).digest('hex');
    const lockfileVersion = readLockfileVersion(lockContents);
    const lockVersionMatches = lockfileVersion === artifact.dependencyLock.formatVersion;
    const frozenInstall = artifact.build.installCommand.includes('--frozen-lockfile');
    const normalizedDockerfile = dockerfile.replaceAll(/\\\r?\n/gu, ' ').replaceAll(/\s+/gu, ' ');
    const installCommand = artifact.build.installCommand.join(' ');
    const dockerfileUsesInstall = normalizedDockerfile.includes(installCommand);
    const lockMatches = actualHash === artifact.dependencyLock.sha256;
    const closureMatches = lockMatches && lockVersionMatches && frozenInstall && dockerfileUsesInstall;

    checks.push({
      details: {
        actualSha256      : actualHash,
        dockerfileInstall : dockerfileUsesInstall,
        expectedSha256    : artifact.dependencyLock.sha256,
        frozenInstall,
        lockfileVersion   : lockfileVersion ?? -1,
        packageTrees      : Object.keys(artifact.packages).length,
      },
      id      : `${artifact.id}.materialized-lock-closure`,
      status  : closureMatches ? 'pass' : 'fail',
      summary : closureMatches
        ? 'Materialized lock bytes, format, package trees, and frozen install recipe match the catalog'
        : 'Materialized dependency closure does not match the pinned frozen-install recipe',
    });
    return { checks, dockerfile };
  } catch (error: unknown) {
    checks.push({
      details : { error: errorMessage(error) },
      id      : `${artifact.id}.materialized-lock-closure`,
      status  : 'fail',
      summary : 'Materialized dependency closure could not be verified',
    });
    return { checks, dockerfile: undefined };
  }
}

type DockerfileBase = {
  alias: string | undefined;
  reference: string;
};

function dockerfileBases(dockerfile: string): DockerfileBase[] {
  const bases: DockerfileBase[] = [];
  const pattern = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/gimu;
  for (const match of dockerfile.matchAll(pattern)) {
    bases.push({ alias: match[2]?.toLowerCase(), reference: match[1] });
  }
  return bases;
}

function immutableInputCheck(artifact: HistoricalDwnArtifact, dockerfile: string): LabCheck {
  const reasons: string[] = [];
  const knownStages = new Set<string>();
  const bases = dockerfileBases(dockerfile);
  if (bases.length === 0) {
    reasons.push('Dockerfile has no readable FROM instruction');
  }

  for (const base of bases) {
    if (base.reference === 'scratch' || knownStages.has(base.reference.toLowerCase())) {
      if (base.alias !== undefined) {
        knownStages.add(base.alias);
      }
      continue;
    }
    const catalogBase = artifact.build.baseImages.find((candidate): boolean => (
      (base.alias !== undefined && candidate.stages.some((stage): boolean => stage.toLowerCase() === base.alias)) ||
      candidate.reference === base.reference ||
      (candidate.digest !== null && `${candidate.reference}@${candidate.digest}` === base.reference)
    ));
    if (catalogBase === undefined) {
      reasons.push(`FROM ${base.reference} is absent from the catalog base-image inventory`);
    } else if (catalogBase.digest === null) {
      reasons.push(`${catalogBase.reference} has no catalog digest`);
    } else if (!SHA256_PATTERN.test(catalogBase.digest)) {
      reasons.push(`${catalogBase.reference} has malformed digest '${catalogBase.digest}'`);
    } else if (base.reference !== `${catalogBase.reference}@${catalogBase.digest}`) {
      reasons.push(`FROM ${base.reference} does not use catalog digest ${catalogBase.digest}`);
    }
    if (base.alias !== undefined) {
      knownStages.add(base.alias);
    }
  }

  return {
    details: {
      bases   : JSON.stringify(bases),
      reasons : JSON.stringify(reasons),
    },
    id      : `${artifact.id}.immutable-image-inputs`,
    status  : reasons.length === 0 ? 'pass' : 'unsupported',
    summary : reasons.length === 0
      ? 'Every external Dockerfile base is selected by an immutable catalog digest'
      : 'Historical Dockerfile cannot produce an immutable catalog image without changing its source recipe',
  };
}

function imageLabels(artifact: HistoricalDwnArtifact, buildKey: string): Readonly<Record<string, string>> {
  return {
    'org.enbox.lab.artifact-id'            : artifact.id,
    'org.enbox.lab.build-key'              : buildKey,
    'org.enbox.lab.dependency-lock-sha256' : artifact.dependencyLock.sha256,
    'org.opencontainers.image.revision'    : artifact.source.commit,
    'org.opencontainers.image.source-tree' : artifact.source.tree,
    'org.opencontainers.image.version'     : artifact.packages['@enbox/dwn-server']?.version ?? 'unknown',
  };
}

function labelsMatch(actual: Readonly<Record<string, string>>, expected: Readonly<Record<string, string>>): boolean {
  return Object.entries(expected).every(([key, value]): boolean => actual[key] === value);
}

function preparedImage(image: CatalogLocalImage, tag: string): PreparedHistoricalImage {
  return {
    id                 : image.id,
    immutableReference : image.id,
    tag,
  };
}

async function prepareImage(
  artifact: HistoricalDwnArtifact,
  buildKey: string,
  materialization: MaterializationResult,
  runtime: CatalogImageRuntime,
): Promise<ImagePreparationResult> {
  const labels = imageLabels(artifact, buildKey);
  let tag: string | undefined;
  try {
    const built = await runtime.build({
      contextArchive : materialization.archive,
      contextPath    : materialization.contextPath,
      dockerfilePath : artifact.build.dockerfile.path,
      labels,
    });
    if (!IMAGE_ID_PATTERN.test(built.id) || !labelsMatch(built.labels, labels)) {
      return {
        checks: [{
          details : { imageId: built.id },
          id      : `${artifact.id}.immutable-local-image`,
          status  : 'fail',
          summary : 'Built image lacks a content-addressed ID or the expected closure labels',
        }],
        image: null,
      };
    }

    const imageToken = built.id.slice('sha256:'.length);
    tag = `enbox-lab/historical-${safeArtifactId(artifact.id)}:${buildKey.slice(0, 32)}-${imageToken}`;
    const existing = await runtime.inspect(tag);
    if (existing !== undefined && (existing.id !== built.id || !labelsMatch(existing.labels, labels))) {
      return {
        checks: [{
          details : { builtImageId: built.id, occupiedImageId: existing.id, tag },
          id      : `${artifact.id}.immutable-local-image`,
          status  : 'fail',
          summary : 'Content-derived local tag is occupied by a different image',
        }],
        image: null,
      };
    }
    if (existing === undefined) {
      await runtime.tag(built.id, tag);
    }
    const tagged = await runtime.inspect(tag);
    if (tagged === undefined || tagged.id !== built.id || !labelsMatch(tagged.labels, labels)) {
      return {
        checks: [{
          details : { builtImageId: built.id, taggedImageId: tagged?.id ?? 'missing', tag },
          id      : `${artifact.id}.immutable-local-image`,
          status  : 'fail',
          summary : 'Local image tag does not resolve to the verified build result',
        }],
        image: null,
      };
    }

    return {
      checks: [{
        details : { imageId: tagged.id, tag, tagReused: existing !== undefined },
        id      : `${artifact.id}.immutable-local-image`,
        status  : 'pass',
        summary : 'Freshly built image is available by content-derived tag and immutable image ID',
      }],
      image: preparedImage(tagged, tag),
    };
  } catch (error: unknown) {
    return {
      checks: [{
        details : { error: errorMessage(error), tag: tag ?? 'not-assigned' },
        id      : `${artifact.id}.immutable-local-image`,
        status  : 'fail',
        summary : 'Immutable local image preparation failed',
      }],
      image: null,
    };
  }
}

function createBuildResult(params: {
  artifact: HistoricalDwnArtifact;
  buildKey: string;
  checks: LabCheck[];
  finishedAt: Date;
  image: PreparedHistoricalImage | null;
  sourceArchivePath: string | null;
  startedAt: Date;
}): HistoricalArtifactBuildResult {
  const report = createProofReport({
    checks     : params.checks,
    finishedAt : params.finishedAt,
    proof      : `catalog-build:${params.artifact.id}`,
    startedAt  : params.startedAt,
  });
  return {
    ...report,
    artifactId        : params.artifact.id,
    buildKey          : params.buildKey,
    image             : params.image,
    sourceArchivePath : params.sourceArchivePath,
  };
}

/**
 * Prepares one historical artifact without checking it out or modifying its source.
 * Runtime qualification remains a separate proof even when this returns `pass`.
 */
export async function prepareHistoricalArtifact(
  options: HistoricalArtifactBuildOptions,
  dependencies: HistoricalArtifactBuildDependencies = {},
): Promise<HistoricalArtifactBuildResult> {
  const now = dependencies.now ?? ((): Date => new Date());
  const startedAt = now();
  const artifact = options.artifact;
  const buildKey = getHistoricalArtifactBuildKey(artifact);
  const checks: LabCheck[] = [];
  let sourceArchivePath: string | null = null;

  if (await outputIsInsideRepository(options.outputRoot, options.repositoryRoot)) {
    checks.push({
      details : { outputRoot: resolve(options.outputRoot), repositoryRoot: resolve(options.repositoryRoot) },
      id      : `${artifact.id}.isolated-output`,
      status  : 'fail',
      summary : 'Preparation output must be outside the repository worktree',
    });
    return createBuildResult({ artifact, buildKey, checks, finishedAt: now(), image: null, sourceArchivePath, startedAt });
  }
  checks.push({
    details : { outputRoot: resolve(options.outputRoot), repositoryRoot: resolve(options.repositoryRoot) },
    id      : `${artifact.id}.isolated-output`,
    status  : 'pass',
    summary : 'Preparation output is outside the repository worktree',
  });

  try {
    const git = dependencies.git ?? createCatalogGitReader(options.repositoryRoot);
    const preflight = await runCatalogPreflight({ artifacts: [artifact], git, mode: 'source', now });
    checks.push(...preflight.checks);
    if (preflight.status !== 'pass') {
      return createBuildResult({ artifact, buildKey, checks, finishedAt: now(), image: null, sourceArchivePath, startedAt });
    }

    const materializer = dependencies.materializer ?? createGitArchiveMaterializer();
    const materialization = await materializeSource(artifact, buildKey, options, materializer);
    sourceArchivePath = materialization.archivePath;
    try {
      const treeHasher = dependencies.treeHasher ?? createCatalogSourceTreeHasher();
      const closure = await verifyMaterializedClosure(artifact, materialization, treeHasher);
      checks.push(...closure.checks);
      if (closure.dockerfile === undefined || closure.checks.some((check): boolean => check.status === 'fail')) {
        return createBuildResult({ artifact, buildKey, checks, finishedAt: now(), image: null, sourceArchivePath, startedAt });
      }

      const immutableInputs = immutableInputCheck(artifact, closure.dockerfile);
      checks.push(immutableInputs);
      if (immutableInputs.status !== 'pass') {
        return createBuildResult({ artifact, buildKey, checks, finishedAt: now(), image: null, sourceArchivePath, startedAt });
      }

      const images = dependencies.images ?? createDockerImageRuntime();
      const imageResult = await prepareImage(artifact, buildKey, materialization, images);
      checks.push(...imageResult.checks);
      return createBuildResult({
        artifact,
        buildKey,
        checks,
        finishedAt : now(),
        image      : imageResult.image,
        sourceArchivePath,
        startedAt,
      });
    } finally {
      await materialization.cleanup();
    }
  } catch (error: unknown) {
    checks.push({
      details : { error: errorMessage(error) },
      id      : `${artifact.id}.preparation`,
      status  : 'fail',
      summary : 'Historical artifact preparation failed before an image was accepted',
    });
    return createBuildResult({ artifact, buildKey, checks, finishedAt: now(), image: null, sourceArchivePath, startedAt });
  }
}

function parseCliOptions(args: string[]): CliOptions | undefined {
  const options: CliOptions = {
    json           : false,
    repositoryRoot : process.cwd(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--artifact') {
      options.artifactId = args[++index];
      if (options.artifactId === undefined) {
        return undefined;
      }
    } else if (argument === '--output') {
      options.outputRoot = args[++index];
      if (options.outputRoot === undefined) {
        return undefined;
      }
    } else if (argument === '--repository') {
      const repositoryRoot = args[++index];
      if (repositoryRoot === undefined) {
        return undefined;
      }
      options.repositoryRoot = repositoryRoot;
    } else {
      return undefined;
    }
  }
  return options;
}

function printBuildResult(result: HistoricalArtifactBuildResult): void {
  console.log(`${result.proof}: ${result.status}`);
  for (const check of result.checks) {
    console.log(`  ${check.status.padEnd(11)} ${check.id}: ${check.summary}`);
    if (check.details !== undefined) {
      console.log(`               ${JSON.stringify(check.details)}`);
    }
  }
  if (result.sourceArchivePath !== null) {
    console.log(`  source      ${result.sourceArchivePath}`);
  }
  if (result.image !== null) {
    console.log(`  image       ${result.image.immutableReference} (${result.image.tag})`);
  }
}

function exitCodeForStatus(status: LabProofStatus): number {
  if (status === 'pass') {
    return 0;
  }
  return status === 'unsupported' ? 2 : 1;
}

/** Runs the standalone historical artifact preparation harness. */
export async function runHistoricalArtifactBuildCli(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return 0;
  }
  const options = parseCliOptions(args);
  if (options?.artifactId === undefined || options.outputRoot === undefined) {
    console.error(usage);
    return 2;
  }
  const artifact = getHistoricalDwnArtifact(options.artifactId);
  if (artifact === undefined) {
    console.error(`Unknown artifact '${options.artifactId}'. Expected one of: ${historicalDwnArtifacts.map(({ id }) => id).join(', ')}`);
    return 2;
  }
  const result = await prepareHistoricalArtifact({
    artifact,
    outputRoot     : options.outputRoot,
    repositoryRoot : options.repositoryRoot,
  });
  if (options.json) {
    console.log(JSON.stringify(result, undefined, 2));
  } else {
    printBuildResult(result);
  }
  return exitCodeForStatus(result.status);
}

if (import.meta.main) {
  process.exitCode = await runHistoricalArtifactBuildCli(process.argv.slice(2));
}
