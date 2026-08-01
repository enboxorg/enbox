import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  ContextMember,
  ContextRecord,
  ContextView,
  MemberContext,
  OwnedContext,
  TypedEnbox,
} from '@enbox/api';

import { defineProtocol, recordCodecs } from '@enbox/api';

const ContextDefinition = {
  protocol  : 'https://example.com/protocols/context-records',
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
      outsider: { $role: true },
    },
    workspace: {
      $actions: [
        { role: 'workspace/member', can: ['read'] },
        { role: 'workspace/viewer', can: ['read'] },
      ],
      member : { $recordLimit: { max: 1 }, $role: true },
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
} as const satisfies ProtocolDefinition;

const ContextProtocol = defineProtocol(ContextDefinition, {
  invite    : recordCodecs.json<{ code: string }>(),
  live      : recordCodecs.json<{ active: boolean }>(),
  member    : recordCodecs.json<{ label: string }>(),
  note      : recordCodecs.json<{ text: string }>(),
  outsider  : recordCodecs.json<{ label: string }>(),
  project   : recordCodecs.json<{ name: string }>(),
  session   : recordCodecs.json<{ peer: string }>(),
  title     : recordCodecs.json<{ text: string }>(),
  viewer    : recordCodecs.json<{ expires: boolean }>(),
  workspace : recordCodecs.json<{ name: string }>(),
});
void ContextProtocol;

declare const context:
  | OwnedContext<typeof ContextDefinition, typeof ContextProtocol.codecs, 'workspace'>
  | MemberContext<
    typeof ContextDefinition,
    typeof ContextProtocol.codecs,
    'workspace/member' | 'workspace/viewer'
  >;
declare const catalogContext: MemberContext<
  typeof ContextDefinition,
  typeof ContextProtocol.codecs,
  'workspace/member' | 'project/outsider'
>;
declare const typed: TypedEnbox<typeof ContextDefinition, typeof ContextProtocol.codecs>;

if (catalogContext.role === 'workspace/member') {
  const root: 'workspace' = catalogContext.path;
  void root;
  void catalogContext.records.query('workspace/note');
  // @ts-expect-error narrowing a catalog entry also confines its record paths to that role's root.
  void catalogContext.records.query('project');
} else {
  const root: 'project' = catalogContext.path;
  void root;
  void catalogContext.records.query('project');
  // @ts-expect-error narrowing a catalog entry also confines its record paths to that role's root.
  void catalogContext.records.query('workspace/note');
}

const owned = typed.contexts.open('workspace', 'workspace-id');
const listed: Promise<MemberContext<typeof ContextDefinition, typeof ContextProtocol.codecs>[]> =
  typed.contexts.list();
const observed: Promise<ContextView<MemberContext<typeof ContextDefinition, typeof ContextProtocol.codecs>>> =
  typed.contexts.observe();
void listed;
void observed;
// @ts-expect-error role records are membership, not contexts.
void typed.contexts.open('workspace/member', 'workspace-id/member-id');
void owned.then((value): void => {
  const access: 'owner' = value.access;
  const ownerDid: string = value.ownerDid;
  const path: 'workspace' = value.path;
  void access;
  void ownerDid;
  void path;
  void value.records.query('workspace/note');
  const members = value.members(['workspace/member', 'workspace/viewer']);
  const assigned: Promise<ContextMember<
    typeof ContextDefinition,
    typeof ContextProtocol.codecs,
    'workspace/member'
  >> = members.set('did:example:alice', {
    data : { label: 'editor' },
    role : 'workspace/member',
  });
  void assigned;
  void members.set('did:example:bob', {
    data : { expires: true },
    role : 'workspace/viewer',
  });
  void members.list().then(async (listed): Promise<void> => {
    const member = listed[0];
    if (member?.role === 'workspace/member') {
      const label: string = member.data.label;
      void label;
    } else if (member?.role === 'workspace/viewer') {
      const expires: boolean = member.data.expires;
      void expires;
    }
    // @ts-expect-error member rows do not expose role-record IDs.
    void member?.recordId;
  });
  // @ts-expect-error role data is correlated with the selected path.
  void members.set('did:example:bob', { data: { label: 'wrong' }, role: 'workspace/viewer' });
  // @ts-expect-error a role outside the declared group cannot be assigned.
  void members.set('did:example:bob', { data: {}, role: 'workspace/other' });
  // @ts-expect-error non-role paths cannot form a membership group.
  value.members(['workspace/note']);
  // @ts-expect-error a membership group cannot be empty.
  value.members([]);
  // @ts-expect-error roles outside the owned root cannot form a membership group.
  value.members(['project/outsider']);
  // @ts-expect-error a bound context cannot create a second copy of its root.
  void value.records.create('workspace', { data: { name: 'duplicate' } });
  // @ts-expect-error context records expose only their root and descendants.
  void value.records.query('invite');
  // @ts-expect-error every subscribed path must belong to the bound context.
  void value.records.subscribe(['workspace/note', 'invite'], (): void => {});
  void value.records.query('workspace', {
    materialize: {
      // @ts-expect-error role records cannot be materialized through context queries.
      children: ['workspace/member'] as const,
    },
    pagination: { limit: 1 },
  });
  void value.records.observe('workspace', {
    materialize: {
      // @ts-expect-error role records cannot be materialized through context views.
      children: ['workspace/member'] as const,
    },
    pagination: { limit: 1 },
  });
});

const singleton = typed.contexts.open('workspace/title', 'workspace-id/title-id');
void singleton.then((value): void => {
  // @ts-expect-error a bound context cannot set its own root record.
  void value.records.set('workspace/title', { data: { text: 'replacement' } });
});

if (context.access === 'member') {
  void context.role;
  void context.forget();
  void context.leave();
  void context.whenCurrent();
  // @ts-expect-error only owners manage context membership.
  context.members(['workspace/member']);
}

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

void context.records.subscribe('workspace/note', async (event): Promise<void> => {
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
// @ts-expect-error membership is available only through ownedContext.members().
void context.records.create('workspace/member', { data: { label: 'member' }, recipient: 'did:example:member' });
// @ts-expect-error role records are not part of context content.
void context.records.query('workspace/member');

// @ts-expect-error context queries cannot override their source tenant.
void context.records.query('workspace/note', { from: 'did:example:other' });
// @ts-expect-error context queries cannot override their role.
void context.records.query('workspace/note', { protocolRole: 'workspace/other' });
// @ts-expect-error context views cannot override their source tenant.
void context.records.observe('workspace/note', { from: 'did:example:other', pagination: { limit: 20 } });
// @ts-expect-error context subscriptions accept no routing or query options.
void context.records.subscribe('workspace/note', (): void => {}, { from: 'did:example:other' });
// @ts-expect-error context reads cannot override their source tenant.
void context.records.read('workspace/note', { filter: { recordId: 'note-id' }, from: 'did:example:other' });
// @ts-expect-error context deletes cannot override their source tenant.
void context.records.delete('workspace/note', { from: 'did:example:other', recordId: 'note-id' });
// @ts-expect-error context deletes cannot override their role.
void context.records.delete('workspace/note', { protocolRole: 'workspace/other', recordId: 'note-id' });
// @ts-expect-error delivery repair belongs to the owner-side membership API.
void context.records.retryDelivery('workspace/member', 'role-id');
// @ts-expect-error delivery state belongs to the owner-side membership API.
void context.records.deliveryState('workspace/member', 'role-id');
// @ts-expect-error record-ID delivery repair was removed in favor of owned-context membership.
void typed.records.retryDelivery('workspace/member', 'role-id');
// @ts-expect-error record-ID delivery lookup was removed in favor of owned-context membership.
void typed.records.deliveryState('workspace/member', 'role-id');
