import type { ApplicationManifest, ConnectionStore } from '@enbox/api';

import { createApplication, defineStore } from '@enbox/browser';

const feature = defineStore({ create: () => ({ title: 'Notes' }) });
declare const connection: (manifest: ApplicationManifest) => ConnectionStore;
const app = createApplication({ stores: { feature }, connection });
const title: string = app.store(feature).title;
void title;

// @ts-expect-error the injected connection factory owns its wallet handler.
createApplication({ stores: { feature }, connection, wallet: {} });
// @ts-expect-error an application derives its own manifest.
createApplication({ stores: { feature }, connection: { application: {} } });
// @ts-expect-error a custom handler and wallet settings cannot both own connection.
createApplication({ stores: { feature }, wallet: {}, connectHandler: { requestAccess: async () => undefined } });
