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
      dataFormats: ['application/json'],
    },
    member: {
      dataFormats: ['application/json'],
    },
  },
  structure: {
    admin     : { $role: true },
    workspace : {
      member: { $role: true },
    },
  },
} as const satisfies ProtocolDefinition;

const RoleProtocol = defineProtocol(RoleDefinition, {
  admin     : recordCodecs.json<{ label: string }>(),
  member    : recordCodecs.json<{ label: string }>(),
  workspace : recordCodecs.json<{ name: string }>(),
});
void RoleProtocol;

type RolePath = ProtocolRolePaths<typeof RoleDefinition>;
type RoleCodecs = typeof RoleProtocol.codecs;

declare const typed: TypedEnbox<typeof RoleDefinition, RoleCodecs>;
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

// @ts-expect-error role-record creates require a recipient.
void typed.records.create('admin', { data: { label: 'administrator' } });

// @ts-expect-error nested role-record creates require a recipient.
void typed.records.create('workspace/member', { data: { label: 'member' }, parentContextId: 'workspace-context' });

// @ts-expect-error a path union that may select a role still requires a recipient.
void typed.records.create(roleOrRecordPath, { data: { label: 'administrator' } });

// @ts-expect-error role payloads remain codec-derived for the selected path.
void typed.records.create('admin', { data: { name: 'wrong shape' }, recipient: 'did:example:alice' });
