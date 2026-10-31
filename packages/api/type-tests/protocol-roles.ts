import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { ContextRolePath, ContextRolesAtPath, ContextRootPath, ProtocolRolePaths, TypedCreateRequest, TypedEnbox } from '@enbox/api';

import { defineProtocol, recordCodecs } from '@enbox/api';

enum Action { Read = 'read' }

const RoleDefinition = {
  protocol  : 'https://example.com/protocols/typed-roles',
  published : true,
  types     : {
    blind  : { dataFormats: ['application/json'] },
    note   : { dataFormats: ['application/json'] },
    writer : { dataFormats: ['application/json'] },
    admin  : {
      dataFormats: ['application/json'],
    },
    workspace: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    member: {
      dataFormats: ['application/json'],
    },
    viewer: {
      dataFormats: ['application/json'],
    },
  },
  uses      : { other: 'https://example.com/other' },
  structure : {
    admin     : { $role: true },
    workspace : {
      $actions: [
        { who: 'anyone', can: ['read'] },
        { role: 'admin', can: ['read'] },
        { role: 'other:workspace/member', can: ['read'] },
        { role: 'workspace/writer', can: ['create'] },
        { role: 'workspace/member', can: ['read'] },
        { role: 'workspace/viewer', can: [Action.Read] },
      ],
      blind  : { $role: true },
      writer : { $role: true },
      note   : {
        $actions: [
          { role: 'workspace/member', can: ['read'] },
          { role: 'workspace/note/member', can: ['read'] },
        ],
        member: { $role: true },
      },
      member : { $role: true },
      viewer : { $role: true },
    },
  },
} as const satisfies ProtocolDefinition;

const RoleProtocol = defineProtocol(RoleDefinition, {
  blind     : recordCodecs.json<unknown>(),
  note      : recordCodecs.json<unknown>(),
  writer    : recordCodecs.json<unknown>(),
  admin     : recordCodecs.json<{ label: string }>(),
  member    : recordCodecs.json<{ label: string }>(),
  viewer    : recordCodecs.json<{ label: string }>(),
  workspace : recordCodecs.json<{ name: string }>(),
});
void RoleProtocol;

// @ts-expect-error shared role selection comes from the protocol's read actions.
defineProtocol(RoleDefinition, RoleProtocol.codecs, {});

const root: ContextRootPath<typeof RoleDefinition> = 'workspace';
const nestedRoot: ContextRootPath<typeof RoleDefinition> = 'workspace/note';
const nestedMember: ContextRolesAtPath<typeof RoleDefinition, 'workspace/note'> = 'workspace/note/member';
const viewerMember: ContextRolesAtPath<typeof RoleDefinition, 'workspace'> = 'workspace/viewer';
void root;
void nestedRoot;
void nestedMember;
void viewerMember;
// @ts-expect-error roles are not context roots.
const roleRoot: ContextRootPath<typeof RoleDefinition> = 'workspace/member';
// @ts-expect-error ancestor roles are not membership for the child context.
const ancestorMember: ContextRolesAtPath<typeof RoleDefinition, 'workspace/note'> = 'workspace/member';
// @ts-expect-error a role without root read access cannot establish shared context access.
const blindMember: ContextRolePath<typeof RoleDefinition> = 'workspace/blind';
// @ts-expect-error create alone does not make a role eligible for following.
const writerMember: ContextRolePath<typeof RoleDefinition> = 'workspace/writer';
void roleRoot;
void ancestorMember;
void blindMember;
void writerMember;

const _UnencryptedDefinition = {
  ...RoleDefinition,
  types: { ...RoleDefinition.types, workspace: { dataFormats: ['application/json'] } },
} as const satisfies ProtocolDefinition;
// @ts-expect-error shared-context roles require encrypted audience support.
const unencryptedRoot: ContextRootPath<typeof _UnencryptedDefinition> = 'workspace';
void unencryptedRoot;

const _NestedOnlyDefinition = {
  ...RoleDefinition,
  structure: {
    ...RoleDefinition.structure,
    workspace: { ...RoleDefinition.structure.workspace, $actions: [{ who: 'anyone', can: ['read'] }] },
  },
} as const satisfies ProtocolDefinition;
// @ts-expect-error a union of roots cannot borrow read authority from a descendant's actions.
const parentFromUnion: ContextRolesAtPath<typeof _NestedOnlyDefinition, 'workspace' | 'workspace/note'> = 'workspace/member';
void parentFromUnion;

type RolePath = ProtocolRolePaths<typeof RoleDefinition>;
type RoleCodecs = typeof RoleProtocol.codecs;

declare const typed: TypedEnbox<
  typeof RoleDefinition,
  RoleCodecs
>;
declare const roleOrRecordPath: 'admin' | 'workspace';

const rootRolePath: RolePath = 'admin';
const nestedRolePath: RolePath = 'workspace/member';
void rootRolePath;
void nestedRolePath;

// @ts-expect-error non-role paths are excluded from ProtocolRolePaths.
const nonRolePath: RolePath = 'workspace';
void nonRolePath;

const roleRequest = {
  data      : { label: 'member' },
  recipient : 'did:example:alice',
} satisfies TypedCreateRequest<typeof RoleDefinition, RoleCodecs, 'workspace/member'>;
void roleRequest;

void typed.records.create('admin', {
  data      : { label: 'administrator' },
  recipient : 'did:example:alice',
});
void typed.records.create('workspace/member', {
  data            : { label: 'member' },
  parentContextId : 'workspace-context',
  recipient       : 'did:example:alice',
});
void typed.records.create('workspace', { data: { name: 'Project' } });
void typed.records.create(roleOrRecordPath, {
  data      : { label: 'administrator' },
  recipient : 'did:example:alice',
});

const sharedContext = typed.contexts.follow('workspace', {
  id       : 'workspace-id',
  ownerDid : 'did:example:owner',
});
void sharedContext.then(context => context.records.query('workspace'));
void sharedContext.then(context => {
  const access: 'member' = context.access;
  const path: 'workspace' = context.path;
  const role: 'workspace/member' | 'workspace/viewer' = context.role;
  void access;
  void path;
  void role;
  // @ts-expect-error member contexts expose only their root and descendants.
  void context.records.query('admin');
  return context.refresh();
});

const forgetting: Promise<void> = typed.contexts.forget({ id: 'workspaceContext', ownerDid: 'did:example:owner' });
void forgetting;

// @ts-expect-error a forget requires the owner's DID even when no live handle exists.
void typed.contexts.forget({ id: 'workspaceContext' });

// @ts-expect-error a follow requires a protocol context root.
void typed.contexts.follow('workspace/member', { id: 'workspace-id', ownerDid: 'did:example:owner' });

// @ts-expect-error callers no longer supply role arrays.
void typed.contexts.follow('workspace', { id: 'workspace-id', ownerDid: 'did:example:owner', roles: ['workspace/member'] });

// @ts-expect-error the singular role contract was removed.
void typed.contexts.follow('workspace', { id: 'workspace-id', ownerDid: 'did:example:owner', role: 'workspace/member' });

// @ts-expect-error role-record creates require a recipient.
void typed.records.create('admin', { data: { label: 'administrator' } });

// @ts-expect-error nested role-record creates require a recipient.
void typed.records.create('workspace/member', { data: { label: 'member' }, parentContextId: 'workspace-context' });

// @ts-expect-error a path union that may select a role still requires a recipient.
void typed.records.create(roleOrRecordPath, { data: { label: 'administrator' } });

// @ts-expect-error role payloads remain codec-derived for the selected path.
void typed.records.create('admin', { data: { name: 'wrong shape' }, recipient: 'did:example:alice' });
