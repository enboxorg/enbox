import { lexicographicalCompare } from './types/sync.js';

/** Durable description of one foreign context accepted through a role record. */
export type FollowedSyncSource = {
  /** Opaque local acceptance ID. A re-follow never revives handles from a former acceptance. */
  acceptanceId: string;
  /** The accepted role record ID used for role authorization and replication links. */
  id: string;
  /** DID whose hosted DWN owns the shared context. */
  sourceDid: string;
  /** Exact hosted DWN accepted as the authority for this context. */
  remoteEndpoint: string;
  /** Member DID authorized by the role record. */
  actorDid: string;
  protocol: string;
  contextId: string;
  /** Role proven active when this context was accepted. */
  protocolRole: string;
  /** Exact role-readable paths derived from the accepted hosted protocol definition. */
  protocolPaths: [string, ...string[]];
  /** Mutually-exclusive role paths, ordered from strongest to weakest. */
  roles: [string, ...string[]];
};

/** Foreign context details supplied before its active role record is resolved. */
export type FollowedSyncSourceInput = Pick<
  FollowedSyncSource,
  'actorDid' | 'contextId' | 'protocol' | 'sourceDid'
> & {
  /** Mutually-exclusive role paths tried strongest-first during this explicit follow. */
  roles: [string, ...string[]];
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
  /** Atomically save one active followed source and remove the supplied former sources. */
  replace(source: FollowedSyncSource, replacedIds?: readonly string[]): Promise<void>;
}

/** Validate the context coordinates and ordered roles used by an explicit follow. */
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

  if (!Array.isArray(source.roles) || source.roles.length === 0) {
    throw new TypeError('FollowedSyncSource: \'roles\' must contain at least one role.');
  }

  const roles = source.roles.map(normalizeFollowedSyncRole) as [string, ...string[]];
  if (new Set(roles).size !== roles.length) {
    throw new TypeError('FollowedSyncSource: \'roles\' must not contain duplicate roles.');
  }
  const contextRoot = resolveFollowedSyncRoleRoot(source.contextId, roles[0]).protocolPath;
  if (roles.some(role => resolveFollowedSyncRoleRoot(source.contextId, role).protocolPath !== contextRoot)) {
    throw new TypeError('FollowedSyncSource: every role must authorize the same context root.');
  }

  return {
    actorDid  : source.actorDid,
    contextId : source.contextId,
    protocol  : source.protocol,
    roles,
    sourceDid : source.sourceDid,
  };
}

/** Validates a source and canonicalizes its exact protocol-path set. */
export function normalizeFollowedSyncSource(source: FollowedSyncSource): FollowedSyncSource {
  if (typeof source.acceptanceId !== 'string' || source.acceptanceId.length === 0) {
    throw new TypeError('FollowedSyncSource: \'acceptanceId\' must be a non-empty string.');
  }
  if (typeof source.id !== 'string' || source.id.length === 0) {
    throw new TypeError('FollowedSyncSource: \'id\' must be a non-empty string.');
  }

  const details = normalizeFollowedSyncSourceInput({
    actorDid  : source.actorDid,
    contextId : source.contextId,
    protocol  : source.protocol,
    roles     : source.roles,
    sourceDid : source.sourceDid,
  });
  const protocolRole = normalizeFollowedSyncRole(source.protocolRole);
  if (!details.roles.includes(protocolRole)) {
    throw new TypeError('FollowedSyncSource: the active role must belong to \'roles\'.');
  }
  if (typeof source.remoteEndpoint !== 'string' || source.remoteEndpoint.length === 0) {
    throw new TypeError('FollowedSyncSource: \'remoteEndpoint\' must be a non-empty string.');
  }
  const protocolPaths = normalizeProtocolPaths(source.protocolPaths);
  const { protocolPath } = resolveFollowedSyncRoleRoot(source.contextId, protocolRole);
  if (!protocolPaths.includes(protocolPath)) {
    throw new TypeError(
      `FollowedSyncSource: role '${protocolRole}' does not authorize its context root '${protocolPath}'.`,
    );
  }
  return {
    acceptanceId   : source.acceptanceId,
    id             : source.id,
    ...details,
    protocolPaths,
    protocolRole,
    remoteEndpoint : source.remoteEndpoint,
  };
}

/** Equality for the exact remote authority represented by one accepted source. */
export function followedSyncSourceAuthorityEqual(a: FollowedSyncSource, b: FollowedSyncSource): boolean {
  return a.id === b.id &&
    a.sourceDid === b.sourceDid &&
    a.remoteEndpoint === b.remoteEndpoint &&
    a.actorDid === b.actorDid &&
    a.protocol === b.protocol &&
    a.contextId === b.contextId &&
    a.protocolRole === b.protocolRole &&
    sameStrings(a.protocolPaths, b.protocolPaths) &&
    sameStrings(a.roles, b.roles);
}

/** Equality for one acceptance and its exact remote authority. */
export function followedSyncSourceActiveEqual(a: FollowedSyncSource, b: FollowedSyncSource): boolean {
  return a.acceptanceId === b.acceptanceId && followedSyncSourceAuthorityEqual(a, b);
}

/** Resolve and validate the context root addressed by one role candidate. */
export function resolveFollowedSyncRoleRoot(
  contextId: string,
  role: string,
): { protocolPath: string } {
  const roleSegments = role.split('/');
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
  return { protocolPath };
}

function normalizeFollowedSyncRole(role: string): string {
  if (typeof role !== 'string' || role.length === 0) {
    throw new TypeError('FollowedSyncSource: \'protocolRole\' must be a non-empty string.');
  }
  return role;
}

function normalizeProtocolPaths(protocolPaths: readonly string[]): [string, ...string[]] {
  if (!Array.isArray(protocolPaths)) {
    throw new TypeError('FollowedSyncSource: \'protocolPaths\' must contain at least one path.');
  }

  const normalized = [...new Set(protocolPaths)].sort(lexicographicalCompare);
  if (normalized.length === 0 || normalized.some(path => typeof path !== 'string' || path.length === 0)) {
    throw new TypeError('FollowedSyncSource: \'protocolPaths\' must contain non-empty paths.');
  }
  return normalized as [string, ...string[]];
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
