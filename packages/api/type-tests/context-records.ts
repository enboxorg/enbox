import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { ContextRecord, SharedContext } from '@enbox/api';

import { defineProtocol, recordCodecs } from '@enbox/api';

const ContextDefinition = {
  protocol  : 'https://example.com/protocols/context-records',
  published : true,
  types     : {
    live      : { dataFormats: ['application/json'] },
    member    : { dataFormats: ['application/json'] },
    note      : { dataFormats: ['application/json'] },
    session   : { dataFormats: ['application/json'] },
    title     : { dataFormats: ['application/json'] },
    workspace : { dataFormats: ['application/json'] },
  },
  structure: {
    workspace: {
      $actions : [{ role: 'workspace/member', can: ['read'] }],
      member   : { $role: true },
      live     : {
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
} as const satisfies ProtocolDefinition;

const ContextProtocol = defineProtocol(ContextDefinition, {
  live      : recordCodecs.json<{ active: boolean }>(),
  member    : recordCodecs.json<{ label: string }>(),
  note      : recordCodecs.json<{ text: string }>(),
  session   : recordCodecs.json<{ peer: string }>(),
  title     : recordCodecs.json<{ text: string }>(),
  workspace : recordCodecs.json<{ name: string }>(),
});
void ContextProtocol;

declare const context: SharedContext<typeof ContextDefinition, typeof ContextProtocol.codecs>;

const created: Promise<ContextRecord<{ text: string }>> = context.records.create('workspace/note', {
  data: { text: 'hello' },
});
const queried = context.records.query('workspace/note', { pagination: { limit: 20 } });
const read: Promise<ContextRecord<{ text: string }> | undefined> = context.records.read('workspace/note', 'note-id');
const set: Promise<ContextRecord<{ text: string }>> = context.records.set('workspace/title', { data: { text: 'Title' } });
void created;
void read;
void set;
void context.records.delete('workspace/note', { recordId: 'note-id' });

void queried.then(async (page): Promise<void> => {
  const current: ContextRecord<{ text: string }> | undefined = page.records[0];
  const next = await page.next();
  const continued: ContextRecord<{ text: string }> | undefined = next?.records[0];
  void current;
  void continued;
  // @ts-expect-error plain query results retain context-bound handles.
  void page.records[0]?.rawMessage;
  // @ts-expect-error pagination continuations retain context-bound handles.
  await next?.records[0]?.send('did:example:other');
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
  materialize : { children: ['workspace/title'] as const },
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
  pagination: { limit: 20 },
}).then((view): void => {
  const note: ContextRecord<{ text: string }> | undefined = view.getSnapshot().records[0];
  void note;
  // @ts-expect-error observed snapshots retain context-bound handles.
  void view.getSnapshot().records[0]?.rawMessage;
});

void context.records.observe('workspace', {
  materialize : { children: ['workspace/title'] as const },
  pagination  : { limit: 1 },
}).then((view): void => {
  const title: ContextRecord<{ text: string }> | undefined = view.getSnapshot().records[0]?.children.title?.record;
  void title;
  // @ts-expect-error materialized views retain context-bound child handles.
  void view.getSnapshot().records[0]?.children.title?.record.rawMessage;
});

void created.then(async (record): Promise<void> => {
  const updated = await record.update({ data: { text: 'updated' } });
  const patched = await record.patch({ text: 'patched' });
  await record.delete({ prune: true });
  // @ts-expect-error updates retain context-bound handles.
  void updated.rawMessage;
  // @ts-expect-error patches retain context-bound handles.
  void patched.rawMessage;

  // @ts-expect-error context updates cannot override their source tenant.
  await record.update({ data: { text: 'wrong tenant' }, from: 'did:example:other' });
  // @ts-expect-error context updates cannot override their role.
  await record.update({ data: { text: 'wrong role' }, protocolRole: 'workspace/other' });
  // @ts-expect-error context updates cannot control DWN storage.
  await record.update({ data: { text: 'not stored' }, store: false });
  // @ts-expect-error context patches cannot override their source tenant.
  await record.patch({ text: 'wrong tenant' }, { from: 'did:example:other' });
  // @ts-expect-error context deletes cannot sign as the source owner.
  await record.delete({ signAsOwner: true });
  // @ts-expect-error context records cannot be sent manually.
  await record.send('did:example:other');
  // @ts-expect-error context records cannot be stored manually.
  await record.store();
  // @ts-expect-error context records cannot expose their raw serialization.
  void record.toJSON();
  // @ts-expect-error context records do not expose raw DWN messages.
  void record.rawMessage;
});

// @ts-expect-error context creates cannot override their source tenant.
void context.records.create('workspace/note', { data: { text: 'hello' }, from: 'did:example:other' });
// @ts-expect-error context creates cannot override their role.
void context.records.create('workspace/note', { data: { text: 'hello' }, protocolRole: 'workspace/other' });
// @ts-expect-error context creates cannot control DWN storage.
void context.records.create('workspace/note', { data: { text: 'hello' }, store: false });
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
void context.records.create('workspace/member', { data: { label: 'member' }, recipient: 'did:example:member' });

// @ts-expect-error context queries cannot override their source tenant.
void context.records.query('workspace/note', { from: 'did:example:other' });
// @ts-expect-error context queries cannot override their role.
void context.records.query('workspace/note', { protocolRole: 'workspace/other' });
// @ts-expect-error context views cannot override their source tenant.
void context.records.observe('workspace/note', { from: 'did:example:other', pagination: { limit: 20 } });
// @ts-expect-error context reads cannot override their source tenant.
void context.records.read('workspace/note', { filter: { recordId: 'note-id' }, from: 'did:example:other' });
// @ts-expect-error context deletes cannot override their source tenant.
void context.records.delete('workspace/note', { from: 'did:example:other', recordId: 'note-id' });
// @ts-expect-error context deletes cannot override their role.
void context.records.delete('workspace/note', { protocolRole: 'workspace/other', recordId: 'note-id' });
// @ts-expect-error delivery repair belongs to the owner-side membership API.
void context.records.retryDelivery('workspace/member', 'role-id');
