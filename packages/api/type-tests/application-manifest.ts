import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { Enbox, EnboxConnectOptions } from '@enbox/api';
import type { HandlerConnectOptions, ProtocolRequest, RefreshOptions, VaultConnectOptions } from '@enbox/auth';

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
const authRequests: ProtocolRequest[] = getApplicationProtocolRequests(application);
const directStructuralAuthRequests = [
  NotesProtocol,
  { protocol: PhotosProtocol, permissions: ['read', 'write'] },
] as const satisfies readonly ProtocolRequest[];
const ownerOptions: EnboxConnectOptions = { createIdentity: true };
const delegatedOptions: HandlerConnectOptions = { protocols: authRequests };
const refreshOptions: RefreshOptions = { protocols: authRequests };
const vaultOptions: VaultConnectOptions = { createIdentity: true };
const store = createConnectionStore({
  application,
  monitor          : { autoRefresh: {} },
  publishProtocols : true,
});
const plainStore = createConnectionStore();
declare const enbox: Enbox;
void store.connect({ password: 'pw' });
void store.connectVault({ createIdentity: true });
void store.refresh();
void plainStore.refresh({ protocols: authRequests });
void enbox.protocols.ensureReady({ application });
void enbox.protocols.ensureReady({ application, publish: false });
void enbox.protocols.ensureReady({ application, targetDid: 'did:example:owner' });
void exactProtocol;
void exactExplicitProtocol;
void authRequests;
void directStructuralAuthRequests;
void ownerOptions;

// @ts-expect-error plain stores require explicit refresh protocols.
void plainStore.refresh();

// @ts-expect-error manifest-backed connect protocols come only from the manifest.
void store.connect(delegatedOptions);

// @ts-expect-error manifest-backed refresh protocols come only from the manifest.
void store.refresh(refreshOptions);

// @ts-expect-error manifest-backed connect is delegated; use connectVault for owners.
void store.connect(vaultOptions);

// @ts-expect-error plain monitor auto-refresh requires explicit protocols.
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

// @ts-expect-error a manifest is not an AuthManager connect payload; owner routing stays explicit.
const unsafeOwnerOptions: EnboxConnectOptions = { ...application, createIdentity: true };
void unsafeOwnerOptions;

// @ts-expect-error readiness requires an application manifest.
void enbox.protocols.ensureReady({});
