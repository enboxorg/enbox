export type CatalogSourceSupport = 'available' | 'custom-launcher-required' | 'not-established';

export type CatalogRuntimeStatus = 'failed' | 'pending' | 'qualified';

export type CatalogFilePin = {
  gitObject: string;
  path: string;
};

export type CatalogPackagePin = {
  sourceTree: string;
  version: string;
};

export type CatalogCapability = {
  evidence: readonly CatalogFilePin[];
  id: string;
  notes: string;
  runtimeStatus: CatalogRuntimeStatus;
  sourceSupport: CatalogSourceSupport;
};

export type CatalogBaseImage = {
  /** Immutable registry digest. `null` means the historical recipe is not reproducible yet. */
  digest: string | null;
  reference: string;
  stages: readonly string[];
};

export type HistoricalDwnArtifact = {
  build: {
    baseImages: readonly CatalogBaseImage[];
    context: '.';
    dockerfile: CatalogFilePin;
    installCommand: readonly string[];
    packageBuildOrder: readonly string[];
  };
  capabilities: readonly CatalogCapability[];
  dependencyLock: CatalogFilePin & {
    formatVersion: 1;
    sha256: string;
  };
  id: string;
  launch: {
    configuration: Readonly<Record<string, string>>;
    customLauncher: CatalogFilePin | null;
    infoEndpoint: '/info';
    stockCommand: readonly string[];
  };
  packages: Readonly<Record<string, CatalogPackagePin>>;
  qualification: {
    evidence: readonly string[];
    requiredProofs: readonly string[];
    status: CatalogRuntimeStatus;
  };
  role: 'candidate' | 'reference';
  source: {
    commit: string;
    rootPackageJson: CatalogFilePin;
    tree: string;
  };
  sourceFiles: readonly CatalogFilePin[];
  toolchain: {
    bun: string;
  };
};
