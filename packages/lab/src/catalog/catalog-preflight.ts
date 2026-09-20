import type { CatalogFilePin, HistoricalDwnArtifact } from './types.js';
import type { LabCheck, LabProofReport } from '../proof-result.js';

import { createHash } from 'node:crypto';
import { createProofReport } from '../proof-result.js';
import { historicalDwnArtifacts } from './historical-artifacts.js';

export type CatalogPreflightMode = 'fixture' | 'source';

export interface CatalogGitReader {
  readFile(commit: string, path: string): Promise<Uint8Array | undefined>;
  resolveObject(specification: string): Promise<string | undefined>;
}

export type CatalogPreflightDependencies = {
  artifacts?: readonly HistoricalDwnArtifact[];
  git?: CatalogGitReader;
  mode?: CatalogPreflightMode;
  now?: () => Date;
  repositoryRoot?: string;
};

type GitResult = {
  exitCode: number;
  stderr: string;
  stdout: Uint8Array;
};

async function runGit(repositoryRoot: string, arguments_: string[]): Promise<GitResult> {
  const process = Bun.spawn(['git', ...arguments_], {
    cwd    : repositoryRoot,
    stderr : 'pipe',
    stdout : 'pipe',
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).arrayBuffer(),
  ]);

  return {
    exitCode,
    stderr : stderr.trim(),
    stdout : new Uint8Array(stdout),
  };
}

/** Creates a reader that inspects historical data directly from the local Git object database. */
export function createCatalogGitReader(repositoryRoot: string): CatalogGitReader {
  return {
    async readFile(commit: string, path: string): Promise<Uint8Array | undefined> {
      const result = await runGit(repositoryRoot, ['show', `${commit}:${path}`]);
      return result.exitCode === 0 ? result.stdout : undefined;
    },
    async resolveObject(specification: string): Promise<string | undefined> {
      const result = await runGit(repositoryRoot, ['rev-parse', '--verify', specification]);
      if (result.exitCode !== 0) {
        return undefined;
      }
      return new TextDecoder().decode(result.stdout).trim();
    },
  };
}

function createIdentityCheck(id: string, actual: string | undefined, expected: string, noun: string): LabCheck {
  if (actual !== expected) {
    return {
      details: {
        actual: actual ?? 'missing',
        expected,
      },
      id,
      status  : 'fail',
      summary : `${noun} does not match the catalog pin`,
    };
  }

  return {
    details : { gitObject: expected },
    id,
    status  : 'pass',
    summary : `${noun} matches the catalog pin`,
  };
}

function uniquePins(artifact: HistoricalDwnArtifact): CatalogFilePin[] {
  const pins: CatalogFilePin[] = [
    artifact.source.rootPackageJson,
    artifact.dependencyLock,
    artifact.build.dockerfile,
    ...artifact.sourceFiles,
  ];

  const byPath = new Map<string, CatalogFilePin>();
  for (const pin of pins) {
    const existing = byPath.get(pin.path);
    if (existing !== undefined && existing.gitObject !== pin.gitObject) {
      throw new Error(`Catalog has conflicting pins for '${pin.path}'.`);
    }
    byPath.set(pin.path, pin);
  }
  return [...byPath.values()];
}

async function verifyPinnedFiles(artifact: HistoricalDwnArtifact, git: CatalogGitReader): Promise<LabCheck> {
  const filePins = uniquePins(artifact);
  const packagePins = Object.entries(artifact.packages).map(([packageName, pin]): CatalogFilePin => ({
    gitObject : pin.sourceTree,
    path      : `packages/${packageName.slice('@enbox/'.length)}`,
  }));
  const pins = [...filePins, ...packagePins];
  const resolved = await Promise.all(pins.map(async (pin): Promise<{ actual: string | undefined; pin: CatalogFilePin }> => ({
    actual: await git.resolveObject(`${artifact.source.commit}:${pin.path}`),
    pin,
  })));
  const mismatches = resolved.filter(({ actual, pin }): boolean => actual !== pin.gitObject);

  if (mismatches.length > 0) {
    return {
      details: {
        mismatches: JSON.stringify(mismatches.map(({ actual, pin }) => ({
          actual   : actual ?? 'missing',
          expected : pin.gitObject,
          path     : pin.path,
        }))),
      },
      id      : `${artifact.id}.source-files`,
      status  : 'fail',
      summary : `${mismatches.length} pinned source object(s) do not match`,
    };
  }

  return {
    details : { objects: pins.length },
    id      : `${artifact.id}.source-files`,
    status  : 'pass',
    summary : `${pins.length} build and capability source objects match`,
  };
}

async function verifyLock(artifact: HistoricalDwnArtifact, git: CatalogGitReader): Promise<LabCheck> {
  const contents = await git.readFile(artifact.source.commit, artifact.dependencyLock.path);
  if (contents === undefined) {
    return {
      id      : `${artifact.id}.dependency-lock`,
      status  : 'fail',
      summary : 'Pinned dependency lock is unavailable',
    };
  }

  const actual = createHash('sha256').update(contents).digest('hex');
  if (actual !== artifact.dependencyLock.sha256) {
    return {
      details : { actual, expected: artifact.dependencyLock.sha256 },
      id      : `${artifact.id}.dependency-lock`,
      status  : 'fail',
      summary : 'Dependency lock content does not match its SHA-256 pin',
    };
  }

  return {
    details: {
      gitObject : artifact.dependencyLock.gitObject,
      sha256    : artifact.dependencyLock.sha256,
    },
    id      : `${artifact.id}.dependency-lock`,
    status  : 'pass',
    summary : 'Dependency lock content matches both pins',
  };
}

function decodeJson(contents: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(new TextDecoder().decode(contents)) as unknown;
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function verifyPackageVersions(artifact: HistoricalDwnArtifact, git: CatalogGitReader): Promise<LabCheck> {
  const rootContents = await git.readFile(artifact.source.commit, artifact.source.rootPackageJson.path);
  const rootPackage = rootContents === undefined ? undefined : decodeJson(rootContents);
  const mismatches: string[] = [];
  const expectedPackageManager = `bun@${artifact.toolchain.bun}`;
  if (rootPackage?.packageManager !== expectedPackageManager) {
    mismatches.push(`packageManager=${String(rootPackage?.packageManager)} (expected ${expectedPackageManager})`);
  }

  await Promise.all(Object.entries(artifact.packages).map(async ([packageName, pin]): Promise<void> => {
    const directory = packageName.slice('@enbox/'.length);
    const contents = await git.readFile(artifact.source.commit, `packages/${directory}/package.json`);
    const packageJson = contents === undefined ? undefined : decodeJson(contents);
    if (packageJson?.name !== packageName || packageJson.version !== pin.version) {
      mismatches.push(`${packageName}=${String(packageJson?.version)} (expected ${pin.version})`);
    }
  }));

  if (mismatches.length > 0) {
    return {
      details : { mismatches: JSON.stringify(mismatches.sort()) },
      id      : `${artifact.id}.versions`,
      status  : 'fail',
      summary : 'Toolchain or package version labels do not match the pinned source',
    };
  }

  return {
    details: {
      bun            : artifact.toolchain.bun,
      dwnServer      : artifact.packages['@enbox/dwn-server']?.version ?? 'not-cataloged',
      dwnSdk         : artifact.packages['@enbox/dwn-sdk-js']?.version ?? 'not-cataloged',
      packageClosure : Object.keys(artifact.packages).length,
    },
    id      : `${artifact.id}.versions`,
    status  : 'pass',
    summary : 'Toolchain and package version labels match the pinned source',
  };
}

function capabilityInventoryCheck(artifact: HistoricalDwnArtifact): LabCheck {
  const inventory = Object.fromEntries(artifact.capabilities.map((capability) => [capability.id, {
    runtimeStatus : capability.runtimeStatus,
    sourceSupport : capability.sourceSupport,
  }]));

  return {
    details : { inventory: JSON.stringify(inventory) },
    id      : `${artifact.id}.capability-inventory`,
    status  : 'pass',
    summary : 'Capability support and pending runtime evidence are recorded explicitly',
  };
}

function fixtureChecks(artifact: HistoricalDwnArtifact): LabCheck[] {
  const missingDigests = artifact.build.baseImages
    .filter((image): boolean => image.digest === null)
    .map((image): string => image.reference);
  const customLauncherRequired = artifact.capabilities.some(
    (capability): boolean => capability.sourceSupport === 'custom-launcher-required',
  );

  return [
    {
      details : { references: JSON.stringify(missingDigests) },
      id      : `${artifact.id}.immutable-base-images`,
      status  : missingDigests.length === 0 ? 'pass' : 'unsupported',
      summary : missingDigests.length === 0
        ? 'Every base image has an immutable digest'
        : 'Historical Dockerfile uses mutable tags and no catalog digest is pinned',
    },
    {
      id      : `${artifact.id}.observer-launcher`,
      status  : customLauncherRequired && artifact.launch.customLauncher === null ? 'unsupported' : 'pass',
      summary : customLauncherRequired && artifact.launch.customLauncher === null
        ? 'Observation hook exists, but no pinned custom launcher installs it'
        : 'Required custom launcher is pinned',
    },
    {
      details: {
        evidence       : artifact.qualification.evidence.length,
        requiredProofs : artifact.qualification.requiredProofs.length,
      },
      id      : `${artifact.id}.runtime-qualification`,
      status  : artifact.qualification.status === 'qualified' ? 'pass' : 'unsupported',
      summary : artifact.qualification.status === 'qualified'
        ? 'Required runtime proofs are qualified'
        : `Runtime qualification is ${artifact.qualification.status}; fixture creation must remain blocked`,
    },
  ];
}

async function inspectArtifact(
  artifact: HistoricalDwnArtifact,
  git: CatalogGitReader,
  mode: CatalogPreflightMode,
): Promise<LabCheck[]> {
  const [commit, tree, pinnedFiles, lock, versions] = await Promise.all([
    git.resolveObject(`${artifact.source.commit}^{commit}`),
    git.resolveObject(`${artifact.source.commit}^{tree}`),
    verifyPinnedFiles(artifact, git),
    verifyLock(artifact, git),
    verifyPackageVersions(artifact, git),
  ]);
  const checks = [
    createIdentityCheck(`${artifact.id}.commit`, commit, artifact.source.commit, 'Source commit'),
    createIdentityCheck(`${artifact.id}.tree`, tree, artifact.source.tree, 'Source tree'),
    pinnedFiles,
    lock,
    versions,
    capabilityInventoryCheck(artifact),
  ];

  return mode === 'fixture' ? [...checks, ...fixtureChecks(artifact)] : checks;
}

/** Verifies catalog source pins and, in fixture mode, rejects entries that lack runtime evidence. */
export async function runCatalogPreflight(dependencies: CatalogPreflightDependencies = {}): Promise<LabProofReport> {
  const now = dependencies.now ?? ((): Date => new Date());
  const startedAt = now();
  const mode = dependencies.mode ?? 'fixture';
  const artifacts = dependencies.artifacts ?? historicalDwnArtifacts;
  const git = dependencies.git ?? createCatalogGitReader(dependencies.repositoryRoot ?? process.cwd());
  const artifactChecks = await Promise.all(artifacts.map(
    (artifact): Promise<LabCheck[]> => inspectArtifact(artifact, git, mode),
  ));

  return createProofReport({
    checks     : artifactChecks.flat(),
    finishedAt : now(),
    proof      : `catalog-preflight:${mode}`,
    startedAt,
  });
}
