import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type {
  AuthManagerOptions,
  HandlerConnectOptions,
  ModuleRequest,
  Permission,
  RefreshOptions,
  VaultConnectOptions,
} from '@enbox/auth';
import type { ConnectionStoreConnectOptions, ConnectionStoreRefreshOptions, Enbox } from '@enbox/api';

import {
  createConnectionStore,
  defineApplicationManifest,
  defineModule,
  getApplicationModuleRequests,
  recordCodecs,
} from '@enbox/api';

const NotesDefinition = {
  module    : 'https://example.com/modules/manifest-notes',
  published : true,
  types     : {
    note: { dataFormats: ['application/json'] },
  },
  structure: {
    note: {},
  },
} as const satisfies ModuleDefinition;

const NotesModule = defineModule({ definition : NotesDefinition, codecs     : {
  note: recordCodecs.json<{ body: string }>(),
} });

const PhotosDefinition = {
  module    : 'https://example.com/modules/manifest-photos',
  published : true,
  types     : {
    photo: { dataFormats: ['image/jpeg'] },
  },
  structure: {
    photo: {},
  },
} as const satisfies ModuleDefinition;

const PhotosModule = defineModule({ definition : PhotosDefinition, codecs     : {
  photo: recordCodecs.blob('image/jpeg'),
} });

const application = defineApplicationManifest({
  modules: [
    NotesModule,
    { module: PhotosModule, permissions: ['read'] },
  ],
} as const);

const exactModule: typeof NotesModule = application.modules[0].module;
const exactExplicitModule: typeof PhotosModule = application.modules[1].module;
const defaultPermissions: readonly Permission[] = application.modules[0].permissions;
const authRequests: ModuleRequest[] = getApplicationModuleRequests(application);
const directStructuralAuthRequests = [
  NotesModule,
  { module: PhotosModule, permissions: ['read', 'write'] },
] as const satisfies readonly ModuleRequest[];
const delegatedOptions: HandlerConnectOptions = { modules: authRequests };
const delegatedRefreshOptions: RefreshOptions = { modules: authRequests };
const connectOptions: ConnectionStoreConnectOptions = { password: 'pw' };
const refreshOptions: ConnectionStoreRefreshOptions = {};
const vaultOptions: VaultConnectOptions = { createIdentity: true };
const store = createConnectionStore({
  application,
  monitor                : { autoRefresh: {} },
  requireHostedReadiness : true,
});
declare const callerAgent: NonNullable<AuthManagerOptions['agent']>;
declare const enbox: Enbox;
void store.connect(connectOptions);
void store.connectVault({ createIdentity: true });
void store.refresh(refreshOptions);
void enbox.modules.ensureReady({ application });
void enbox.modules.ensureReady({ application, publish: false });
void enbox.modules.ensureReady({ application, targetDid: 'did:example:owner' });
void exactModule;
void exactExplicitModule;
void defaultPermissions;
void authRequests;
void directStructuralAuthRequests;

// @ts-expect-error connection stores accept a caller-owned AuthManager, not a raw agent.
createConnectionStore({ application, agent: callerAgent });

// @ts-expect-error manifest-backed connect modules come only from the manifest.
void store.connect(delegatedOptions);

// @ts-expect-error sync cadence is configured once on the connection store.
void store.connect({ sync: 'off' });

// @ts-expect-error manifest-backed refresh modules come only from the manifest.
void store.refresh(delegatedRefreshOptions);

// @ts-expect-error manifest-backed connect is delegated; use connectVault for owners.
void store.connect(vaultOptions);

// @ts-expect-error every connection store requires an application manifest.
createConnectionStore({ monitor: { autoRefresh: {} } });

// @ts-expect-error manifest-backed monitor modules come only from the manifest.
createConnectionStore({ application, monitor: { autoRefresh: { modules: authRequests } } });

defineApplicationManifest({
  modules: [
    // @ts-expect-error application manifests require TypedModule values, not raw definitions.
    NotesDefinition,
  ],
} as const);

defineApplicationManifest({
  modules: [{
    module      : NotesModule,
    // @ts-expect-error application permission policies use the auth permission vocabulary.
    permissions : ['admin'],
  }],
} as const);

// @ts-expect-error readiness requires an application manifest.
void enbox.modules.ensureReady({});
