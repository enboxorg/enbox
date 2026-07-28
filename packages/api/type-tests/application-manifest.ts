import type { EnboxConnectOptions } from '@enbox/api';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { ProtocolRequest } from '@enbox/auth';

import {
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
void exactProtocol;
void exactExplicitProtocol;
void authRequests;
void directStructuralAuthRequests;
void ownerOptions;

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
