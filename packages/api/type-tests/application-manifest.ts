import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  AuthManagerOptions,
  HandlerConnectOptions,
  Permission,
  ProtocolRequest,
  RefreshOptions,
  VaultConnectOptions,
} from '@enbox/auth';
import type { ConnectionStoreConnectOptions, ConnectionStoreRefreshOptions, Enbox } from '@enbox/api';

import {
  createConnectionStore,
  defineApplicationManifest,
  defineProtocol,
  getApplicationProtocolRequests,
  recordCodecs,
} from '@enbox/api';

const NotesDefinition = {
  protocol  : 'https://example.com/protocols/manifest-notes',
  published : true,
  types     : {
    note: { dataFormats: ['application/json'] },
  },
  structure: {
    note: {},
  },
} as const satisfies ProtocolDefinition;

const NotesProtocol = defineProtocol(NotesDefinition, {
  note: recordCodecs.json<{ body: string }>(),
});

const PhotosDefinition = {
  protocol  : 'https://example.com/protocols/manifest-photos',
  published : true,
  types     : {
    photo: { dataFormats: ['image/jpeg'] },
  },
  structure: {
    photo: {},
  },
} as const satisfies ProtocolDefinition;

const PhotosProtocol = defineProtocol(PhotosDefinition, {
  photo: recordCodecs.blob('image/jpeg'),
});

const application = defineApplicationManifest({
  protocols: [
    NotesProtocol,
    { protocol: PhotosProtocol, permissions: ['read'] },
  ],
} as const);

const exactProtocol: typeof NotesProtocol = application.protocols[0].protocol;
const exactExplicitProtocol: typeof PhotosProtocol = application.protocols[1].protocol;
const defaultPermissions: readonly Permission[] = application.protocols[0].permissions;
const authRequests: ProtocolRequest[] = getApplicationProtocolRequests(application);
const directStructuralAuthRequests = [
  NotesProtocol,
  { protocol: PhotosProtocol, permissions: ['read', 'write'] },
] as const satisfies readonly ProtocolRequest[];
const delegatedOptions: HandlerConnectOptions = { protocols: authRequests };
const delegatedRefreshOptions: RefreshOptions = { protocols: authRequests };
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
void enbox.protocols.ensureReady({ application });
void enbox.protocols.ensureReady({ application, publish: false });
void enbox.protocols.ensureReady({ application, targetDid: 'did:example:owner' });
void exactProtocol;
void exactExplicitProtocol;
void defaultPermissions;
void authRequests;
void directStructuralAuthRequests;

// @ts-expect-error connection stores accept a caller-owned AuthManager, not a raw agent.
createConnectionStore({ application, agent: callerAgent });

// @ts-expect-error manifest-backed connect protocols come only from the manifest.
void store.connect(delegatedOptions);

// @ts-expect-error sync cadence is configured once on the connection store.
void store.connect({ sync: 'off' });

// @ts-expect-error manifest-backed refresh protocols come only from the manifest.
void store.refresh(delegatedRefreshOptions);

// @ts-expect-error manifest-backed connect is delegated; use connectVault for owners.
void store.connect(vaultOptions);

// @ts-expect-error every connection store requires an application manifest.
createConnectionStore({ monitor: { autoRefresh: {} } });

// @ts-expect-error manifest-backed monitor protocols come only from the manifest.
createConnectionStore({ application, monitor: { autoRefresh: { protocols: authRequests } } });

defineApplicationManifest({
  protocols: [
    // @ts-expect-error application manifests require TypedProtocol values, not raw definitions.
    NotesDefinition,
  ],
} as const);

defineApplicationManifest({
  protocols: [{
    protocol    : NotesProtocol,
    // @ts-expect-error application permission policies use the auth permission vocabulary.
    permissions : ['admin'],
  }],
} as const);

// @ts-expect-error readiness requires an application manifest.
void enbox.protocols.ensureReady({});
