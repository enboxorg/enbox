import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { StoreInstance } from '@enbox/api';

import { defineProtocol, defineStore, recordCodecs } from '@enbox/api';

const Definition = {
  protocol  : 'https://example.com/protocols/store-types',
  published : true,
  types     : {
    folder   : { dataFormats: ['application/json'] },
    member   : { dataFormats: ['application/json'] },
    note     : { dataFormats: ['application/json'] },
    settings : { dataFormats: ['application/json'] },
  },
  structure: {
    folder   : { member: { $role: true }, note: {}, settings: { $recordLimit: { max: 1 } } },
    note     : { $tags: { status: { type: 'string', enum: ['draft', 'published'] } } },
    settings : { $recordLimit: { max: 1 } },
  },
} as const satisfies ProtocolDefinition;
const Protocol = defineProtocol(Definition, {
  folder   : recordCodecs.json<{ name: string }>(),
  member   : recordCodecs.json<{}>(),
  note     : recordCodecs.json<{ title: string; completed: boolean }>(),
  settings : recordCodecs.json<{ enabled: boolean }>(),
});
const Feature = defineStore({ protocols: { notes: Protocol }, create: ({ protocols }) => protocols.notes });
void Feature;
declare const store: StoreInstance<typeof Feature>;
const notes = store.collection('note', { filter: { tags: { status: 'draft' } } });
const rows: readonly { value: { title: string; completed: boolean } }[] = notes.getSnapshot().records;
const pending: readonly { title: string; completed: boolean }[] = notes.create.getSnapshot().pendingVariables;
void rows;
void pending;
void notes.create.run({ title: 'Typed', completed: false });
void notes.patch.run({ id: 'record', patch: { completed: true } });
void store.collection('folder/note').within('folder-id').create.run({ title: 'Nested', completed: true });
void store.native().records.delete('folder', { recordId: 'folder-id', prune: true });
void store.native().records.set('settings', { data: { enabled: true } });
void store.native().records.set('folder/settings', { data: { enabled: false }, within: 'folder-id' });
void store.native().records.create('note', {
  data          : { title: 'Published', completed: false },
  published     : true,
  datePublished : '2026-10-27T00:00:00.000000Z',
  tags          : { status: 'draft' },
});
void store.native().contexts.list();

// @ts-expect-error protocol paths remain exact literals.
store.collection('missing');
// @ts-expect-error role paths use context membership rather than ordinary collections.
store.collection('folder/member');
// @ts-expect-error singleton paths use native set rather than collection creates.
store.collection('settings');
// @ts-expect-error nested singleton paths also require native singleton semantics.
store.collection('folder/settings');
// @ts-expect-error native access is explicit rather than an eager records getter.
void store.records;
// @ts-expect-error nested collections require a direct parent selection before reading rows.
store.collection('folder/note').getSnapshot();
// @ts-expect-error root collections do not accept a parent selection.
notes.within('folder-id');
// @ts-expect-error protocol values remain inferred from their codecs.
void notes.create.run({ name: 'Wrong shape' });
// @ts-expect-error patch values retain their declared types.
void notes.patch.run({ id: 'record', patch: { completed: 'yes' } });
// @ts-expect-error collection creates accept codec data, not native write metadata.
void notes.create.run({ title: 'Metadata needs native()', completed: false, published: true });
// @ts-expect-error pruning is an explicit native operation, not the data-only delete input.
void notes.delete.run({ recordId: 'record', prune: true });
// @ts-expect-error collection commands do not expose native full-update options.
notes.update;
// @ts-expect-error filters preserve protocol tag constraints.
store.collection('note', { filter: { tags: { status: 'unknown' } } });
// @ts-expect-error authority routing is supplied by a supported scope rather than query options.
store.collection('note', { from: 'did:example:foreign' });
