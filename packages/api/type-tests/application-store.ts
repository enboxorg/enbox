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
      add   : command((title: string) => notes.create.run({ title })),
      count : command((): number => notes.getSnapshot().records.length),
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
const count: Promise<number> = feature.count.run();
const title: Promise<string> = application.store(Dashboard).add.run('hello').then(record => record.value()).then(value => value.title);
void count;
void title;

// @ts-expect-error domain command input remains inferred through dependent stores.
application.store(Dashboard).add.run(123);
// @ts-expect-error payload codecs remain authoritative through application resolution.
feature.notes.create.run({ title: false });
