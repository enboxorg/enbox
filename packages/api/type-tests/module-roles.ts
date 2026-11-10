import type { ModuleDefinition } from '@enbox/dwn-sdk-js';
import type { ContextRolePath, ContextRolesAtPath, ContextRootPath, ModuleRolePaths, TypedCreateRequest, TypedEnbox } from '@enbox/api';

import { defineModule, recordCodecs } from '@enbox/api';

enum Action { Read = 'read' }

const OtherModule = defineModule({
  definition: {
    module    : 'https://example.com/other',
    published : true,
    types     : { member: { dataFormats: ['application/json'] } },
    structure : { member: { $role: true } },
  },
  codecs: { member: recordCodecs.json<object>() },
});

const RoleDefinition = {
  module    : 'https://example.com/modules/typed-roles',
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
        { role: 'admin', can: ['read'] },
        { role: 'other:member', can: ['read'] },
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
} as const satisfies ModuleDefinition;

const RoleModule = defineModule({ definition : RoleDefinition, codecs     : {
  blind     : recordCodecs.json<unknown>(),
  note      : recordCodecs.json<unknown>(),
  writer    : recordCodecs.json<unknown>(),
  admin     : recordCodecs.json<{ label: string }>(),
  member    : recordCodecs.json<{ label: string }>(),
  viewer    : recordCodecs.json<{ label: string }>(),
  workspace : recordCodecs.json<{ name: string }>(),
}, dependencies: { other: OtherModule } });
void RoleModule;

// @ts-expect-error shared role selection comes from the module's read actions.
defineModule(RoleDefinition, RoleModule.codecs, {});

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
} as const satisfies ModuleDefinition;
const unencryptedRoot: ContextRootPath<typeof _UnencryptedDefinition> = 'workspace';
void unencryptedRoot;

const _NestedOnlyDefinition = {
  ...RoleDefinition,
  structure: {
    ...RoleDefinition.structure,
    workspace: { ...RoleDefinition.structure.workspace, $actions: [{ who: 'anyone', can: ['read'] }] },
  },
} as const satisfies ModuleDefinition;
// @ts-expect-error a union of roots cannot borrow read authority from a descendant's actions.
const parentFromUnion: ContextRolesAtPath<typeof _NestedOnlyDefinition, 'workspace' | 'workspace/note'> = 'workspace/member';
void parentFromUnion;

type RolePath = ModuleRolePaths<typeof RoleDefinition>;
type RoleCodecs = typeof RoleModule.codecs;

declare const typed: TypedEnbox<
  typeof RoleDefinition,
  RoleCodecs
>;
declare const roleOrRecordPath: 'admin' | 'workspace';

const rootRolePath: RolePath = 'admin';
const nestedRolePath: RolePath = 'workspace/member';
void rootRolePath;
void nestedRolePath;

// @ts-expect-error non-role paths are excluded from ModuleRolePaths.
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

// @ts-expect-error role-record creates require a recipient.
void typed.records.create('admin', { data: { label: 'administrator' } });

// @ts-expect-error nested role-record creates require a recipient.
void typed.records.create('workspace/member', { data: { label: 'member' }, parentContextId: 'workspace-context' });

// @ts-expect-error a path union that may select a role still requires a recipient.
void typed.records.create(roleOrRecordPath, { data: { label: 'administrator' } });

// @ts-expect-error role payloads remain codec-derived for the selected path.
void typed.records.create('admin', { data: { name: 'wrong shape' }, recipient: 'did:example:alice' });
