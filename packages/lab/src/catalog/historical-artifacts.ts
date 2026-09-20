import type {
  CatalogCapability,
  CatalogFilePin,
  HistoricalDwnArtifact,
} from './types.js';

const sharedSourceFiles = {
  didDht: {
    gitObject : '7f27c5d7b25f0655bbe0351376deb6559db1f39f',
    path      : 'packages/dids/src/methods/did-dht.ts',
  },
  didDhtPkarr: {
    gitObject : '80a44a061864b8ffd773509249ba016abbc5208d',
    path      : 'packages/dids/src/methods/did-dht-pkarr.ts',
  },
  deliveryService: {
    gitObject : '50f2ae1ce741bbcf8bf6436923541ad0c9cab016',
    path      : 'packages/dwn-server/src/delivery-service.ts',
  },
  dwnServer: {
    gitObject : '255e2da54c80738f4bfb6c8fa5a5e3e148d9162c',
    path      : 'packages/dwn-server/src/dwn-server.ts',
  },
  dwnServerConfig: {
    gitObject : 'b95cbffec443b4b7426096af0e76323084b04eb7',
    path      : 'packages/dwn-server/src/config.ts',
  },
  dwnServerIndex: {
    gitObject : 'b93610ea8cfdf6b98be62737e4459e21cd48296d',
    path      : 'packages/dwn-server/src/index.ts',
  },
  dwnServerMain: {
    gitObject : 'f66a14bb4ed1c76518f4f7868bc2a9cd77b28268',
    path      : 'packages/dwn-server/src/main.ts',
  },
  messageProcessedHook: {
    gitObject : 'c069d5da978f4fd73928b68354a1c1e8193b2d32',
    path      : 'packages/dwn-server/src/message-processed-hook.ts',
  },
  messageProcessedHookRunner: {
    gitObject : '74093e85cf23f761628a85568bea6644c6867baa',
    path      : 'packages/dwn-server/src/json-rpc-handlers/dwn/message-processed-hooks.ts',
  },
  universalResolver: {
    gitObject : 'dc4deed2818c79a3f306e98c5d031887fbd01abb',
    path      : 'packages/dids/src/resolver/universal-resolver.ts',
  },
} as const satisfies Readonly<Record<string, CatalogFilePin>>;

const sourceFiles = Object.values(sharedSourceFiles);

const capabilities = [
  {
    evidence      : [sharedSourceFiles.didDht, sharedSourceFiles.didDhtPkarr, sharedSourceFiles.dwnServer],
    id            : 'private-did-gateway',
    notes         : 'The SDK accepts an explicit private gateway opt-in and the server accepts resolver injection. The stock launcher can also use its process-scoped DID_DHT_* defaults. Runtime isolation is not yet proved.',
    runtimeStatus : 'pending',
    sourceSupport : 'available',
  },
  {
    evidence: [
      sharedSourceFiles.dwnServerIndex,
      sharedSourceFiles.dwnServer,
      sharedSourceFiles.messageProcessedHook,
      sharedSourceFiles.messageProcessedHookRunner,
      sharedSourceFiles.dwnServerMain,
    ],
    id            : 'message-processed-observer',
    notes         : 'DwnServer exports the hook API, but main.ts constructs DwnServer without hooks. The catalog needs a pinned custom launcher before this capability can be used.',
    runtimeStatus : 'pending',
    sourceSupport : 'custom-launcher-required',
  },
  {
    evidence      : [sharedSourceFiles.dwnServerConfig, sharedSourceFiles.dwnServer, sharedSourceFiles.deliveryService],
    id            : 'endpoint-forwarding',
    notes         : 'DWN_FORWARDING_ENABLED enables the built-in DeliveryService and forwarding uses the injected or process-configured resolver. The forwarding proof has not run.',
    runtimeStatus : 'pending',
    sourceSupport : 'available',
  },
  {
    evidence      : [sharedSourceFiles.dwnServerMain],
    id            : 'connect-write-read-live-sync',
    notes         : 'Presence of a server launcher does not establish the cross-version connect, write, read, and live-sync path.',
    runtimeStatus : 'pending',
    sourceSupport : 'not-established',
  },
] as const satisfies readonly CatalogCapability[];

const build = {
  baseImages: [
    {
      digest    : null,
      reference : 'oven/bun:1-alpine',
      stages    : ['deps', 'build', 'runtime'],
    },
  ],
  context    : '.',
  dockerfile : {
    gitObject : '6875ab9b14dcb757c8d98adfa51c9cf09170697c',
    path      : 'Dockerfile',
  },
  installCommand    : ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
  packageBuildOrder : [
    '@enbox/common',
    '@enbox/crypto',
    '@enbox/dids',
    '@enbox/dwn-sdk-js',
    '@enbox/dwn-sql-store',
    '@enbox/dwn-clients',
    '@enbox/dwn-server-admin-ui',
    '@enbox/dwn-server',
  ],
} as const satisfies HistoricalDwnArtifact['build'];

const launch = {
  configuration: {
    DID_DHT_ALLOW_PRIVATE_GATEWAY : '1',
    DID_DHT_GATEWAY_URI           : '<lab-owned-gateway>',
    DWN_BASE_URL                  : '<canonical-actor-url>',
    DWN_DELIVERY_ENABLED          : 'false',
    DWN_FORWARDING_ENABLED        : 'false',
  },
  customLauncher : null,
  infoEndpoint   : '/info',
  stockCommand   : ['bun', 'packages/dwn-server/dist/esm/src/main.js'],
} as const satisfies HistoricalDwnArtifact['launch'];

const requiredProofs = [
  'build an image for every native target from the pinned source and lock closure',
  'record immutable base and resulting image digests',
  'start the server with a lab-owned private DID gateway and verify /info versions',
  'run connect, write, read, live-sync, and outage recovery against the explicit mixed topology',
  'run the forwarding variant with alternate replication disabled',
  'compare observer-enabled and observer-disabled signed CIDs and payload bytes',
] as const;

/** Historical DWN candidates. Source facts are pinned; runtime qualification remains pending. */
export const historicalDwnArtifacts = [
  {
    build,
    capabilities,
    dependencyLock: {
      formatVersion : 1,
      gitObject     : '304de6efa0a71dde7590ba2e0032d4280bbc3b40',
      path          : 'bun.lock',
      sha256        : 'c5baeab7ec8b77a504cecb5d79dece35ff3ab203a1b414b79590da965eaea488',
    },
    id       : 'dwn-server-0.1.43',
    launch,
    packages : {
      '@enbox/common'              : { sourceTree: '06702466e9f5cb111de4270ba237e57d4a10b96b', version: '0.1.8' },
      '@enbox/crypto'              : { sourceTree: 'a045abcfc7a2e9c50d220f2ebd328efd42b7cbfd', version: '0.1.11' },
      '@enbox/dids'                : { sourceTree: 'cfeb09145647f4e57c673aef7e21bdb8ad190d75', version: '0.1.12' },
      '@enbox/dwn-clients'         : { sourceTree: '6c298059e343499d345bc4c4990e74de63533efd', version: '0.4.35' },
      '@enbox/dwn-sdk-js'          : { sourceTree: '6c1d3af7db0038cde7577333be679729092c46cc', version: '0.4.27' },
      '@enbox/dwn-server'          : { sourceTree: '82f9a7f4117fb33bf5e5df572714d92ed507dfb0', version: '0.1.43' },
      '@enbox/dwn-server-admin-ui' : { sourceTree: '278df1e3bb51fc308c36f7c186115a6b87575c5d', version: '0.1.2' },
      '@enbox/dwn-sql-store'       : { sourceTree: '64d0eb0d0d1ea4d7f8a45dc3f8f805bc0ad89520', version: '0.0.52' },
    },
    qualification: {
      evidence : [],
      requiredProofs,
      status   : 'pending',
    },
    role   : 'reference',
    source : {
      commit          : 'f9d159d75e7fd533f7b8db78a15c76f9e51a449e',
      rootPackageJson : {
        gitObject : '62c3302971ff6618436d10a032c27e48619463bb',
        path      : 'package.json',
      },
      tree: 'c9645a2fcfc65ffac90786da9e024dc1eaf8357b',
    },
    sourceFiles,
    toolchain: { bun: '1.3.14' },
  },
  {
    build,
    capabilities,
    dependencyLock: {
      formatVersion : 1,
      gitObject     : '2a88de1d90f0228fdfa0abadf65d3d485e77ebbd',
      path          : 'bun.lock',
      sha256        : 'dd815c0b389dbe7cb03d48fb6a18ef1a7a555a27959d2b3ed0010875827366cc',
    },
    id       : 'dwn-server-0.1.42',
    launch,
    packages : {
      '@enbox/common'              : { sourceTree: 'faa1c362d19b8fc190613d947e022f335ba68ae5', version: '0.1.7' },
      '@enbox/crypto'              : { sourceTree: 'ceddb65f2e2d4e3a1b58894ff76cc7a5f32c5db6', version: '0.1.10' },
      '@enbox/dids'                : { sourceTree: '37cbad26abd16f434c5eb44e86eee099b5ac7876', version: '0.1.11' },
      '@enbox/dwn-clients'         : { sourceTree: 'a13ace4950683447857524aaff7dc018d930140a', version: '0.4.34' },
      '@enbox/dwn-sdk-js'          : { sourceTree: 'f57f4892a012c872ec93098b4781ab6b52079224', version: '0.4.26' },
      '@enbox/dwn-server'          : { sourceTree: '60817d713610f336b881cdde05d4beebdc584a84', version: '0.1.42' },
      '@enbox/dwn-server-admin-ui' : { sourceTree: '278df1e3bb51fc308c36f7c186115a6b87575c5d', version: '0.1.2' },
      '@enbox/dwn-sql-store'       : { sourceTree: '35007273267d9661c2ecf87ed4e7437bc9ed9236', version: '0.0.51' },
    },
    qualification: {
      evidence : [],
      requiredProofs,
      status   : 'pending',
    },
    role   : 'candidate',
    source : {
      commit          : '0ff8d4395bf9940ec888c3be4553b3c0eacde7f9',
      rootPackageJson : {
        gitObject : '571de4bd008cac2e3d0f411e5791b53bd2e4c450',
        path      : 'package.json',
      },
      tree: '559c95854eea23892fa7c4efc3121b0e30fbb5d0',
    },
    sourceFiles,
    toolchain: { bun: '1.3.14' },
  },
] as const satisfies readonly HistoricalDwnArtifact[];

/** Finds a catalog entry by its stable ID. */
export function getHistoricalDwnArtifact(id: string): HistoricalDwnArtifact | undefined {
  return historicalDwnArtifacts.find((artifact): boolean => artifact.id === id);
}
