import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type {
  ContextRecord,
  ContextRecordsApi,
  TypedEnbox,
} from '@enbox/api';

import { defineModule, recordCodecs } from '@enbox/api';

const ContextDefinition = {
  module    : 'https://example.com/modules/context-records',
  published : true,
  types     : {
    invite    : { dataFormats: ['application/json'] },
    live      : { dataFormats: ['application/json'] },
    member    : { dataFormats: ['application/json'] },
    note      : { dataFormats: ['application/json'], encryptionRequired: true },
    outsider  : { dataFormats: ['application/json'] },
    project   : { dataFormats: ['application/json'] },
    session   : { dataFormats: ['application/json'] },
    title     : { dataFormats: ['application/json'] },
    viewer    : { dataFormats: ['application/json'] },
    workspace : { dataFormats: ['application/json'] },
  },
  structure: {
    invite  : {},
    project : {
      $actions : [{ role: 'project/outsider', can: ['read'] }],
      outsider : { $role: true },
    },
    workspace: {
      $actions: [
        { role: 'workspace/member', can: ['read'] },
        { role: 'workspace/viewer', can: ['read'] },
      ],
      member : { $role: true },
      viewer : { $role: true },
      live   : {
        $actions : [{ role: 'workspace/member', can: ['create', 'read'] }],
        session  : {
          $actions: [{ role: 'workspace/member', can: ['create', 'read', 'delete'] }],
        },
      },
      note: {
        $actions : [{ role: 'workspace/member', can: ['create', 'read', 'update', 'delete'] }],
        $squash  : true,
      },
      title: {
        $actions     : [{ role: 'workspace/member', can: ['create', 'read', 'update'] }],
        $recordLimit : { max: 1 },
      },
    },
  },
} as const satisfies ModuleDefinition;

const ContextModule = defineModule({ definition : ContextDefinition, codecs     : {
  invite    : recordCodecs.json<{ code: string }>(),
  live      : recordCodecs.json<{ active: boolean }>(),
  member    : recordCodecs.json<{ label: string }>(),
  note      : recordCodecs.json<{ text: string }>(),
  outsider  : recordCodecs.json<{ label: string }>(),
  project   : recordCodecs.json<{ projectCode: number }>(),
  session   : recordCodecs.json<{ peer: string }>(),
  title     : recordCodecs.json<{ text: string }>(),
  viewer    : recordCodecs.json<{ expires: boolean }>(),
  workspace : recordCodecs.json<{ name: string }>(),
} });
void ContextModule;

declare const typed: TypedEnbox<
  typeof ContextDefinition,
  typeof ContextModule.codecs
>;
declare const callerSignal: AbortSignal;
void typed.records.subscribe('workspace/note', { signal: callerSignal }, (): void => {});

const scopedRecords = typed.scope({
  allowedPaths : new Set(['workspace', 'workspace/note', 'workspace/live', 'workspace/live/session', 'workspace/title']),
  contextId    : 'workspace-id',
  contextPath  : 'workspace',
});
const context = { records: scopedRecords };

// Generic / widened ContextRecordsApi retains callable create and set (#9).
declare const genericRecords: ContextRecordsApi;
void genericRecords.create('child', { data: {}, parentContextId: 'root-id' });
declare const widenedRootRecords: ContextRecordsApi<
  typeof ContextDefinition,
  typeof ContextModule.codecs,
  string
>;
void widenedRootRecords.create('workspace/note', { data: { text: 'widened' } });
void widenedRootRecords.set('workspace/title', { data: { text: 'widened' } });

// @ts-expect-error a bound context cannot create a second copy of its root.
void context.records.create('workspace', { data: { name: 'duplicate' } });
// @ts-expect-error context records expose only their root and descendants.
void context.records.query('invite');
// @ts-expect-error every subscribed path must belong to the bound context.
void context.records.subscribe(['workspace/note', 'invite'], (): void => {});
void context.records.query('workspace', {
  materialize: {
    // @ts-expect-error role records cannot be materialized through context queries.
    children: ['workspace/member'] as const,
  },
  pagination: { limit: 1 },
});
void context.records.observe('workspace', {
  materialize: {
    // @ts-expect-error role records cannot be materialized through context views.
    children: ['workspace/member'] as const,
  },
  pagination: { limit: 1 },
});

const singletonRecords = typed.scope({
  allowedPaths : new Set(['workspace/title']),
  contextId    : 'workspace-id/title-id',
  contextPath  : 'workspace/title',
});
// @ts-expect-error a bound context cannot set its own root record.
void singletonRecords.set('workspace/title', { data: { text: 'replacement' } });

const created: Promise<ContextRecord<{ text: string }>> = context.records.create('workspace/note', {
  data: { text: 'hello' },
});
const queried = context.records.query('workspace/note', { pagination: { limit: 20 } });
const read: Promise<ContextRecord<{ text: string }> | undefined> = context.records.read('workspace/note', 'note-id');
const patched: Promise<ContextRecord<{ text: string }>> = context.records.patch(
  'workspace/note',
  'note-id',
  (current) => {
    const note: { text: string } = current;
    void note;
    return { text: `${current.text}!` };
  },
);
const set: Promise<ContextRecord<{ text: string }>> = context.records.set('workspace/title', { data: { text: 'Title' } });
void created;
void read;
void patched;
void set;
void context.records.delete('workspace/note', { recordId: 'note-id' });
const count: Promise<number> = context.records.count('workspace/note');
void count;

void queried.then(async (page): Promise<void> => {
  const current: ContextRecord<{ text: string }> | undefined = page.records[0];
  const next = await page.next();
  const continued: ContextRecord<{ text: string }> | undefined = next?.records[0];
  void current;
  void continued;
  // @ts-expect-error plain query results retain context-bound handles.
  void page.records[0]?.rawMessage;
});

void read.then((record): void => {
  // @ts-expect-error point reads retain context-bound handles.
  void record?.rawMessage;
});

void set.then((record): void => {
  // @ts-expect-error singleton sets retain context-bound handles.
  void record.rawMessage;
});

void context.records.query('workspace', {
  materialize : { children: ['workspace/title'] },
  pagination  : { limit: 1 },
}).then((page): void => {
  const title: ContextRecord<{ text: string }> | undefined = page.records[0]?.children.title?.record;
  void title;
  // @ts-expect-error materialized parents retain context-bound handles.
  void page.records[0]?.record.rawMessage;
  // @ts-expect-error context records do not expose raw DWN messages.
  void page.records[0]?.children.title?.record.rawMessage;
});

void context.records.observe('workspace/note', {
  pagination : { limit: 20 },
  signal     : callerSignal,
}).then((view): void => {
  const note: ContextRecord<{ text: string }> | undefined = view.getSnapshot().records[0];
  void view.loadMore();
  void note;
  // @ts-expect-error observed states retain context-bound handles.
  void view.getSnapshot().records[0]?.rawMessage;
});

void context.records.subscribe('workspace/note', { signal: callerSignal }, async (event): Promise<void> => {
  if (event.type === 'error') {
    const error: Error = event.error;
    void error;
    return;
  }
  const path: 'workspace/note' = event.path;
  const note: ContextRecord<{ text: string }> = event.record;
  const value: { text: string } = await note.value();
  void path;
  void value;
  // @ts-expect-error subscribed context records hide raw DWN messages.
  void note.rawMessage;
});

void context.records.subscribe(
  ['workspace/note', 'workspace/live'],
  { initial: true },
  async (event): Promise<void> => {
    if (event.type === 'error') { return; }
    if (event.path === 'workspace/note') {
      const note: ContextRecord<{ text: string }> = event.record;
      const value: { text: string } = await note.value();
      void value;
      // @ts-expect-error initial context records retain the context-bound surface.
      void note.rawMessage;
      return;
    }
    const live: { active: boolean } = await event.record.value();
    void live;
  },
);

void context.records.subscribe(['workspace/note', 'workspace/live'], async (event): Promise<void> => {
  if (event.type === 'error') { return; }
  if (event.path === 'workspace/note') {
    const note: { text: string } = await event.record.value();
    void note;
    return;
  }
  const live: { active: boolean } = await event.record.value();
  void live;
});

void context.records.observe('workspace', {
  materialize : { children: ['workspace/title'] },
  pagination  : { limit: 1 },
}).then((view): void => {
  const title: ContextRecord<{ text: string }> | undefined = view.getSnapshot().records[0]?.children.title?.record;
  void title;
  // @ts-expect-error materialized views retain context-bound child handles.
  void view.getSnapshot().records[0]?.children.title?.record.rawMessage;
});

void created.then(async (record): Promise<void> => {
  const updated = await record.update({ data: { text: 'updated' } });
  await record.delete({ prune: true });
  // @ts-expect-error updates retain context-bound handles.
  void updated.rawMessage;

  // @ts-expect-error context updates cannot override their source tenant.
  await record.update({ data: { text: 'wrong tenant' }, from: 'did:example:other' });
  // @ts-expect-error context updates cannot override their role.
  await record.update({ data: { text: 'wrong role' }, moduleRole: 'workspace/other' });
  // @ts-expect-error partial updates belong to context.records.patch().
  await record.patch({ text: 'patched' });
  // @ts-expect-error context records cannot expose their raw serialization.
  void record.toJSON();
  // @ts-expect-error context records do not expose raw DWN messages.
  void record.rawMessage;
});

// @ts-expect-error context creates cannot override their source tenant.
void context.records.create('workspace/note', { data: { text: 'hello' }, from: 'did:example:other' });
// @ts-expect-error context creates cannot override their role.
void context.records.create('workspace/note', { data: { text: 'hello' }, moduleRole: 'workspace/other' });
// @ts-expect-error context creates cannot inject audience keys.
void context.records.create('workspace/note', { data: { text: 'hello' }, recipientRolePublicKey: {} });
void context.records.create('workspace/note', {
  data             : { text: 'snapshot' },
  dateCreated      : '2026-01-01T00:00:00.000000Z',
  messageTimestamp : '2026-01-01T00:00:00.000000Z',
  squash           : true,
});
void context.records.create('workspace/live/session', {
  data            : { peer: 'peer-key' },
  parentContextId : 'workspace/live-context',
});
// @ts-expect-error context records.patch cannot delete a required field.
void context.records.patch('workspace/note', 'note-id', { text: null });
// @ts-expect-error context records.patch cannot introduce fields outside the payload type.
void context.records.patch('workspace/note', 'note-id', { missing: true });
// @ts-expect-error membership is available only through ownedContext.members.
void context.records.create('workspace/member', { data: { label: 'member' }, recipient: 'did:example:member' });
// @ts-expect-error role records are not part of context content.
void context.records.query('workspace/member');

// @ts-expect-error context queries cannot override their source tenant.
void context.records.query('workspace/note', { from: 'did:example:other' });
// @ts-expect-error context queries cannot override their role.
void context.records.query('workspace/note', { moduleRole: 'workspace/other' });
// @ts-expect-error context views cannot override their source tenant.
void context.records.observe('workspace/note', { from: 'did:example:other', pagination: { limit: 20 } });
// @ts-expect-error context subscriptions accept no routing or query options.
void context.records.subscribe('workspace/note', (): void => {}, { from: 'did:example:other' });
// @ts-expect-error context reads cannot override their source tenant.
void context.records.read('workspace/note', { filter: { recordId: 'note-id' }, from: 'did:example:other' });
// @ts-expect-error context deletes cannot override their source tenant.
void context.records.delete('workspace/note', { from: 'did:example:other', recordId: 'note-id' });
// @ts-expect-error context deletes cannot override their role.
void context.records.delete('workspace/note', { moduleRole: 'workspace/other', recordId: 'note-id' });
// @ts-expect-error delivery repair belongs to the owner-side membership API.
void context.records.retryDelivery('workspace/member', 'role-id');
// @ts-expect-error delivery state belongs to the owner-side membership API.
void context.records.deliveryState('workspace/member', 'role-id');
// @ts-expect-error record-ID delivery repair was removed in favor of owned-context membership.
void typed.records.retryDelivery('workspace/member', 'role-id');
// @ts-expect-error record-ID delivery lookup was removed in favor of owned-context membership.
void typed.records.deliveryState('workspace/member', 'role-id');
