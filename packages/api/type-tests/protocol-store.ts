import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { StoreInstance } from '@enbox/api';

import { defineProtocol, defineStore, recordCodecs } from '@enbox/api';

const Definition = {
  protocol  : 'https://example.com/protocols/store-types',
  published : true,
  types     : {
    folder : { dataFormats: ['application/json'] },
    member : { dataFormats: ['application/json'] },
    note   : { dataFormats: ['application/json'] },
  },
  structure: {
    folder : { member: { $role: true }, note: {} },
    note   : { $tags: { status: { type: 'string', enum: ['draft', 'published'] } } },
  },
} as const satisfies ProtocolDefinition;
const Protocol = defineProtocol(Definition, {
  folder : recordCodecs.json<{ name: string }>(),
  member : recordCodecs.json<{}>(),
  note   : recordCodecs.json<{ title: string; completed: boolean }>(),
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
void store.records.delete('folder', { recordId: 'folder-id', prune: true });

// @ts-expect-error protocol paths remain exact literals.
store.collection('missing');
// @ts-expect-error role paths use context membership rather than ordinary collections.
store.collection('folder/member');
// @ts-expect-error nested collections require a direct parent selection before reading rows.
store.collection('folder/note').getSnapshot();
// @ts-expect-error root collections do not accept a parent selection.
notes.within('folder-id');
// @ts-expect-error protocol values remain inferred from their codecs.
void notes.create.run({ name: 'Wrong shape' });
// @ts-expect-error patch values retain their declared types.
void notes.patch.run({ id: 'record', patch: { completed: 'yes' } });
// @ts-expect-error filters preserve protocol tag constraints.
store.collection('note', { filter: { tags: { status: 'unknown' } } });
// @ts-expect-error authority routing is supplied by a supported scope rather than query options.
store.collection('note', { from: 'did:example:foreign' });
