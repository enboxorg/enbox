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
  protocolRole: string;
  /** Exact role-readable paths replicated from the source context. */
  protocolPaths: [string, ...string[]];
};

/** Foreign context details supplied before its active role record is resolved. */
export type FollowedSyncSourceInput = Omit<FollowedSyncSource, 'id'> & {
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
  set(source: FollowedSyncSource): Promise<void>;
}

/** Validates source details and canonicalizes their exact protocol-path set. */
export function normalizeFollowedSyncSourceInput(source: FollowedSyncSourceInput): FollowedSyncSourceInput {
  for (const [field, value] of Object.entries({
    actorDid     : source.actorDid,
    contextId    : source.contextId,
    protocol     : source.protocol,
    protocolRole : source.protocolRole,
    sourceDid    : source.sourceDid,
  })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`FollowedSyncSource: '${field}' must be a non-empty string.`);
    }
  }

  if (source.delegateDid !== undefined && (typeof source.delegateDid !== 'string' || source.delegateDid.length === 0)) {
    throw new TypeError('FollowedSyncSource: \'delegateDid\' must be a non-empty string when supplied.');
  }
  if (!Array.isArray(source.protocolPaths)) {
    throw new TypeError('FollowedSyncSource: \'protocolPaths\' must contain at least one path.');
  }

  const protocolPaths = [...new Set(source.protocolPaths)].sort();
  if (protocolPaths.length === 0 || protocolPaths.some(path => typeof path !== 'string' || path.length === 0)) {
    throw new TypeError('FollowedSyncSource: \'protocolPaths\' must contain non-empty paths.');
  }

  return {
    sourceDid     : source.sourceDid,
    actorDid      : source.actorDid,
    delegateDid   : source.delegateDid,
    protocol      : source.protocol,
    contextId     : source.contextId,
    protocolRole  : source.protocolRole,
    protocolPaths : protocolPaths as [string, ...string[]],
  };
}

/** Validates a source and canonicalizes its exact protocol-path set. */
export function normalizeFollowedSyncSource(source: FollowedSyncSource): FollowedSyncSource {
  if (typeof source.id !== 'string' || source.id.length === 0) {
    throw new TypeError('FollowedSyncSource: \'id\' must be a non-empty string.');
  }

  const { delegateDid: _delegateDid, ...details } = normalizeFollowedSyncSourceInput(source);
  return { id: source.id, ...details };
}

/** Exact equality for lifecycle fencing of one followed-source incarnation. */
export function followedSyncSourcesEqual(a: FollowedSyncSource, b: FollowedSyncSource): boolean {
  return a.id === b.id &&
    a.sourceDid === b.sourceDid &&
    a.actorDid === b.actorDid &&
    a.protocol === b.protocol &&
    a.contextId === b.contextId &&
    a.protocolRole === b.protocolRole &&
    a.protocolPaths.length === b.protocolPaths.length &&
    a.protocolPaths.every((path, index) => path === b.protocolPaths[index]);
}
