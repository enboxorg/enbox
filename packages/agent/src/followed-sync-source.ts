/** One candidate role and the exact context paths it can replicate. */
export type FollowedSyncRole = {
  protocolRole: string;
  protocolPaths: [string, ...string[]];
};

/** Durable description of one foreign context accepted through a role record. */
export type FollowedSyncSource = {
  /** The accepted role record ID. It is also the source lifecycle identifier. */
  id: string;
  /** DID whose hosted DWN owns the shared context. */
  sourceDid: string;
  /** Member DID authorized by the role record. */
  actorDid: string;
  protocol: string;
  contextId: string;
  /** Currently active role from `roles`. */
  protocolRole: string;
  /** Exact role-readable paths replicated from the source context. */
  protocolPaths: [string, ...string[]];
  /** Mutually-exclusive roles, ordered from strongest to weakest. */
  roles: [FollowedSyncRole, ...FollowedSyncRole[]];
};

/** Foreign context details supplied before its active role record is resolved. */
export type FollowedSyncSourceInput = Omit<FollowedSyncSource, 'id' | 'protocolPaths' | 'protocolRole'> & {
  /** Current delegate used only to bootstrap this follow operation. */
  delegateDid?: string;
};

/** One independently decoded entry returned by a {@link FollowedSyncSourceStore}. */
export type FollowedSyncSourceStoreEntry = {
  status: 'valid';
  source: FollowedSyncSource;
} | {
  status: 'corrupt';
  id: string;
  error: unknown;
};

/** Backend-neutral persistence for accepted foreign context sources. */
export interface FollowedSyncSourceStore {
  delete(id: string): Promise<void>;
  get(id: string): Promise<FollowedSyncSource | undefined>;
  list(): Promise<FollowedSyncSourceStoreEntry[]>;
  /** Atomically save one active incarnation and remove the supplied former incarnations. */
  replace(source: FollowedSyncSource, replacedIds?: readonly string[]): Promise<void>;
}

/** Validates source details and canonicalizes each candidate's exact protocol-path set. */
export function normalizeFollowedSyncSourceInput(source: FollowedSyncSourceInput): FollowedSyncSourceInput {
  for (const [field, value] of Object.entries({
    actorDid  : source.actorDid,
    contextId : source.contextId,
    protocol  : source.protocol,
    sourceDid : source.sourceDid,
  })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`FollowedSyncSource: '${field}' must be a non-empty string.`);
    }
  }

  if (source.delegateDid !== undefined && (typeof source.delegateDid !== 'string' || source.delegateDid.length === 0)) {
    throw new TypeError('FollowedSyncSource: \'delegateDid\' must be a non-empty string when supplied.');
  }
  if (!Array.isArray(source.roles) || source.roles.length === 0) {
    throw new TypeError('FollowedSyncSource: \'roles\' must contain at least one role.');
  }

  const roles = source.roles.map(normalizeFollowedSyncRole) as [FollowedSyncRole, ...FollowedSyncRole[]];
  if (new Set(roles.map(role => role.protocolRole)).size !== roles.length) {
    throw new TypeError('FollowedSyncSource: \'roles\' must not contain duplicate roles.');
  }
  const contextRoot = resolveFollowedSyncRoleRoot(source.contextId, roles[0]).protocolPath;
  if (roles.some(role => resolveFollowedSyncRoleRoot(source.contextId, role).protocolPath !== contextRoot)) {
    throw new TypeError('FollowedSyncSource: every role must authorize the same context root.');
  }

  return {
    sourceDid   : source.sourceDid,
    actorDid    : source.actorDid,
    delegateDid : source.delegateDid,
    protocol    : source.protocol,
    contextId   : source.contextId,
    roles,
  };
}

/** Validates a source and canonicalizes its exact protocol-path set. */
export function normalizeFollowedSyncSource(source: FollowedSyncSource): FollowedSyncSource {
  if (typeof source.id !== 'string' || source.id.length === 0) {
    throw new TypeError('FollowedSyncSource: \'id\' must be a non-empty string.');
  }

  const { delegateDid: _delegateDid, ...details } = normalizeFollowedSyncSourceInput({
    actorDid  : source.actorDid,
    contextId : source.contextId,
    protocol  : source.protocol,
    roles     : source.roles,
    sourceDid : source.sourceDid,
  });
  const activeRole = normalizeFollowedSyncRole(source);
  if (!details.roles.some(role => followedSyncRolesEqual(role, activeRole))) {
    throw new TypeError('FollowedSyncSource: the active role must belong to \'roles\'.');
  }
  return { id: source.id, ...details, ...activeRole };
}

/** Exact equality for the active role-record incarnation; recovery policy is intentionally ignored. */
export function followedSyncSourceActiveEqual(a: FollowedSyncSource, b: FollowedSyncSource): boolean {
  return a.id === b.id &&
    a.sourceDid === b.sourceDid &&
    a.actorDid === b.actorDid &&
    a.protocol === b.protocol &&
    a.contextId === b.contextId &&
    followedSyncRolesEqual(a, b);
}

/** Resolve and validate the context root addressed by one role candidate. */
export function resolveFollowedSyncRoleRoot(
  contextId: string,
  role: FollowedSyncRole,
): { protocolPath: string; recordId: string } {
  const roleSegments = role.protocolRole.split('/');
  const contextSegments = contextId.split('/');
  if (
    roleSegments.length < 2 ||
    roleSegments.some(segment => segment.length === 0) ||
    contextSegments.length !== roleSegments.length - 1 ||
    contextSegments.some(segment => segment.length === 0)
  ) {
    throw new TypeError('FollowedSyncSource: followed contexts require a nested role and its exact parent context ID.');
  }

  const protocolPath = roleSegments.slice(0, -1).join('/');
  if (!role.protocolPaths.includes(protocolPath)) {
    throw new TypeError(
      `FollowedSyncSource: role '${role.protocolRole}' does not authorize its context root '${protocolPath}'.`,
    );
  }
  return { protocolPath, recordId: contextSegments.at(-1)! };
}

function normalizeFollowedSyncRole(role: FollowedSyncRole): FollowedSyncRole {
  if (typeof role?.protocolRole !== 'string' || role.protocolRole.length === 0) {
    throw new TypeError('FollowedSyncSource: \'protocolRole\' must be a non-empty string.');
  }
  if (!Array.isArray(role.protocolPaths)) {
    throw new TypeError('FollowedSyncSource: \'protocolPaths\' must contain at least one path.');
  }

  const protocolPaths = [...new Set(role.protocolPaths)].sort();
  if (protocolPaths.length === 0 || protocolPaths.some(path => typeof path !== 'string' || path.length === 0)) {
    throw new TypeError('FollowedSyncSource: \'protocolPaths\' must contain non-empty paths.');
  }
  return { protocolRole: role.protocolRole, protocolPaths: protocolPaths as [string, ...string[]] };
}

function followedSyncRolesEqual(a: FollowedSyncRole, b: FollowedSyncRole): boolean {
  return a.protocolRole === b.protocolRole &&
    a.protocolPaths.length === b.protocolPaths.length &&
    a.protocolPaths.every((path, index) => path === b.protocolPaths[index]);
}
