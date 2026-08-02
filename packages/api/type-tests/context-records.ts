import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  ContextMember,
  ContextMemberView,
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
      $actions : [{ role: 'project/outsider', can: ['read'] }],
      outsider : { $role: true },
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
}, {
  roleGroups: {
    default : ['workspace/member', 'workspace/viewer'],
    project : ['project/outsider'],
    viewers : ['workspace/viewer'],
  },
});
void ContextProtocol;

declare const context:
  | OwnedContext<
    typeof ContextDefinition,
    typeof ContextProtocol.codecs,
    'workspace',
    typeof ContextProtocol.roleGroups
  >
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
declare const typed: TypedEnbox<
  typeof ContextDefinition,
  typeof ContextProtocol.codecs,
  typeof ContextProtocol.roleGroups
>;

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
const observed: ContextView<MemberContext<typeof ContextDefinition, typeof ContextProtocol.codecs>> =
  typed.contexts.observe();
const closed: void = observed.close();
void listed;
void observed;
void closed;
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
  void value.invite('did:example:alice', { preview: { title: 'Shared workspace' } });
  void value.invite('did:example:alice', { group: 'viewers' });
  // @ts-expect-error invitation preview values are intentionally string-only.
  void value.invite('did:example:alice', { preview: { count: 1 } });
  // @ts-expect-error only groups declared for this context root can be invited.
  void value.invite('did:example:alice', { group: 'project' });
  const members = value.members();
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
  const memberView: Promise<ContextMemberView<ContextMember<
    typeof ContextDefinition,
    typeof ContextProtocol.codecs,
    'workspace/member' | 'workspace/viewer'
  >>> = members.observe();
  void memberView.then((view): void => {
    void view.getState().members;
    // @ts-expect-error membership views use the domain name, not generic records.
    void view.getState().records;
    const member = view.getState().members[0];
    // @ts-expect-error member rows do not expose role-record IDs.
    void member?.recordId;
  });
  // @ts-expect-error role data is correlated with the selected path.
  void members.set('did:example:bob', { data: { label: 'wrong' }, role: 'workspace/viewer' });
  // @ts-expect-error a role outside the declared group cannot be assigned.
  void members.set('did:example:bob', { data: {}, role: 'workspace/other' });
  const viewers = value.members('viewers');
  void viewers.set('did:example:bob', { data: { expires: true }, role: 'workspace/viewer' });
  // @ts-expect-error only groups declared for this context root can be selected.
  value.members('project');
  // @ts-expect-error undeclared role groups cannot be selected.
  value.members('missing');
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

void typed.contexts.open('project', 'project-id').then((value): void => {
  // @ts-expect-error this root has no default role group, so the group is required.
  void value.invite('did:example:alice');
  void value.invite('did:example:alice', { group: 'project' });
  const members = value.members('project');
  void members.set('did:example:alice', {
    data : { label: 'guest' },
    role : 'project/outsider',
  });
});

void typed.contexts.invitations.list().then((invitations): void => {
  const invitation = invitations[0];
  if (invitation !== undefined) {
    const group: 'default' | 'project' | 'viewers' = invitation.group;
    void group;
    void invitation.accept().then((shared): void => {
      const role: 'workspace/member' | 'workspace/viewer' | 'project/outsider' = shared.role;
      void role;
    });
  }
});

void typed.contexts.invitations.observe().then((view): void => {
  const status: 'loading' | 'ready' | 'stale' | 'error' = view.getState().status;
  void status;
  void view.getState().invitations;
  // @ts-expect-error invitation views use the domain name, not generic records.
  void view.getState().records;
  // @ts-expect-error the inbox is a bounded state, not a paginated record query.
  void view.getState().hasMore;
});

declare const plainTyped: TypedEnbox<typeof ContextDefinition, typeof ContextProtocol.codecs>;
// @ts-expect-error protocols without role groups do not expose an invitation inbox.
void plainTyped.contexts.invitations;
void plainTyped.contexts.open('workspace', 'workspace-id').then((value): void => {
  // @ts-expect-error contexts without a declared membership group cannot invite.
  void value.invite('did:example:alice');
});

void typed.contexts.follow({
  group    : 'project',
  id       : 'project-id',
  ownerDid : 'did:example:owner',
}).then((value): void => {
  const path: 'project' = value.path;
  const role: 'project/outsider' = value.role;
  void path;
  void role;
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
  context.members();
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
  const note: ContextRecord<{ text: string }> | undefined = view.getState().records[0];
  void note;
  // @ts-expect-error observed states retain context-bound handles.
  void view.getState().records[0]?.rawMessage;
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
  materialize : { children: ['workspace/title'] as const },
  pagination  : { limit: 1 },
}).then((view): void => {
  const title: ContextRecord<{ text: string }> | undefined = view.getState().records[0]?.children.title?.record;
  void title;
  // @ts-expect-error materialized views retain context-bound child handles.
  void view.getState().records[0]?.children.title?.record.rawMessage;
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
