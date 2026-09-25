import type { AgentPermissionsApi } from '../permissions-api.js';
import type { EnboxPlatformAgent } from '../types/agent.js';
import type { FollowedSyncSourceStore } from '../followed-sync-source.js';
import type { SyncIdentityStore } from '../sync-identity-store.js';
import type { SyncTargetResolver } from '../sync-target-resolver.js';
import type { FollowedSyncSource, FollowedSyncSourceInput } from '../followed-sync-source.js';
import type {
  SyncIdentityOptions,
  SyncLifecycleOptions,
} from '../types/sync.js';
import type {
  SyncScopeClosureGrantQuery,
  SyncScopeClosureGrantResolution,
  SyncScopeProtocolHistoryPage,
  SyncScopeProtocolHistoryQuery,
} from '../sync-scope-closure-validator.js';

import { admitClosure } from '../sync-admit-closure.js';
import { CryptoUtils } from '@enbox/crypto';
import { DwnInterface } from '../types/dwn.js';
import { fetchConnectionStatus } from '../connect-status.js';
import { runWithCrossContextLock } from '@enbox/common';
import { SyncScopeClosureValidator } from '../sync-scope-closure-validator.js';
import {
  DwnInterfaceName,
  DwnMethodName,
  executeUnlessAborted,
  resolveProtocolRoleContextScope,
} from '@enbox/dwn-sdk-js';
import {
  FollowedSourceNotReadyError,
  FollowedSourceRoleAbsentError,
  readRoleReplicationSupport,
  type RoleReplicationSupportBatch,
} from '../sync-role-replication-support.js';
import {
  followedSyncSourceActiveEqual,
  followedSyncSourceAuthorityEqual,
  normalizeFollowedSyncSource,
  normalizeFollowedSyncSourceInput,
  resolveFollowedSyncRoleRoot,
} from '../followed-sync-source.js';
import {
  getMessagesPermissionGrantsForScope,
  permissionGrantIdsFromEntries,
  SyncProtocolRootPermissionGrantMissingError,
} from '../sync-permission-grants.js';
type PreparedFollowedSource = {
  batch: RoleReplicationSupportBatch;
  source: FollowedSyncSource;
};

type SyncNextCatalogFollowResult = {
  changed: boolean;
  source: FollowedSyncSource;
};

/**
 * Owns the small durable catalog that remains independent of transfer state.
 *
 * Transfer state deliberately does not live here. This class only validates
 * and serializes identity registrations and accepted foreign-context sources.
 */
export class SyncNextCatalog {
  private readonly _closureValidator: SyncScopeClosureValidator;

  public constructor(
    private readonly _agent: EnboxPlatformAgent,
    private readonly _permissionsApi: AgentPermissionsApi,
    private readonly _identityStore: SyncIdentityStore,
    private readonly _sourceStore: FollowedSyncSourceStore,
    private readonly _targetResolver: SyncTargetResolver,
    private readonly _lockNamespace: string,
  ) {
    this._closureValidator = new SyncScopeClosureValidator({
      operations: {
        queryProtocolHistory: (query): Promise<SyncScopeProtocolHistoryPage> =>
          this.queryProtocolHistory(query),
        resolvePermissionGrantIds: (query): Promise<SyncScopeClosureGrantResolution> =>
          this.resolvePermissionGrantIds(query),
      },
    });
  }

  public async setIdentityOptions(
    { did, options }: { did: string; options: SyncIdentityOptions },
    lifecycleOptions: SyncLifecycleOptions,
    beforeCommit: () => Promise<void>,
  ): Promise<void> {
    this._closureValidator.validateOptions(options);
    const signal = SyncNextCatalog.timeoutSignal(lifecycleOptions);
    await this.runIdentityLifecycle(did, async (): Promise<void> => {
      await executeUnlessAborted(
        this._closureValidator.validateClosure(did, options),
        signal,
      );
      await executeUnlessAborted(beforeCommit(), signal);
      await this._identityStore.set(did, options);
    }, signal);
  }

  public async refreshIdentityRouting(
    did: string,
    lifecycleOptions: SyncLifecycleOptions,
    beforeRefresh: () => Promise<void>,
  ): Promise<boolean> {
    const signal = SyncNextCatalog.timeoutSignal(lifecycleOptions);
    return this.runIdentityLifecycle(did, async (): Promise<boolean> => {
      if (await this._identityStore.get(did) === undefined) {
        return false;
      }
      await executeUnlessAborted(beforeRefresh(), signal);
      return true;
    }, signal);
  }

  public async removeIdentity(
    did: string,
    lifecycleOptions: SyncLifecycleOptions,
    beforeCommit: () => Promise<void>,
  ): Promise<boolean> {
    const signal = SyncNextCatalog.timeoutSignal(lifecycleOptions);
    return this.runIdentityLifecycle(did, async (): Promise<boolean> => {
      if (await this._identityStore.get(did) === undefined) {
        return false;
      }
      await executeUnlessAborted(beforeCommit(), signal);
      await this._identityStore.delete(did);
      return true;
    }, signal);
  }

  public async removeIdentityIfApprovalInactive(
    params: { did: string; delegateDid: string; connectSessionId: string },
    beforeRemove: () => Promise<void>,
  ): Promise<boolean> {
    return this.runIdentityLifecycle(params.did, async (): Promise<boolean> => {
      const status = await fetchConnectionStatus({
        connectedDid : params.did,
        delegateDid  : params.delegateDid,
        permissions  : this._permissionsApi,
      });
      if (
        status.connectSessionId !== params.connectSessionId ||
        (status.state !== 'expired' && status.state !== 'revoked')
      ) {
        return false;
      }
      await beforeRemove();
      await this._identityStore.delete(params.did);
      return true;
    });
  }

  public async followSource(
    input: FollowedSyncSourceInput,
    beforeCommit: (source: FollowedSyncSource) => Promise<void>,
  ): Promise<SyncNextCatalogFollowResult> {
    const normalized = normalizeFollowedSyncSourceInput(input);
    const identity = await this._identityStore.get(normalized.actorDid);
    if (identity === undefined) {
      throw new FollowedSourceNotReadyError(`actor '${normalized.actorDid}' is not registered for sync`);
    }
    const prepared = await this.resolveFollowedSource(normalized, identity.delegateDid);

    return this.runIdentityLifecycle(normalized.sourceDid, async (): Promise<SyncNextCatalogFollowResult> => {
      const currentIdentity = await this._identityStore.get(normalized.actorDid);
      if (currentIdentity === undefined || currentIdentity.delegateDid !== identity.delegateDid) {
        throw new FollowedSourceNotReadyError('the member sync registration changed while accepting the context');
      }

      const sources = await this.listFollowedSources();
      const current = sources.filter(candidate => SyncNextCatalog.sameFollowedContext(candidate, normalized));
      const sameAuthority = current.find(candidate =>
        followedSyncSourceAuthorityEqual(candidate, prepared.source)
      );
      const accepted = sameAuthority === undefined
        ? prepared.source
        : { ...prepared.source, acceptanceId: sameAuthority.acceptanceId };
      const existing = sources.find(candidate => candidate.id === accepted.id);
      if (existing !== undefined && !SyncNextCatalog.sameFollowedContext(existing, accepted)) {
        throw new Error(
          `SyncNextCatalog: followed source ${accepted.id} is already registered with different details.`,
        );
      }

      await this.admitFollowedSource({ ...prepared, source: accepted });
      const replaced = current.filter(candidate =>
        candidate.id !== accepted.id || !followedSyncSourceActiveEqual(candidate, accepted)
      );
      const changed = existing === undefined ||
        !followedSyncSourceActiveEqual(existing, accepted) ||
        replaced.length > 0;
      if (changed) {
        await beforeCommit(accepted);
        await this._sourceStore.replace(accepted, replaced.map(source => source.id));
      }
      return { changed, source: accepted };
    });
  }

  public async deleteFollowedSource(
    source: FollowedSyncSource,
    beforeCommit: (current: FollowedSyncSource) => Promise<void>,
  ): Promise<FollowedSyncSource | undefined> {
    const normalized = normalizeFollowedSyncSource(source);
    return this.runIdentityLifecycle(normalized.sourceDid, async (): Promise<FollowedSyncSource | undefined> => {
      const current = await this._sourceStore.get(normalized.id);
      if (current === undefined || !followedSyncSourceActiveEqual(current, normalized)) {
        return undefined;
      }
      await beforeCommit(current);
      await this._sourceStore.delete(current.id);
      return current;
    });
  }

  public async listFollowedSources(): Promise<FollowedSyncSource[]> {
    return (await this._sourceStore.list()).flatMap(entry => entry.status === 'valid' ? [entry.source] : []);
  }

  private async resolveFollowedSource(
    input: FollowedSyncSourceInput,
    delegateDid: string | undefined,
  ): Promise<PreparedFollowedSource> {
    const endpoints = await this._targetResolver.getRemoteEndpointUrls(input.sourceDid);
    if (endpoints.length === 0) {
      throw new FollowedSourceNotReadyError(`source '${input.sourceDid}' has no remote DWN endpoint`);
    }

    let unresolved: unknown;
    for (const remoteEndpoint of endpoints) {
      try {
        const prepared = await this.resolveFollowedSourceAtEndpoint(input, delegateDid, remoteEndpoint);
        if (prepared !== undefined) {
          return prepared;
        }
      } catch (error: unknown) {
        unresolved ??= error;
      }
    }
    if (unresolved !== undefined) {
      throw unresolved;
    }
    throw new FollowedSourceRoleAbsentError('none of the requested roles is available');
  }

  private async resolveFollowedSourceAtEndpoint(
    input: FollowedSyncSourceInput,
    delegateDid: string | undefined,
    remoteEndpoint: string,
  ): Promise<PreparedFollowedSource | undefined> {
    for (const role of input.roles) {
      const { protocolPath } = resolveFollowedSyncRoleRoot(input.contextId, role);
      try {
        const batch = await readRoleReplicationSupport({
          ...input,
          agent          : this._agent,
          delegateDid,
          dwnUrl         : remoteEndpoint,
          permissionsApi : this._permissionsApi,
          protocolPath,
          protocolRole   : role,
        });
        const protocolPaths = resolveProtocolRoleContextScope(
          batch.protocolDefinition,
          role,
        ).readablePaths;
        return {
          batch,
          source: normalizeFollowedSyncSource({
            acceptanceId : CryptoUtils.randomUuid(),
            actorDid     : input.actorDid,
            contextId    : input.contextId,
            id           : batch.roleRecordId,
            protocol     : input.protocol,
            protocolPaths,
            protocolRole : role,
            remoteEndpoint,
            roles        : input.roles,
            sourceDid    : input.sourceDid,
          }),
        };
      } catch (error: unknown) {
        if (error instanceof FollowedSourceRoleAbsentError) {
          continue;
        }
        throw error;
      }
    }
  }

  private async admitFollowedSource(prepared: PreparedFollowedSource): Promise<void> {
    const { batch, source } = prepared;
    const outcome = await admitClosure(batch.rootCid, {
      agent                   : this._agent,
      did                     : source.sourceDid,
      dwnUrl                  : source.remoteEndpoint,
      fetchReplicationSupport : async () => batch,
      prefetched              : [...batch.dependencies, batch.root],
      scope                   : {
        kind          : 'context',
        contextId     : source.contextId,
        protocol      : source.protocol,
        protocolPaths : source.protocolPaths,
      },
    });
    if (outcome.kind !== 'admitted') {
      throw new Error(
        outcome.detail ?? (outcome.kind === 'failed' ? outcome.reason : 'incomplete followed-context bootstrap'),
      );
    }
  }

  private async resolvePermissionGrantIds(
    query: SyncScopeClosureGrantQuery,
  ): Promise<SyncScopeClosureGrantResolution> {
    try {
      const grants = await getMessagesPermissionGrantsForScope({
        did            : query.did,
        delegateDid    : query.delegateDid,
        protocols      : [query.protocol],
        messageType    : DwnInterface.MessagesQuery,
        permissionsApi : this._permissionsApi,
      });
      return {
        kind               : 'granted',
        permissionGrantIds : permissionGrantIdsFromEntries(grants),
      };
    } catch (error: unknown) {
      if (error instanceof SyncProtocolRootPermissionGrantMissingError) {
        return { kind: 'missing' };
      }
      throw error;
    }
  }

  private async queryProtocolHistory(
    query: SyncScopeProtocolHistoryQuery,
  ): Promise<SyncScopeProtocolHistoryPage> {
    const { reply } = await this._agent.dwn.processRequest({
      author        : query.did,
      target        : query.did,
      messageType   : DwnInterface.MessagesQuery,
      granteeDid    : query.delegateDid,
      messageParams : {
        cursor  : query.cursor,
        filters : [{
          interface : DwnInterfaceName.Protocols,
          method    : DwnMethodName.Configure,
          protocol  : query.protocol,
        }],
        limit              : query.limit,
        permissionGrantIds : query.permissionGrantIds,
      },
    });
    return reply;
  }

  private runIdentityLifecycle<T>(
    did: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const lockName = `enbox:sync-identity:${this._lockNamespace}:${did}`;
    const locked = runWithCrossContextLock(lockName, async (): Promise<T> => {
      if (signal?.aborted === true) {
        throw signal.reason;
      }
      return operation();
    });
    return executeUnlessAborted(locked, signal);
  }

  private static timeoutSignal(options: SyncLifecycleOptions): AbortSignal | undefined {
    return options.timeout === undefined ? undefined : AbortSignal.timeout(options.timeout);
  }

  private static sameFollowedContext(
    left: Pick<FollowedSyncSource, 'actorDid' | 'contextId' | 'protocol' | 'sourceDid'>,
    right: Pick<FollowedSyncSource, 'actorDid' | 'contextId' | 'protocol' | 'sourceDid'>,
  ): boolean {
    return left.sourceDid === right.sourceDid &&
      left.actorDid === right.actorDid &&
      left.protocol === right.protocol &&
      left.contextId === right.contextId;
  }
}
