import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { ProtocolRolePaths, TypedCreateRequest, TypedEnbox } from '@enbox/api';

import { defineProtocol, recordCodecs } from '@enbox/api';

const RoleDefinition = {
  protocol  : 'https://example.com/protocols/typed-roles',
  published : true,
  types     : {
    admin: {
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
  structure: {
    admin     : { $role: true },
    workspace : {
      $actions: [
        { role: 'workspace/member', can: ['read'] },
        { role: 'workspace/viewer', can: ['read'] },
      ],
      member : { $role: true },
      viewer : { $role: true },
    },
  },
} as const satisfies ProtocolDefinition;

const RoleProtocol = defineProtocol(RoleDefinition, {
  admin     : recordCodecs.json<{ label: string }>(),
  member    : recordCodecs.json<{ label: string }>(),
  viewer    : recordCodecs.json<{ label: string }>(),
  workspace : recordCodecs.json<{ name: string }>(),
}, {
  roleGroups: {
    default : ['workspace/member', 'workspace/viewer'],
    viewers : ['workspace/viewer'],
  },
});
void RoleProtocol;

const mutableRoles: ['workspace/member', 'workspace/viewer'] = ['workspace/member', 'workspace/viewer'];
const MutableRoleProtocol = defineProtocol(RoleDefinition, RoleProtocol.codecs, {
  roleGroups: { default: mutableRoles },
});
// @ts-expect-error defineProtocol copies and freezes mutable role-group inputs.
MutableRoleProtocol.roleGroups.default.reverse();

// @ts-expect-error role groups accept only encrypted contextual role paths.
defineProtocol(RoleDefinition, RoleProtocol.codecs, { roleGroups: { default: ['workspace'] } });

// @ts-expect-error a non-empty role-group declaration must include the protocol-global default.
defineProtocol(RoleDefinition, RoleProtocol.codecs, { roleGroups: { viewers: ['workspace/viewer'] } });

type RolePath = ProtocolRolePaths<typeof RoleDefinition>;
type RoleCodecs = typeof RoleProtocol.codecs;

declare const typed: TypedEnbox<
  typeof RoleDefinition,
  RoleCodecs,
  typeof RoleProtocol.roleGroups
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

const sharedContext = typed.contexts.follow({
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
  return context.whenCurrent();
});

const viewerContext = typed.contexts.follow({
  id       : 'workspace-id',
  ownerDid : 'did:example:owner',
  group    : 'viewers',
});
void viewerContext.then(context => {
  const role: 'workspace/viewer' = context.role;
  void role;
});

// @ts-expect-error undeclared role groups cannot be followed.
void typed.contexts.follow({ id: 'workspace-id', ownerDid: 'did:example:owner', group: 'missing' });

// @ts-expect-error callers no longer supply role arrays.
void typed.contexts.follow({ id: 'workspace-id', ownerDid: 'did:example:owner', roles: ['workspace/member'] });

// @ts-expect-error the singular role contract was removed.
void typed.contexts.follow({ id: 'workspace-id', ownerDid: 'did:example:owner', role: 'workspace/member' });

// @ts-expect-error role-record creates require a recipient.
void typed.records.create('admin', { data: { label: 'administrator' } });

// @ts-expect-error nested role-record creates require a recipient.
void typed.records.create('workspace/member', { data: { label: 'member' }, parentContextId: 'workspace-context' });

// @ts-expect-error a path union that may select a role still requires a recipient.
void typed.records.create(roleOrRecordPath, { data: { label: 'administrator' } });

// @ts-expect-error role payloads remain codec-derived for the selected path.
void typed.records.create('admin', { data: { name: 'wrong shape' }, recipient: 'did:example:alice' });
