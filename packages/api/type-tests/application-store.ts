import type { StoreInstance } from '@enbox/api';

import { createApplication, createConnectionStore, defineApplication, defineProtocol, defineStore, recordCodecs } from '@enbox/api';

const Protocol = defineProtocol({
  protocol  : 'https://example.com/protocols/application-store-types',
  published : false,
  types     : { note: { dataFormats: ['application/json'] } },
  structure : { note: {} },
} as const, { note: recordCodecs.json<{ title: string }>() });

const Notes = defineStore({
  protocols: { notes: Protocol },
  create({ protocols, command }) {
    const notes = protocols.notes.collection('note');
    return {
      notes,
      add            : command((title: string) => notes.create.run({ title })),
      count          : command((): number => notes.getSnapshot().records.length),
      defaultTitle   : command((title = 'Untitled'): string => title),
      optionalTitle  : command((title?: string): string => title ?? 'Untitled'),
      asyncTitle     : command(async (title = 'Untitled'): Promise<string> => title),
      annotatedCount : command((): number => notes.getSnapshot().records.length),
    };
  },
});

const Dashboard = defineStore({
  protocols : {},
  stores    : { notes: Notes },
  create({ stores }) {
    const add: StoreInstance<typeof Notes>['add'] = stores.notes.add;
    return { add };
  },
});
const definition = defineApplication({ stores: { dashboard: Dashboard } });
const application = createApplication(definition, {
  connection: createConnectionStore({ application: definition.manifest }),
});
const feature: StoreInstance<typeof Notes> = application.store(Notes);
const connectionState = application.connection.getSnapshot();
const stop = application.subscribe((): void => {});
const count: Promise<number> = feature.count.run();
const title: Promise<string> = application.store(Dashboard).add.run('hello').then(record => record.value()).then(value => value.title);
const defaults: readonly Promise<string>[] = [
  feature.defaultTitle.run(), feature.defaultTitle.run('Hello'), feature.defaultTitle.run(undefined),
  feature.optionalTitle.run(), feature.optionalTitle.run('Hello'), feature.optionalTitle.run(undefined),
  feature.asyncTitle.run(), feature.asyncTitle.run('Hello'),
];
const annotatedCount: Promise<number> = feature.annotatedCount.run();
const undefinedCount: Promise<number> = feature.count.run(undefined);
void count;
void title;
void defaults;
void annotatedCount;
void undefinedCount;
void connectionState;
void stop;

// @ts-expect-error connection state belongs to the native connection, not the feature owner.
application.getSnapshot();

// @ts-expect-error feature instances are constructed by the application, not a public definition method.
Notes.instantiate;

// @ts-expect-error domain command input remains inferred through dependent stores.
application.store(Dashboard).add.run(123);
// @ts-expect-error payload codecs remain authoritative through application resolution.
feature.notes.create.run({ title: false });
// @ts-expect-error required command inputs remain required.
feature.add.run();
// @ts-expect-error defaulted command inputs retain their declared value type.
feature.defaultTitle.run(123);
// @ts-expect-error optional command inputs retain their declared value type.
feature.optionalTitle.run(false);
// @ts-expect-error zero-input commands do not accept arbitrary values.
feature.count.run('extra');

// @ts-expect-error a feature factory is synchronous, not an asynchronous initialization workflow.
defineStore({ protocols: {}, create: async () => ({ ready: true }) });

declare const needsInitialization: boolean;
// @ts-expect-error a synchronous branch does not make an asynchronous factory branch valid.
defineStore({ protocols: {}, create: () => needsInitialization ? { ready: true } : Promise.resolve({ ready: true }) });

defineStore({ protocols: {}, create({ command }) {
  // @ts-expect-error commands accept one input; group several values in one object.
  command((title: string, amount?: number) => `${title}:${amount}`);
  // @ts-expect-error a defaulted second parameter is still a second command input.
  command((title: string, amount = 1) => `${title}:${amount}`);
  // @ts-expect-error variadic command arguments cannot be forwarded by a single-input command.
  command((...titles: string[]) => titles.join(','));
  return {};
} });
